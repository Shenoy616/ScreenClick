// Content script. Handles:
//   - mouse tracking (keyboard trigger ring position)
//   - single-click trigger (visible-tab mode)
//   - single-click trigger and form-input trigger (process-record mode)
//   - green click pointer rendering with element label
//   - on-page recording dot (blinks while capturing)
//   - full-page scroll orchestration for fullpage mode

(function () {
  if (window.__qaScreenshotToolLoaded) return;
  window.__qaScreenshotToolLoaded = true;

  const STATE = {
    isRecording: false,
    exportPending: false,
    captureTarget: 'visible',
    triggers: { click: true, keyboard: false, timer: false },
    lastVisibleClickAt: 0,
    processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
    screenTriggers: { keyboard: true, timer: false },
    processOptions: { onlyInteractive: true, debounceMs: 250 },
    lastMouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    indicator: null,
    fp: null,
    // Process-mode internals
    lastClickAt: 0,
    inputSessions: {}, // keyed by element's __qaFieldId
    stepCounter: 0,
  };

  document.addEventListener('mousemove', (e) => {
    STATE.lastMouse.x = e.clientX;
    STATE.lastMouse.y = e.clientY;
  }, { passive: true, capture: true });

  function applyRecordingPayload(data) {
    const wasRecording = STATE.isRecording;
    STATE.isRecording = !!data.isRecording;
    STATE.exportPending = !!data.exportPending;
    STATE.captureTarget = data.captureTarget || 'visible';
    const s = data.settings || {};
    const raw = s.triggers || {};
    STATE.triggers = {
      click: raw.click ?? raw.doubleClick ?? true,
      keyboard: raw.keyboard !== false,
      timer: !!raw.timer,
    };
    STATE.processTriggers = {
      click: s.processTriggers?.click !== false,
      inputChange: s.processTriggers?.inputChange !== false,
      keyboard: s.processTriggers?.keyboard !== false,
      timer: !!s.processTriggers?.timer,
    };
    STATE.processOptions = {
      onlyInteractive: s.processOptions?.onlyInteractive !== false,
      debounceMs: s.processOptions?.debounceMs || 250,
    };
    STATE.screenTriggers = {
      keyboard: s.screenTriggers?.keyboard !== false,
      timer: !!s.screenTriggers?.timer,
    };
    if (STATE.isRecording && !wasRecording) {
      STATE.stepCounter = 0;
      STATE.inputSessions = {};
      showIndicator();
    }
    if (!STATE.isRecording && wasRecording) {
      for (const k in STATE.inputSessions) {
        const sess = STATE.inputSessions[k];
        if (sess && sess.idleTimer) clearTimeout(sess.idleTimer);
      }
      STATE.inputSessions = {};
      hideIndicator();
    }
  }

  async function refreshState() {
    try {
      const data = await chrome.storage.local.get(['isRecording', 'settings', 'captureTarget', 'exportPending']);
      applyRecordingPayload(data);
    } catch {}
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.isRecording || changes.settings || changes.captureTarget || changes.exportPending)) {
        refreshState();
      }
    });
  } catch {}

  refreshState();

  function showIndicator() {
    if (STATE.indicator || !STATE.isRecording) return;
    const el = document.createElement('div');
    el.className = STATE.captureTarget === 'process'
      ? 'qa-recording-indicator qa-process-recording'
      : 'qa-recording-indicator';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', STATE.captureTarget === 'process' ? 'Process recording' : 'Recording');
    (document.body || document.documentElement).appendChild(el);
    STATE.indicator = el;
  }

  function hideIndicator() {
    if (STATE.indicator) {
      STATE.indicator.remove();
      STATE.indicator = null;
    }
  }

  function drawRing(x, y) {
    return new Promise((resolve) => {
      const marker = document.createElement('div');
      marker.className = 'qa-click-marker';
      marker.style.left = x + 'px';
      marker.style.top = y + 'px';

      const circle = document.createElement('span');
      circle.className = 'qa-click-ring-circle';

      const cursor = document.createElement('span');
      cursor.className = 'qa-click-ring-cursor';

      marker.appendChild(circle);
      marker.appendChild(cursor);
      (document.body || document.documentElement).appendChild(marker);
      marker.offsetHeight;
      setTimeout(() => resolve(), 180);
      setTimeout(() => marker.remove(), 1300);
    });
  }

  async function sendMessageWithRetry(msg, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try { return await chrome.runtime.sendMessage(msg); }
      catch (e) {
        if (i === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async function triggerCapture(x, y, source, extra = {}) {
    if (!STATE.isRecording || STATE.exportPending) return;
    const skipRing = source === 'timer' || source === 'process-timer';
    if ((STATE.captureTarget === 'visible' || STATE.captureTarget === 'process') && !skipRing) {
      await drawRing(x, y);
    }
    try {
      await sendMessageWithRetry({
        type: 'CAPTURE_NOW',
        source,
        x,
        y,
        pageUrl: window.location.href,
        ...extra,
      });
    } catch (e) {
      console.warn('[QA Tool] Capture message failed:', e?.message || e);
    }
  }

  // ---------- Visible-tab single-click ----------

  document.addEventListener('click', (e) => {
    if (!STATE.isRecording || STATE.exportPending || STATE.captureTarget !== 'visible') return;
    if (!STATE.triggers.click) return;
    if (e.target?.closest?.('.qa-click-marker, .qa-recording-indicator')) return;
    const now = Date.now();
    const gap = STATE.processOptions.debounceMs || 250;
    if (now - STATE.lastVisibleClickAt < gap) return;
    STATE.lastVisibleClickAt = now;
    triggerCapture(e.clientX, e.clientY, 'click');
  }, true);

  // ---------- Process Record: click trigger ----------
  //
  // We listen in the capture phase to fire before page handlers, but we do
  // NOT preventDefault, so the user's actual click still happens (links
  // navigate, buttons submit, etc.). Debounce prevents capturing the same
  // click twice from a fast double-tap or from synthetic clicks.

  // True only for the element that owns the action (not a child sitting inside a link/button).
  function isIntrinsicInteractive(el) {
    if (!el || el.nodeType !== 1 || el.disabled) return false;
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL' || tag === 'SUMMARY') return true;
    const role = el.getAttribute('role');
    if (role && /^(button|link|checkbox|radio|tab|menuitem|switch|option|listitem|gridcell|treeitem|cell)$/i.test(role.trim().split(/\s+/)[0])) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabidx = el.getAttribute('tabindex');
    if (tabidx && parseInt(tabidx, 10) >= 0) return true;
    return false;
  }

  function findLinkElement(el) {
    if (!el || el.nodeType !== 1) return null;
    const anchor = el.closest('a[href]');
    if (anchor) return anchor;
    const roleLink = el.closest('[role="link"][href], [role="link"]');
    return roleLink || null;
  }

  // Prefer the control that carries the human-readable Point (link, button, field).
  function labelTargetFor(el) {
    if (!el || el.nodeType !== 1) return el;
    return (
      findLinkElement(el) ||
      el.closest('button, [role="button"], input, select, textarea, summary') ||
      el
    );
  }

  function resolveProcessClickTarget(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];

    for (const node of path) {
      if (node && node.nodeType === 1 && isIntrinsicInteractive(node)) {
        return { element: node, identified: true };
      }
    }

    let el = e.target;
    while (el && el.nodeType === 1) {
      if (isIntrinsicInteractive(el)) return { element: el, identified: true };
      el = el.parentElement;
    }

    const link = findLinkElement(e.target);
    if (link) return { element: link, identified: true };

    return { element: e.target || null, identified: false };
  }

  function elementAtClientPoint(x, y) {
    try {
      const el = document.elementFromPoint(x, y);
      if (!el || el.nodeType !== 1) return null;
      if (el.closest?.('.qa-click-marker, .qa-recording-indicator')) return null;
      return el;
    } catch {
      return null;
    }
  }

  // Resolve button/link Point labels at a screen position (click, keyboard, manual, timer).
  function buildProcessPointPayload(x, y, { withActionLabel = true } = {}) {
    const start = elementAtClientPoint(x, y);
    if (!start) return {};

    const { element: clickTarget, identified } = resolveProcessClickTarget({
      target: start,
      composedPath: () => [start],
    });

    let info;
    if (identified && clickTarget) {
      info = describeElement(labelTargetFor(clickTarget));
    } else {
      const link = findLinkElement(start);
      info = describeElement(link || start);
    }

    const payload = { elementInfo: info };
    if (withActionLabel && hasMeaningfulPoint(info)) {
      payload.actionLabel = `Clicked ${info.label}`;
    }
    return payload;
  }

  function hasMeaningfulPoint(info) {
    if (!info) return false;
    if ((info.text || '').trim()) return true;
    return info.kind && info.kind !== 'element';
  }

  document.addEventListener('click', (e) => {
    if (!STATE.isRecording || STATE.exportPending) return;
    if (STATE.captureTarget !== 'process') return;
    if (!STATE.processTriggers.click) return;

    const now = Date.now();
    if (now - STATE.lastClickAt < STATE.processOptions.debounceMs) return;
    STATE.lastClickAt = now;

    if (e.target?.closest?.('.qa-click-marker, .qa-recording-indicator')) return;

    const { element: clickTarget, identified } = resolveProcessClickTarget(e);

    if (identified && clickTarget) {
      if (STATE.processTriggers.inputChange && isTextInput(clickTarget)) return;
    }

    triggerCapture(e.clientX, e.clientY, 'process-click', buildProcessPointPayload(e.clientX, e.clientY));
  }, true);

  // ---------- Process Record: input fill ----------
  //
  // Captures filled-in form values as labeled steps. Fires on the first of:
  //   - blur (user leaves the field)
  //   - typing pause (no input for INPUT_IDLE_MS)
  //   - Enter key inside the field
  // De-dupes so re-focusing the same field without further changes does
  // not produce a duplicate step.

  const INPUT_IDLE_MS = 1200;

  function fieldKey(el) {
    // Stable-enough identity for the active session. We use a property on
    // the element itself to avoid hashing.
    if (!el.__qaFieldId) el.__qaFieldId = '_qa_' + Math.random().toString(36).slice(2, 10);
    return el.__qaFieldId;
  }

  function captureInputFill(el, reason) {
    if (!el || STATE.exportPending) return;
    const key = fieldKey(el);
    const session = STATE.inputSessions[key];
    if (!session) return;
    const finalValue = el.value || '';
    if (finalValue === session.initial) return;     // no real change
    if (finalValue === session.lastCaptured) return; // already captured this exact value

    session.lastCaptured = finalValue;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    const info = describeElement(el);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    // Mask sensitive fields. For type=password we still capture the action
    // but redact the value. Don't include the actual characters.
    const isPassword = el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'password';
    const preview = isPassword
      ? '\u2022'.repeat(Math.min(8, finalValue.length))
      : (finalValue.length > 60 ? finalValue.slice(0, 60) + '...' : finalValue);

    const fieldName = info.text || info.label.replace(/^(input|text area|dropdown|button):\s*/, '') || 'field';

    triggerCapture(cx, cy, 'process-input', {
      actionLabel: `Filled "${fieldName}" with: ${preview}`,
      elementInfo: info,
    });
  }

  document.addEventListener('focusin', (e) => {
    if (!STATE.isRecording || STATE.captureTarget !== 'process') return;
    if (!STATE.processTriggers.inputChange) return;
    const el = e.target;
    if (!isTextInput(el)) return;
    const key = fieldKey(el);
    // Preserve last-captured if user comes back to the same field.
    const prior = STATE.inputSessions[key];
    STATE.inputSessions[key] = {
      el,
      initial: el.value || '',
      lastCaptured: prior ? prior.lastCaptured : null,
      idleTimer: null,
    };
  }, true);

  document.addEventListener('input', (e) => {
    if (!STATE.isRecording || STATE.captureTarget !== 'process') return;
    if (!STATE.processTriggers.inputChange) return;
    const el = e.target;
    if (!isTextInput(el)) return;
    const key = fieldKey(el);
    let session = STATE.inputSessions[key];
    // If user types without focusin firing (rare; programmatic), bootstrap.
    if (!session) {
      session = STATE.inputSessions[key] = { el, initial: '', lastCaptured: null, idleTimer: null };
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      captureInputFill(el, 'idle');
    }, INPUT_IDLE_MS);
  }, true);

  document.addEventListener('focusout', (e) => {
    if (!STATE.isRecording || STATE.captureTarget !== 'process') return;
    if (!STATE.processTriggers.inputChange) return;
    const el = e.target;
    if (!isTextInput(el)) return;
    captureInputFill(el, 'blur');
  }, true);

  // Page-level shortcut listeners — chrome.commands can miss keystrokes when a tab has focus.
  document.addEventListener('keydown', (e) => {
    if (window !== window.top) return;
    const sc = globalThis.ScreenClickShortcuts;
    if (!sc) return;
    if (sc.isEditableTarget(e.target)) return;

    if (sc.isToggleShortcutKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      sc.requestToggleRecording();
      return;
    }

    if (!STATE.isRecording || STATE.exportPending) return;

    if (!sc.isCaptureShortcutKey(e)) return;

    if (STATE.captureTarget === 'screen') {
      if (!STATE.screenTriggers.keyboard) return;
      e.preventDefault();
      e.stopPropagation();
      sc.requestKeyboardCapture();
      return;
    }

    if (STATE.captureTarget === 'visible') {
      if (!STATE.triggers.keyboard) return;
      e.preventDefault();
      e.stopPropagation();
      sc.requestKeyboardCapture();
      return;
    }

    if (STATE.captureTarget === 'process') {
      if (!STATE.processTriggers.keyboard) return;
      e.preventDefault();
      e.stopPropagation();
      sc.requestKeyboardCapture();
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!STATE.isRecording || STATE.exportPending || STATE.captureTarget !== 'process') return;
    if (!STATE.processTriggers.inputChange) return;
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!isTextInput(el)) return;
    captureInputFill(el, 'enter');
  }, true);

  // ---------- Element identification ----------

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isIntrinsicInteractive(el)) return true;
    if (el.parentElement) return isInteractive(el.parentElement);
    return false;
  }

  function linkAccessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    const labelledBy = findAssociatedLabel(el);
    if (labelledBy) return labelledBy;
    const img = el.querySelector('img[alt]');
    if (img) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt) return alt;
    }
    const labelledChild = el.querySelector('[aria-label]');
    if (labelledChild) {
      const childAria = (labelledChild.getAttribute('aria-label') || '').trim();
      if (childAria) return childAria;
    }
    return '';
  }

  function hrefLabel(el) {
    const raw = (el.getAttribute('href') || '').trim();
    if (!raw || raw === '#') return '';
    try {
      const url = new URL(raw, window.location.href);
      const path = (url.pathname || '/').replace(/\/$/, '') || '/';
      const tail = path === '/' ? url.hostname : path.split('/').filter(Boolean).pop() || path;
      return decodeURIComponent(tail).replace(/[-_]/g, ' ') || url.hostname;
    } catch {
      return raw.length > 60 ? raw.slice(0, 60) + '...' : raw;
    }
  }

  function isTextInput(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'search', 'tel', 'url', 'password', 'number'].includes(t);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  // ARIA roles that mean "no semantics, decorative only". Never use these
  // as the element's kind label.
  const NULL_ROLES = new Set(['presentation', 'none']);

  // ARIA roles that map to a friendlier kind label.
  const ROLE_KIND_MAP = {
    button: 'button',
    link: 'link',
    checkbox: 'checkbox',
    radio: 'radio',
    switch: 'switch',
    tab: 'tab',
    menuitem: 'menu item',
    menuitemcheckbox: 'menu item',
    menuitemradio: 'menu item',
    option: 'option',
    combobox: 'dropdown',
    listbox: 'dropdown',
    searchbox: 'search box',
    textbox: 'input',
    treeitem: 'tree item',
  };

  function effectiveRole(el) {
    const r = el.getAttribute('role');
    if (!r) return null;
    const role = r.trim().toLowerCase().split(/\s+/)[0]; // ARIA allows space-separated list; take first
    if (NULL_ROLES.has(role)) return null;
    return role;
  }

  // Walk up looking for a label association: a wrapping <label>, or any
  // ancestor with aria-labelledby pointing at a node we can read.
  function findAssociatedLabel(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      // <label> wrapping us
      if (cur.tagName === 'LABEL') {
        const txt = (cur.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt) return txt;
      }
      // aria-labelledby on us or an ancestor
      const lbId = cur.getAttribute && cur.getAttribute('aria-labelledby');
      if (lbId) {
        const parts = lbId.split(/\s+/).map(id => {
          const ref = document.getElementById(id);
          return ref ? (ref.textContent || '').trim() : '';
        }).filter(Boolean);
        if (parts.length) return parts.join(' ').replace(/\s+/g, ' ');
      }
      cur = cur.parentElement;
    }
    // <label for="id"> elsewhere in the doc pointing at this element
    if (el.id) {
      const safeId = (typeof CSS !== 'undefined' && CSS.escape)
        ? CSS.escape(el.id)
        : el.id.replace(/([!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, '\\$1');
      const labelFor = document.querySelector(`label[for="${safeId}"]`);
      if (labelFor) {
        const txt = (labelFor.textContent || '').trim().replace(/\s+/g, ' ');
        if (txt) return txt;
      }
    }
    return '';
  }

  // Some UIs render the real <input type="checkbox"> as visually hidden and
  // put a clickable <div> next to it. When the click lands on the decorative
  // div, look for an associated real input via its label or its parent.
  function findHiddenCheckboxNear(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      // A wrapping <label> often contains the real input
      if (cur.tagName === 'LABEL') {
        const inp = cur.querySelector('input[type="checkbox"], input[type="radio"]');
        if (inp) return inp;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return { label: 'element', kind: 'element', text: '', tag: '' };

    // Original element kept for fallback. We try a series of strategies to
    // find a meaningful target.
    let target = el;

    if (STATE.processOptions.onlyInteractive) {
      // Strategy 1: bubble up through ancestors looking for an interactive
      // element with a *meaningful* role/tag (skip presentation/none).
      let cur = el;
      while (cur && cur !== document.body) {
        if (isInteractive(cur)) {
          const role = effectiveRole(cur);
          // Accept the element only if its role is meaningful, or if its
          // tag is intrinsically interactive (a, button, input, ...).
          const intrinsicTag = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'].includes(cur.tagName);
          if (role || intrinsicTag) {
            if (cur.tagName !== el.tagName || cur !== el) { target = cur; break; }
          }
        }
        cur = cur.parentElement;
      }

      // Strategy 2: if we landed on a <label>, prefer the input it wraps —
      // testers care about the control, not the wrapper.
      if (target.tagName === 'LABEL') {
        const inner = target.querySelector('input[type="checkbox"], input[type="radio"], input, select, textarea, button');
        if (inner) target = inner;
      }

      // Strategy 3: if we still didn't find anything better and the click
      // landed on a non-interactive element, look for an associated hidden
      // checkbox/radio (common pattern in styled forms).
      if (target === el && !isInteractive(el)) {
        const hidden = findHiddenCheckboxNear(el);
        if (hidden) target = hidden;
      }
    }

    const tag = target.tagName.toLowerCase();
    const role = effectiveRole(target);
    const aria = (target.getAttribute('aria-label') || '').trim();
    const title = (target.getAttribute('title') || '').trim();
    const placeholder = (target.getAttribute('placeholder') || '').trim();
    const name = (target.getAttribute('name') || '').trim();
    let text = (target.innerText || target.textContent || '').trim().replace(/\s+/g, ' ');
    const value = target.value || '';

    if ((tag === 'a' || role === 'link') && !text) {
      const linkName = linkAccessibleName(target);
      if (linkName) text = linkName;
    }

    // If the target is a control with no visible text (e.g. hidden checkbox),
    // borrow the text from the associated label.
    if (!text || tag === 'input') {
      const labelText = findAssociatedLabel(target);
      if (labelText) text = labelText;
    }

    let preferred = aria || title || (text && text.length <= 60 ? text : '') || placeholder || (text ? text.slice(0, 60) + '...' : '') || name || value || '';
    if (!preferred && (tag === 'a' || role === 'link')) preferred = hrefLabel(target);

    // Categorize the action by tag, then by role. Decorative roles already
    // filtered out by effectiveRole.
    let kind = 'element';
    if (tag === 'a' || role === 'link') kind = 'link';
    else if (tag === 'button' || role === 'button') kind = 'button';
    else if (tag === 'input') {
      const t = (target.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') kind = t;
      else if (['submit', 'button', 'reset'].includes(t)) kind = 'button';
      else kind = 'input';
    }
    else if (tag === 'select') kind = 'dropdown';
    else if (tag === 'textarea') kind = 'text area';
    else if (tag === 'label') kind = 'label';
    else if (role && ROLE_KIND_MAP[role]) kind = ROLE_KIND_MAP[role];
    else if (role) kind = role; // unknown but meaningful role

    const label = preferred ? `${kind}: ${preferred}` : kind;

    return {
      label,
      kind,
      text: preferred,
      tag,
    };
  }

  // ---------- Full-page orchestration ----------

  function fullpageBegin() {
    const originalScrollY = window.scrollY || window.pageYOffset;
    const hiddenEls = [];
    if (STATE.indicator) STATE.indicator.style.display = 'none';
    try {
      const all = document.body ? document.body.querySelectorAll('*') : [];
      for (const el of all) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          hiddenEls.push({ el, display: el.style.display });
          el.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('[QA Tool] sticky element scan failed:', e);
    }
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body ? document.body.style.overflow : '';
    document.documentElement.style.overflow = 'visible';
    if (document.body) document.body.style.overflow = 'visible';
    STATE.fp = { originalScrollY, hiddenEls, htmlOverflow, bodyOverflow };
    window.scrollTo(0, 0);
    const totalHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    return {
      ok: true,
      totalHeight,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  }

  function fullpageScrollTo(index) {
    if (!STATE.fp) return { ok: false, error: 'fullpage session not begun' };
    const vh = window.innerHeight;
    window.scrollTo(0, index * vh);
    const actualY = window.scrollY || window.pageYOffset;
    const totalHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    return {
      ok: true,
      scrollY: actualY,
      viewportHeight: vh,
      atBottom: (actualY + vh) >= totalHeight - 1,
    };
  }

  function fullpageEnd() {
    if (!STATE.fp) return { ok: true };
    for (const h of STATE.fp.hiddenEls) {
      try { h.el.style.display = h.display; } catch {}
    }
    document.documentElement.style.overflow = STATE.fp.htmlOverflow || '';
    if (document.body) document.body.style.overflow = STATE.fp.bodyOverflow || '';
    window.scrollTo(0, STATE.fp.originalScrollY || 0);
    if (STATE.indicator) STATE.indicator.style.display = '';
    STATE.fp = null;
    return { ok: true };
  }

  // ---------- Message routing ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.type === 'KEYBOARD_TRIGGER') {
        if (window !== window.top) {
          sendResponse({ ok: true, skipped: 'subframe' });
          return;
        }
        const wantsIt = STATE.captureTarget === 'process'
          ? STATE.processTriggers.keyboard
          : STATE.triggers.keyboard;
        if (STATE.isRecording && !STATE.exportPending && wantsIt) {
          if (STATE.captureTarget === 'process') {
            const { x, y } = STATE.lastMouse;
            triggerCapture(x, y, 'process-keyboard', buildProcessPointPayload(x, y));
          } else {
            triggerCapture(STATE.lastMouse.x, STATE.lastMouse.y, 'keyboard');
          }
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'PRE_CAPTURE_RING') {
        if (window !== window.top) {
          sendResponse({ ok: true, skipped: 'subframe' });
          return;
        }
        if (STATE.isRecording && !STATE.exportPending
            && (STATE.captureTarget === 'visible' || STATE.captureTarget === 'process')) {
          drawRing(STATE.lastMouse.x, STATE.lastMouse.y)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
          return true;
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'MANUAL_CAPTURE_TRIGGER') {
        if (window !== window.top) {
          sendResponse({ ok: true, skipped: 'subframe' });
          return;
        }
        if (STATE.isRecording && !STATE.exportPending) {
          if (STATE.captureTarget === 'process') {
            const { x, y } = STATE.lastMouse;
            triggerCapture(x, y, 'manual', buildProcessPointPayload(x, y));
          } else {
            triggerCapture(STATE.lastMouse.x, STATE.lastMouse.y, 'manual');
          }
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'TIMER_TRIGGER') {
        if (window !== window.top) {
          sendResponse({ ok: true, skipped: 'subframe' });
          return;
        }
        const wantsIt = STATE.captureTarget === 'process'
          ? STATE.processTriggers.timer
          : STATE.triggers.timer;
        if (STATE.isRecording && !STATE.exportPending && wantsIt) {
          if (STATE.captureTarget === 'process') {
            const { x, y } = STATE.lastMouse;
            triggerCapture(x, y, 'process-timer', buildProcessPointPayload(x, y, { withActionLabel: false }));
          } else {
            triggerCapture(STATE.lastMouse.x, STATE.lastMouse.y, 'timer');
          }
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'PING') {
        sendResponse({ ok: true });
      } else if (msg.type === 'FULLPAGE_BEGIN') {
        sendResponse(fullpageBegin());
      } else if (msg.type === 'FULLPAGE_SCROLL_TO') {
        sendResponse(fullpageScrollTo(msg.index));
      } else if (msg.type === 'FULLPAGE_END') {
        sendResponse(fullpageEnd());
      } else if (msg.type === 'SYNC_STEP_COUNTER') {
        STATE.stepCounter = typeof msg.stepCounter === 'number' ? msg.stepCounter : 0;
        sendResponse({ ok: true });
      } else if (msg.type === 'RECORDING_STATE') {
        applyRecordingPayload({
          isRecording: msg.isRecording,
          captureTarget: msg.captureTarget,
          settings: msg.settings,
          exportPending: msg.exportPending,
        });
        sendResponse({ ok: true });
      } else {
        return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return false;
  });
})();
