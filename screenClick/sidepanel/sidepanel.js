// Side panel — tutorial-style step cards with screenshots, labels, and selection.

globalThis.ScreenClickTheme?.applyStoredTheme();
globalThis.ScreenClickTheme?.bindThemeToggle(document.getElementById('theme-toggle'));
globalThis.ScreenClickTheme?.listenThemeChanges();

const TARGET_LABELS = {
  visible: 'Visible Tab',
  process: 'Process Record',
  fullpage: 'Full Page',
  screen: 'Screen or Window',
};

const CAPTURE_FEEDBACK_LABELS = {
  visible: 'Capturing visible tab…',
  process: 'Capturing step…',
  fullpage: 'Capturing full page…',
  screen: 'Capturing screen or window…',
};

const els = {
  empty: document.getElementById('empty-state'),
  recordingWaiting: document.getElementById('recording-waiting'),
  list: document.getElementById('step-list'),
  meta: document.getElementById('session-meta'),
  badge: document.getElementById('recording-badge'),
  headerCaptureBtn: document.getElementById('header-capture-btn'),
  captureFeedback: document.getElementById('capture-feedback'),
  captureFeedbackText: document.getElementById('capture-feedback-text'),
  captureSuccess: document.getElementById('capture-success'),
  hint: document.getElementById('panel-hint'),
  idleActions: document.getElementById('idle-actions'),
  startBtn: document.getElementById('start-btn'),
  targetPicker: document.getElementById('target-picker'),
  targetCancel: document.getElementById('target-cancel'),
  actions: document.getElementById('panel-actions'),
  captureBtn: document.getElementById('capture-btn'),
  stopBtn: document.getElementById('stop-btn'),
  discardBtn: document.getElementById('discard-btn'),
  filenamePanel: document.getElementById('filename-panel'),
  filenameInput: document.getElementById('filename-input'),
  filenameSave: document.getElementById('filename-save'),
  filenameCancel: document.getElementById('filename-cancel'),
  error: document.getElementById('panel-error'),
  dock: document.getElementById('panel-dock'),
};

let pickerOpen = false;
let startInProgress = false;

const DEFAULT_SETTINGS = {
  triggers: { click: true, keyboard: true, timer: false },
  screenTriggers: { keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
};

let screenshots = [];
let session = {
  isRecording: false,
  captureTarget: 'visible',
  captureInProgress: false,
  settings: { ...DEFAULT_SETTINGS },
};
let selectedStepId = null;
let prevScreenshotCount = 0;
let pendingFocusLastLabel = false;
let captureSuccessTimer = null;
/** Step id whose label textarea is focused — blocks destructive list rebuilds. */
let labelEditId = null;
let suppressListRender = false;
let listEventsBound = false;

function captureSkeletonMarkup() {
  return `
    <li class="step-card step-card-skeleton" aria-hidden="true">
      <div class="skeleton-header"></div>
      <div class="skeleton-shot"></div>
    </li>`;
}

function renderCaptureFeedback() {
  if (session.captureInProgress) {
    els.captureFeedback.classList.remove('hidden');
    els.captureFeedbackText.textContent =
      CAPTURE_FEEDBACK_LABELS[session.captureTarget] || 'Capturing screenshot…';
    if (session.isRecording) els.badge.classList.add('is-capturing');
  } else {
    els.captureFeedback.classList.add('hidden');
    els.badge.classList.remove('is-capturing');
  }
}

function flashCaptureSuccess() {
  els.captureSuccess.classList.remove('hidden');
  if (captureSuccessTimer) clearTimeout(captureSuccessTimer);
  captureSuccessTimer = setTimeout(() => {
    captureSuccessTimer = null;
    els.captureSuccess.classList.add('hidden');
  }, 2000);
}

function stepId(shot, index) {
  return shot.id || `legacy_${index}`;
}

function hasCustomLabel(shot) {
  return Object.prototype.hasOwnProperty.call(shot, 'actionLabel');
}

function labelForInput(shot) {
  if (!hasCustomLabel(shot)) return '';
  const raw = String(shot.actionLabel ?? '').trim();
  if (!raw) return '';
  if (isProcessRecordMode()) {
    const src = shot.source || '';
    if (/^Manual step \d+$/i.test(raw) && (src === 'manual' || src === 'process-keyboard' || src === 'keyboard')) {
      return '';
    }
    if (/^Periodic step \d+$/i.test(raw) && (src === 'timer' || src === 'process-timer')) return '';
    if (raw === 'Capture' && src === 'process-click') return '';
  }
  return raw.replace(/^Step\s+\d+:\s*/i, '').trim();
}

function placeholderForStep(shot, index) {
  const num = shot.stepNumber || index + 1;
  if (hasCustomLabel(shot)) return 'Describe this point…';
  return `Step ${num} — add a Point (optional)`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function autoResizeLabel(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(36, textarea.scrollHeight)}px`;
}

function isLabelEditing() {
  return labelEditId != null;
}

function isScreenshotOnlyMode() {
  return session.captureTarget !== 'process';
}

function isProcessRecordMode() {
  return session.captureTarget === 'process';
}

function shouldShowEmptyState() {
  return !session.isRecording && !screenshots.length && !pickerOpen;
}

function captureShortcutChip() {
  return globalThis.ScreenClickShortcuts?.shortcutChip('2') || 'Ctrl+Shift+2';
}

function captureTooltipText() {
  return `Capture screenshot (${captureShortcutChip()})`;
}

async function triggerManualCapture() {
  if (!session.isRecording || session.captureInProgress) return;
  clearError();
  try {
    await chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
  } catch (e) {
    showError(e.message || 'Capture failed.');
  }
}

function renderEmptyState() {
  const show = shouldShowEmptyState();
  els.empty.classList.toggle('hidden', !show);
  if (!show) return;

  const shotVariant = document.getElementById('empty-screenshots');
  const processVariant = document.getElementById('empty-process');
  const shortcutEl = document.getElementById('empty-capture-shortcut');
  const processMode = isProcessRecordMode();

  if (shotVariant) shotVariant.classList.toggle('hidden', processMode);
  if (processVariant) processVariant.classList.toggle('hidden', !processMode);
  if (shortcutEl) shortcutEl.textContent = captureShortcutChip();
}

function panelHintText() {
  if (isProcessRecordMode()) {
    return 'Click a Point to edit · Enter to save · Esc to cancel';
  }
  if (session.captureTarget === 'screen') {
    return `${captureShortcutChip()} to capture · reorder or remove before export`;
  }
  return 'Reorder or remove screenshots before export';
}

function captureUnitLabel(count) {
  const unit = isScreenshotOnlyMode() ? 'screenshot' : 'step';
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function panelTitleText() {
  return isProcessRecordMode() ? 'Session steps' : 'Session screenshots';
}

function buildStepCardHtml(shot, index) {
  const id = stepId(shot, index);
  const selected = id === selectedStepId;

  if (isScreenshotOnlyMode()) {
    const num = index + 1;
    return `
    <li class="step-card shot-card${selected ? ' is-selected' : ''}" data-id="${escapeAttr(id)}" tabindex="0">
      <div class="step-shot-wrap shot-card-shot">
        <img class="step-shot" src="${escapeAttr(shot.dataUrl)}" alt="Screenshot ${num}" loading="lazy">
      </div>
      <div class="step-card-footer">
        <button type="button" class="step-btn" data-action="up" data-id="${escapeAttr(id)}" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="step-btn" data-action="down" data-id="${escapeAttr(id)}" ${index === screenshots.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="step-btn step-btn-danger" data-action="delete" data-id="${escapeAttr(id)}">Remove</button>
      </div>
    </li>`;
  }

  const label = labelForInput(shot);
  const placeholder = placeholderForStep(shot, index);
  const num = shot.stepNumber || index + 1;

  return `
    <li class="step-card${selected ? ' is-selected' : ''}" data-id="${escapeAttr(id)}" tabindex="0" role="option" aria-selected="${selected}">
      <div class="step-card-header">
        <span class="step-badge" aria-hidden="true">${num}</span>
        <div class="step-label-wrap">
          <textarea class="step-label-input" rows="1" data-id="${escapeAttr(id)}" placeholder="${escapeAttr(placeholder)}" aria-label="Step ${num} Point">${escapeHtml(label)}</textarea>
          <span class="step-label-hint" data-hint-for="${escapeAttr(id)}"></span>
        </div>
      </div>
      <div class="step-shot-wrap">
        <img class="step-shot" src="${escapeAttr(shot.dataUrl)}" alt="Step ${num} screenshot" loading="lazy">
      </div>
      <div class="step-card-footer">
        <button type="button" class="step-btn" data-action="up" data-id="${escapeAttr(id)}" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" class="step-btn" data-action="down" data-id="${escapeAttr(id)}" ${index === screenshots.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button type="button" class="step-btn step-btn-danger" data-action="delete" data-id="${escapeAttr(id)}">Remove</button>
      </div>
    </li>`;
}

function patchStepCard(card, shot, index, { preserveLabelInput = false } = {}) {
  const id = stepId(shot, index);

  if (card.classList.contains('shot-card')) {
    card.dataset.id = id;
    const img = card.querySelector('.step-shot');
    if (img.getAttribute('src') !== shot.dataUrl) img.src = shot.dataUrl;
    img.alt = `Screenshot ${index + 1}`;

    const up = card.querySelector('[data-action="up"]');
    const down = card.querySelector('[data-action="down"]');
    const del = card.querySelector('[data-action="delete"]');
    up.disabled = index === 0;
    down.disabled = index === screenshots.length - 1;
    up.dataset.id = down.dataset.id = del.dataset.id = id;
    return;
  }

  const num = shot.stepNumber || index + 1;

  card.dataset.id = id;
  card.querySelector('.step-badge').textContent = num;

  const img = card.querySelector('.step-shot');
  if (img.getAttribute('src') !== shot.dataUrl) img.src = shot.dataUrl;

  const input = card.querySelector('.step-label-input');
  input.dataset.id = id;
  input.setAttribute('aria-label', `Step ${num} Point`);
  input.placeholder = placeholderForStep(shot, index);

  if (!preserveLabelInput) {
    input.value = labelForInput(shot);
    autoResizeLabel(input);
  }

  const up = card.querySelector('[data-action="up"]');
  const down = card.querySelector('[data-action="down"]');
  const del = card.querySelector('[data-action="delete"]');
  up.disabled = index === 0;
  down.disabled = index === screenshots.length - 1;
  up.dataset.id = down.dataset.id = del.dataset.id = id;
}

function syncCaptureSkeleton() {
  const skeleton = els.list.querySelector('.step-card-skeleton');
  if (session.captureInProgress) {
    if (!skeleton) {
      els.list.insertAdjacentHTML('afterbegin', captureSkeletonMarkup());
    }
  } else if (skeleton) {
    skeleton.remove();
  }
}

function syncRecordingWaiting() {
  const show = session.isRecording && !screenshots.length && !session.captureInProgress;
  if (els.recordingWaiting) els.recordingWaiting.classList.toggle('hidden', !show);
}

function syncStepListIncremental() {
  if (!screenshots.length) {
    if (session.captureInProgress) {
      syncRecordingWaiting();
      els.empty.classList.add('hidden');
      els.list.classList.remove('hidden');
      els.list.innerHTML = captureSkeletonMarkup();
    } else if (session.isRecording) {
      syncRecordingWaiting();
      els.empty.classList.add('hidden');
      els.list.classList.add('hidden');
      els.list.innerHTML = '';
    } else {
      syncRecordingWaiting();
      els.empty.classList.toggle('hidden', !shouldShowEmptyState());
      els.list.classList.add('hidden');
      els.list.innerHTML = '';
    }
    prevScreenshotCount = 0;
    return;
  }

  els.empty.classList.add('hidden');
  if (els.recordingWaiting) els.recordingWaiting.classList.add('hidden');
  els.list.classList.remove('hidden');
  syncCaptureSkeleton();

  const keepIds = new Set();
  screenshots.forEach((shot, index) => {
    const id = stepId(shot, index);
    keepIds.add(id);
    let card = els.list.querySelector(`.step-card[data-id="${CSS.escape(id)}"]`);

    if (!card) {
      const wrap = document.createElement('div');
      wrap.innerHTML = buildStepCardHtml(shot, index).trim();
      card = wrap.firstElementChild;
      els.list.appendChild(card);
    } else {
      patchStepCard(card, shot, index, { preserveLabelInput: labelEditId === id });
    }

    const selected = id === selectedStepId;
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-selected', selected ? 'true' : 'false');
    card.classList.toggle('is-editing-label', labelEditId === id);
  });

  els.list.querySelectorAll('.step-card:not(.step-card-skeleton)').forEach((card) => {
    if (!keepIds.has(card.dataset.id)) card.remove();
  });

  prevScreenshotCount = screenshots.length;
}

function rebuildStepList() {
  if (!screenshots.length) {
    if (session.captureInProgress) {
      syncRecordingWaiting();
      els.empty.classList.add('hidden');
      els.list.classList.remove('hidden');
      els.list.innerHTML = captureSkeletonMarkup();
    } else if (session.isRecording) {
      syncRecordingWaiting();
      els.empty.classList.add('hidden');
      els.list.classList.add('hidden');
      els.list.innerHTML = '';
    } else {
      syncRecordingWaiting();
      els.empty.classList.toggle('hidden', !shouldShowEmptyState());
      els.list.classList.add('hidden');
      els.list.innerHTML = '';
    }
    selectedStepId = null;
    prevScreenshotCount = 0;
    return;
  }

  const grew = screenshots.length > prevScreenshotCount;
  if (!selectedStepId || !screenshots.some((s, i) => stepId(s, i) === selectedStepId)) {
    const last = screenshots[screenshots.length - 1];
    selectedStepId = stepId(last, screenshots.length - 1);
  }
  if (grew) {
    const last = screenshots[screenshots.length - 1];
    selectedStepId = stepId(last, screenshots.length - 1);
  }

  const skeleton = session.captureInProgress ? captureSkeletonMarkup() : '';
  els.empty.classList.add('hidden');
  if (els.recordingWaiting) els.recordingWaiting.classList.add('hidden');
  els.list.classList.remove('hidden');
  els.list.innerHTML = skeleton + screenshots.map((shot, index) => buildStepCardHtml(shot, index)).join('');

  prevScreenshotCount = screenshots.length;

  els.list.querySelectorAll('.step-label-input').forEach(autoResizeLabel);

  const selectedCard = els.list.querySelector(`.step-card[data-id="${CSS.escape(selectedStepId)}"]`);
  if (selectedCard) {
    if (!isScreenshotOnlyMode() && (grew || pendingFocusLastLabel)) {
      selectedCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (pendingFocusLastLabel) {
        focusStepLabelInput(selectedCard, true);
        pendingFocusLastLabel = false;
      }
    } else if (grew || pendingFocusLastLabel) {
      selectedCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      pendingFocusLastLabel = false;
    }
    if (grew && !pendingFocusLastLabel) {
      selectedCard.classList.add('step-card-new');
      setTimeout(() => selectedCard.classList.remove('step-card-new'), 1200);
    }
  } else if (pendingFocusLastLabel) {
    pendingFocusLastLabel = false;
  }
}

function hasAutoCaptureTriggers() {
  const s = session.settings || DEFAULT_SETTINGS;
  const target = session.captureTarget;
  if (target === 'visible') {
    const t = s.triggers || {};
    return !!(t.click || t.keyboard || t.timer);
  }
  if (target === 'screen') {
    const st = s.screenTriggers || {};
    return !!(st.keyboard || st.timer);
  }
  if (target === 'process') {
    const p = s.processTriggers || {};
    return !!(p.click || p.inputChange || p.keyboard || p.timer);
  }
  if (target === 'fullpage') {
    const t = s.triggers || {};
    return !!(t.keyboard || t.timer);
  }
  return true;
}

function showManualCaptureButton() {
  return session.isRecording && !hasAutoCaptureTriggers();
}

async function loadSession() {
  const data = await chrome.storage.local.get([
    'isRecording', 'screenshots', 'captureTarget', 'captureInProgress', 'settings',
  ]);
  session.isRecording = !!data.isRecording;
  session.captureTarget = data.captureTarget || 'visible';
  session.captureInProgress = !!data.captureInProgress;
  session.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  session.settings.screenTriggers = {
    ...DEFAULT_SETTINGS.screenTriggers,
    ...(session.settings.screenTriggers || {}),
  };
  session.settings.processTriggers = {
    ...DEFAULT_SETTINGS.processTriggers,
    ...(session.settings.processTriggers || {}),
  };
  screenshots = data.screenshots || [];
  if (screenshots.some((s) => !s.id)) {
    try {
      await chrome.runtime.sendMessage({ type: 'MIGRATE_STEP_IDS' });
      const fresh = await chrome.storage.local.get(['screenshots']);
      screenshots = fresh.screenshots || screenshots;
    } catch { /* ignore */ }
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}

function clearError() {
  els.error.classList.add('hidden');
  els.error.textContent = '';
}

function defaultFilename() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `QA-Report-${stamp}`;
}

function showFilenamePanel() {
  clearError();
  els.filenameInput.value = defaultFilename();
  els.filenamePanel.classList.remove('hidden');
  chrome.runtime.sendMessage({ type: 'PREPARE_EXPORT' }).catch(() => {});
  updateFloatingDock();
  setTimeout(() => {
    els.filenameInput.focus();
    els.filenameInput.select();
  }, 30);
}

function hideFilenamePanel() {
  els.filenamePanel.classList.add('hidden');
  chrome.runtime.sendMessage({ type: 'CANCEL_EXPORT' }).catch(() => {});
  updateFloatingDock();
}

function showTargetPicker() {
  pickerOpen = true;
  clearError();
  els.empty.classList.add('hidden');
  if (els.recordingWaiting) els.recordingWaiting.classList.add('hidden');
  els.list.classList.add('hidden');
  els.targetPicker.classList.remove('hidden');
  els.targetPicker.querySelectorAll('.target-btn').forEach((btn) => {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  });
  if (els.startBtn) els.startBtn.classList.add('hidden');
  if (els.targetCancel) els.targetCancel.classList.remove('hidden');
  updateFloatingDock();
}

function hideTargetPicker() {
  pickerOpen = false;
  els.targetPicker.classList.add('hidden');
  if (els.startBtn) els.startBtn.classList.remove('hidden');
  if (els.targetCancel) els.targetCancel.classList.add('hidden');
  els.targetPicker.querySelectorAll('.target-btn').forEach((btn) => {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  });
  renderEmptyState();
  updateFloatingDock();
}

function updateFloatingDock() {
  const filenameOpen = !els.filenamePanel.classList.contains('hidden');
  const recordingActions = session.isRecording && !filenameOpen;
  const idleActions = !session.isRecording && !filenameOpen;
  const showDock = recordingActions || filenameOpen || idleActions;

  els.dock.classList.toggle('hidden', !showDock);
  document.body.classList.toggle('has-floating-dock', showDock && (recordingActions || idleActions));
  if (els.idleActions) els.idleActions.classList.toggle('hidden', !idleActions);
  els.actions.classList.toggle('hidden', !recordingActions);
  const manualCapture = showManualCaptureButton();
  if (els.captureBtn) {
    els.captureBtn.classList.toggle('hidden', !manualCapture);
    els.captureBtn.disabled = !manualCapture || session.captureInProgress;
  }
  if (els.headerCaptureBtn) {
    const showHeaderCapture = session.isRecording && !filenameOpen;
    els.headerCaptureBtn.classList.toggle('hidden', !showHeaderCapture);
    els.headerCaptureBtn.disabled = !showHeaderCapture || session.captureInProgress;
    const tip = captureTooltipText();
    els.headerCaptureBtn.title = tip;
    els.headerCaptureBtn.setAttribute('aria-label', tip);
  }
  els.stopBtn.disabled = !recordingActions;
  els.discardBtn.disabled = !recordingActions;
  if (els.startBtn) els.startBtn.disabled = startInProgress;

  const hint = document.getElementById('panel-hint');
  if (hint) {
    hint.classList.toggle('hidden', filenameOpen || idleActions);
  }
}

function renderToolbar() {
  updateFloatingDock();
}

function renderHeader() {
  const mode = TARGET_LABELS[session.captureTarget] || 'Capture';
  const titleEl = document.querySelector('.panel-title');
  if (titleEl) {
    titleEl.textContent = panelTitleText();
  }
  renderCaptureFeedback();
  if (session.isRecording) {
    els.badge.classList.remove('hidden');
    els.meta.textContent = `${mode} · ${captureUnitLabel(screenshots.length)}`;
  } else {
    els.badge.classList.add('hidden');
    if (pickerOpen) {
      els.meta.textContent = 'Choose capture mode';
    } else {
      els.meta.textContent = screenshots.length
        ? `${captureUnitLabel(screenshots.length)} in session`
        : 'Ready to capture';
    }
    hideFilenamePanel();
    if (!pickerOpen && !screenshots.length) {
      els.targetPicker.classList.add('hidden');
    }
  }

  const hint = document.getElementById('panel-hint');
  if (hint) {
    hint.textContent = panelHintText();
  }

  renderToolbar();
}

function renderList() {
  renderHeader();
  renderEmptyState();
  if (isLabelEditing()) {
    syncStepListIncremental();
    return;
  }
  rebuildStepList();
}

function focusStepLabelInput(cardOrId, selectAll) {
  const card = typeof cardOrId === 'string'
    ? els.list.querySelector(`.step-card[data-id="${CSS.escape(cardOrId)}"]`)
    : cardOrId;
  if (!card) return;
  const input = card.querySelector('.step-label-input');
  if (!input) return;
  labelEditId = input.dataset.id;
  selectedStepId = labelEditId;
  card.classList.add('is-selected', 'is-editing-label');
  requestAnimationFrame(() => {
    input.focus();
    if (selectAll) input.select();
    else {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  });
}

function focusLastStepTitle() {
  if (!screenshots.length) {
    pendingFocusLastLabel = false;
    return;
  }
  const lastIdx = screenshots.length - 1;
  selectedStepId = stepId(screenshots[lastIdx], lastIdx);
  pendingFocusLastLabel = true;
  renderList();
}

function selectStep(id) {
  if (!id) return;
  selectedStepId = id;
  els.list.querySelectorAll('.step-card:not(.step-card-skeleton)').forEach((card) => {
    const on = card.dataset.id === id;
    card.classList.toggle('is-selected', on);
    card.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function setLabelHint(id, message, tone = '') {
  const hint = els.list.querySelector(`[data-hint-for="${CSS.escape(id)}"]`);
  if (!hint) return;
  hint.textContent = message || '';
  hint.className = 'step-label-hint' + (tone ? ` is-${tone}` : '');
}

async function flushSave(input) {
  const id = input.dataset.id;
  const value = input.value.trim();
  const card = input.closest('.step-card');

  setLabelHint(id, 'Saving…', 'pending');

  suppressListRender = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_STEP',
      id,
      actionLabel: value,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Save failed');
    setLabelHint(id, 'Saved', 'ok');
    setTimeout(() => {
      if (!input.matches(':focus')) setLabelHint(id, '');
    }, 1600);
  } catch (e) {
    setLabelHint(id, 'Could not save', 'err');
    console.warn('[ScreenClick sidepanel] save failed:', e);
  } finally {
    suppressListRender = false;
    if (card) card.classList.remove('is-saving');
  }
}

async function moveStep(id, direction) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'MOVE_STEP', id, direction });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Move failed');
  } catch (e) {
    console.warn('[ScreenClick sidepanel] move failed:', e);
  }
}

async function deleteStep(id) {
  const noun = isScreenshotOnlyMode() ? 'screenshot' : 'step';
  if (!confirm(`Remove this ${noun} from the session?`)) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_STEP', id });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Delete failed');
  } catch (e) {
    console.warn('[ScreenClick sidepanel] move failed:', e);
  }
}

function bindListEvents() {
  if (listEventsBound) return;
  listEventsBound = true;

  els.list.addEventListener('input', (e) => {
    const input = e.target.closest('.step-label-input');
    if (!input) return;
    autoResizeLabel(input);
    setLabelHint(input.dataset.id, '');
  });

  els.list.addEventListener('focusin', (e) => {
    const input = e.target.closest('.step-label-input');
    if (!input) return;
    e.stopPropagation();
    labelEditId = input.dataset.id;
    selectedStepId = labelEditId;
    selectStep(labelEditId);
    input.closest('.step-card')?.classList.add('is-editing-label');
    setLabelHint(labelEditId, '');
  });

  els.list.addEventListener('focusout', (e) => {
    const input = e.target.closest('.step-label-input');
    if (!input) return;
    const id = input.dataset.id;
    labelEditId = null;
    input.closest('.step-card')?.classList.remove('is-editing-label');
    flushSave(input);
  });

  els.list.addEventListener('keydown', (e) => {
    const input = e.target.closest('.step-label-input');
    if (!input) return;
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      const shot = screenshots.find((s, i) => stepId(s, i) === input.dataset.id);
      if (shot) input.value = labelForInput(shot);
      input.blur();
    }
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      if (btn.disabled) return;
      const { action, id } = btn.dataset;
      if (action === 'up') moveStep(id, -1);
      else if (action === 'down') moveStep(id, 1);
      else if (action === 'delete') deleteStep(id);
      return;
    }

    if (e.target.closest('.step-label-input')) return;

    const card = e.target.closest('.step-card');
    if (card?.dataset.id && !card.classList.contains('step-card-skeleton')) {
      selectStep(card.dataset.id);
    }
  });

  els.list.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('step-label-input')) return;
    const card = e.target.closest('.step-card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectStep(card.dataset.id);
    }
  });
}

async function startRecordingWithTarget(target, btn) {
  if (startInProgress) return;
  startInProgress = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-loading');
  }
  clearError();
  updateFloatingDock();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_RECORDING', target });
    if (response && response.ok) {
      pickerOpen = false;
      els.targetPicker.classList.add('hidden');
      if (els.startBtn) els.startBtn.classList.remove('hidden');
      if (els.targetCancel) els.targetCancel.classList.add('hidden');
      await loadSession();
      renderList();
    } else {
      showError((response && response.error) || 'Could not start recording.');
    }
  } catch (e) {
    showError(e.message || 'Could not reach extension background.');
  } finally {
    startInProgress = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
    updateFloatingDock();
  }
}

if (els.startBtn) {
  els.startBtn.addEventListener('click', () => showTargetPicker());
}

if (els.targetCancel) {
  els.targetCancel.addEventListener('click', () => hideTargetPicker());
}

els.targetPicker?.querySelectorAll('.target-btn').forEach((btn) => {
  btn.addEventListener('click', () => startRecordingWithTarget(btn.dataset.target, btn));
});

if (els.captureBtn) {
  els.captureBtn.addEventListener('click', () => triggerManualCapture());
}

if (els.headerCaptureBtn) {
  els.headerCaptureBtn.addEventListener('click', () => triggerManualCapture());
}

globalThis.ScreenClickShortcuts?.bindPageShortcuts({
  allowToggle: () => true,
  allowCapture: () => session.isRecording && session.captureTarget === 'screen',
});

els.stopBtn.addEventListener('click', () => {
  if (!session.isRecording) return;
  showFilenamePanel();
});

els.discardBtn.addEventListener('click', async () => {
  if (!session.isRecording) return;
  if (!confirm('Discard all screenshots from this session?')) return;
  clearError();
  try {
    await chrome.runtime.sendMessage({ type: 'DISCARD_SESSION' });
    hideFilenamePanel();
  } catch (e) {
    showError(e.message || 'Could not discard session.');
  }
});

els.filenameCancel.addEventListener('click', () => {
  hideFilenamePanel();
});

els.filenameSave.addEventListener('click', async () => {
  clearError();
  const filename = els.filenameInput.value.trim() || 'QA-Report';
  els.filenameSave.disabled = true;
  els.filenameSave.textContent = 'Building…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'STOP_AND_SAVE', filename });
    if (res && res.ok) {
      hideFilenamePanel();
    } else {
      showError((res && res.reason) || 'PDF build failed.');
    }
  } catch (e) {
    showError(e.message || 'PDF build failed.');
  } finally {
    els.filenameSave.disabled = false;
    els.filenameSave.textContent = 'Save PDF';
  }
});

els.filenameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.filenameSave.click();
  if (e.key === 'Escape') els.filenameCancel.click();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastCaptureSuccessAt?.newValue) flashCaptureSuccess();
  if (changes.lastCaptureError?.newValue) showError(changes.lastCaptureError.newValue);

  const listAffecting =
    changes.screenshots
    || changes.isRecording
    || changes.captureTarget
    || changes.captureInProgress
    || changes.settings;

  if (changes.isRecording?.newValue === false) {
    els.targetPicker?.querySelectorAll('.target-btn').forEach((btn) => {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    });
  }

  if (changes.isRecording?.newValue === true) {
    pickerOpen = false;
    els.targetPicker?.classList.add('hidden');
    if (els.startBtn) els.startBtn.classList.remove('hidden');
    if (els.targetCancel) els.targetCancel.classList.add('hidden');
  }

  if (!listAffecting && !changes.sidePanelEditLastStep) return;
  if (suppressListRender && changes.screenshots) return;

  loadSession().then(() => {
    if (changes.sidePanelEditLastStep && isProcessRecordMode()) {
      pendingFocusLastLabel = true;
    }
    if (isLabelEditing() && changes.screenshots) {
      renderHeader();
      syncStepListIncremental();
      return;
    }
    renderList();
  });
});

bindListEvents();
loadSession().then(renderList);
