// Service worker. Manifest V3.
// Responsibilities: session state, capture orchestration for three target
// modes (visible tab, full page, entire screen), timer, keyboard command,
// offscreen document lifecycle, downloads, badge updates.

const DEFAULT_SETTINGS = {
  triggers: { click: true, keyboard: true, timer: false },
  screenTriggers: { keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  screenTimerInterval: 10000,
  processTimerInterval: 10000,
  imageQuality: 0.8,
  includeTimestamp: true,
};

function getTimerIntervalMs(settings, captureTarget) {
  if (captureTarget === 'screen') {
    return settings.screenTimerInterval || settings.timerInterval || DEFAULT_SETTINGS.screenTimerInterval;
  }
  if (captureTarget === 'process') {
    return settings.processTimerInterval || settings.timerInterval || DEFAULT_SETTINGS.processTimerInterval;
  }
  return settings.timerInterval || DEFAULT_SETTINGS.timerInterval;
}

function wantsTimerForTarget(settings, captureTarget) {
  if (captureTarget === 'process') {
    return !!(settings.processTriggers && settings.processTriggers.timer);
  }
  if (captureTarget === 'screen') {
    const st = settings.screenTriggers || settings.triggers || {};
    return !!st.timer;
  }
  return !!(settings.triggers && settings.triggers.timer);
}

function isHttpTabUrl(url) {
  return !!url && (url.startsWith('http://') || url.startsWith('https://'));
}

async function resolvePickerTabForDesktopCapture(preferredTabId) {
  if (preferredTabId != null) {
    try {
      const t = await chrome.tabs.get(preferredTabId);
      if (isHttpTabUrl(t.url)) return t;
    } catch { /* tab gone */ }
  }
  const focused = await chrome.tabs.query({ lastFocusedWindow: true });
  const inWindow = focused.find((t) => isHttpTabUrl(t.url));
  if (inWindow) return inWindow;
  const all = await chrome.tabs.query({});
  return all.find((t) => isHttpTabUrl(t.url)) || null;
}

// Chrome rate-limits captureVisibleTab to ~2/sec. Keep a serialized queue
// with a minimum inter-capture gap (not needed for desktop stream captures).
const MIN_CAPTURE_GAP_MS = 600;
const SCREEN_CAPTURE_GAP_MS = 0;
const CAPTURE_PENDING_STALE_MS = 12000;
const LAUNCHER_PORT_WAIT_MS = 2500;
const LAUNCHER_REQUEST_TIMEOUT_MS = 20000;
// Settling time per full-page scroll tile, lets animations/lazy-load settle.
const FULLPAGE_TILE_SETTLE_MS = 280;
// Max number of tiles for a full-page capture (safety cap on infinite pages).
const FULLPAGE_MAX_TILES = 30;

let timerHandle = null;
let captureChain = Promise.resolve();
let lastCaptureAt = 0;
let lastKeyboardCaptureAt = 0;
let lastToggleAt = 0;
const KEYBOARD_CAPTURE_DEBOUNCE_MS = 350;
const TOGGLE_DEBOUNCE_MS = 400;
/** @type {chrome.runtime.Port | null} */
let launcherPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'screenclick-launcher') return;
  launcherPort = port;
  port.onDisconnect.addListener(() => {
    if (launcherPort === port) launcherPort = null;
  });
});

function makeStepId() {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function renumberSteps(list, { processMode = false } = {}) {
  return list.map((shot, i) => {
    const next = { ...shot };
    if (processMode || next.stepNumber != null) next.stepNumber = i + 1;
    return next;
  });
}

function defaultProcessActionLabel(source, stepNum, meta = {}) {
  const fromMeta = normalizeProcessActionLabel(source, meta.actionLabel);
  switch (source) {
    case 'timer':
    case 'process-timer':
      return fromMeta || '';
    case 'keyboard':
    case 'process-keyboard':
    case 'manual':
      return fromMeta || '';
    case 'process-input':
      return fromMeta || `Filled field (step ${stepNum})`;
    case 'process-click':
      return fromMeta || '';
    default:
      return fromMeta || `Step ${stepNum}`;
  }
}

function isLegacyAutoProcessLabel(source, actionLabel) {
  const label = (actionLabel ?? '').trim();
  if (!label) return false;
  if (/^Manual step \d+$/i.test(label)) {
    return source === 'manual' || source === 'process-keyboard' || source === 'keyboard';
  }
  if (/^Periodic step \d+$/i.test(label)) {
    return source === 'timer' || source === 'process-timer';
  }
  if (label === 'Capture' && source === 'process-click') return true;
  return false;
}

function normalizeProcessActionLabel(source, actionLabel) {
  if (isLegacyAutoProcessLabel(source, actionLabel)) return '';
  return (actionLabel ?? '').trim();
}

function finalizeProcessCapture(record, list, meta) {
  const stepNum = list.length + 1;
  record.stepNumber = stepNum;
  if (!record.actionLabel) {
    const label = defaultProcessActionLabel(record.source, stepNum, meta);
    if (label) record.actionLabel = label;
  }
  list.push(record);
  return renumberSteps(list, { processMode: true });
}

function findStepIndex(list, id) {
  if (id.startsWith('legacy_')) {
    const index = parseInt(id.slice(7), 10);
    return Number.isNaN(index) ? -1 : index;
  }
  return list.findIndex((s) => s.id === id);
}

async function syncProcessStepCounter() {
  const { screenshots, captureTarget, isRecording, activeTabId } = await getState();
  if (!isRecording || captureTarget !== 'process' || !activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'SYNC_STEP_COUNTER',
      stepCounter: screenshots.length,
    });
  } catch { /* tab may be unavailable */ }
}

const SIDE_PANEL_PATH = 'sidepanel/sidepanel.html';

async function ensureSidePanelEnabled(tabId, windowId) {
  if (!chrome.sidePanel?.setOptions) return;
  try {
    const opts = { path: SIDE_PANEL_PATH, enabled: true };
    if (tabId != null) await chrome.sidePanel.setOptions({ ...opts, tabId });
    else await chrome.sidePanel.setOptions(opts);
  } catch (e) {
    console.warn('[ScreenClick] sidePanel.setOptions:', e?.message || e);
  }
}

// sidePanel.open() must run in the same turn as the user gesture (before await) or Chrome blocks it.
function openSidePanelNow(windowId, tabId) {
  if (!chrome.sidePanel?.open) return;
  if (tabId != null) {
    chrome.sidePanel.open({ tabId }).catch((e) => {
      console.warn('[ScreenClick] sidePanel.open:', e?.message || e);
    });
  } else if (windowId != null) {
    chrome.sidePanel.open({ windowId }).catch((e) => {
      console.warn('[ScreenClick] sidePanel.open:', e?.message || e);
    });
  }
}

async function openStepsPanel(windowId, tabId) {
  if (!chrome.sidePanel) return;
  openSidePanelNow(windowId, tabId);
  await ensureSidePanelEnabled(tabId, windowId);
}

async function ensureStepIds() {
  const { screenshots } = await getState();
  if (!screenshots.some((s) => !s.id)) return screenshots;
  const list = screenshots.map((s) => (s.id ? s : { ...s, id: makeStepId() }));
  await setState({ screenshots: list });
  return list;
}

async function updateStepLabel(id, actionLabel) {
  await ensureStepIds();
  const { screenshots } = await getState();
  const idx = findStepIndex(screenshots, id);
  if (idx === -1) throw new Error('Step not found.');
  const list = screenshots.map((s) => ({ ...s }));
  list[idx].actionLabel = (actionLabel ?? '').trim();
  list[idx].stepNumber = idx + 1;
  if (!list[idx].id) list[idx].id = makeStepId();
  await setState({ screenshots: list });
  await updateBadge();
}

async function deleteStep(id) {
  await ensureStepIds();
  const { screenshots } = await getState();
  const idx = findStepIndex(screenshots, id);
  if (idx === -1) throw new Error('Step not found.');
  const list = screenshots.filter((_, i) => i !== idx);
  const { captureTarget } = await getState();
  const renumbered = renumberSteps(list, { processMode: captureTarget === 'process' });
  await setState({ screenshots: renumbered });
  await syncProcessStepCounter();
  await updateBadge();
}

async function moveStep(id, direction) {
  await ensureStepIds();
  const { screenshots } = await getState();
  const idx = findStepIndex(screenshots, id);
  if (idx === -1) throw new Error('Step not found.');
  const next = idx + direction;
  if (next < 0 || next >= screenshots.length) throw new Error('Cannot move step.');
  const list = screenshots.map((s) => ({ ...s }));
  const [item] = list.splice(idx, 1);
  list.splice(next, 0, item);
  const { captureTarget } = await getState();
  await setState({ screenshots: renumberSteps(list, { processMode: captureTarget === 'process' }) });
  await syncProcessStepCounter();
  await updateBadge();
}

// ---------- State helpers ----------

async function getState() {
  const data = await chrome.storage.local.get([
    'isRecording', 'screenshots', 'settings',
    'activeTabId', 'activeWindowId', 'captureTarget',
    'screenPickerTabId', 'screenPickerWindowId', 'screenLauncherWindowId',
  ]);
  return {
    isRecording: !!data.isRecording,
    screenshots: data.screenshots || [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...(data.settings || {}),
      screenTriggers: {
        ...DEFAULT_SETTINGS.screenTriggers,
        ...((data.settings || {}).screenTriggers || {}),
      },
    },
    activeTabId: data.activeTabId || null,
    activeWindowId: data.activeWindowId || null,
    captureTarget: data.captureTarget || 'visible',
    screenPickerTabId: data.screenPickerTabId || null,
    screenPickerWindowId: data.screenPickerWindowId || null,
    screenLauncherWindowId: data.screenLauncherWindowId || null,
  };
}

async function clearScreenPickerContext() {
  await setState({
    screenPickerTabId: null,
    screenPickerWindowId: null,
    screenLauncherWindowId: null,
  });
}

async function isLauncherWindowOpen() {
  const { screenLauncherWindowId } = await getState();
  if (!screenLauncherWindowId) return false;
  try {
    await chrome.windows.get(screenLauncherWindowId);
    return true;
  } catch {
    return false;
  }
}

async function waitForLauncherPort(maxMs = LAUNCHER_PORT_WAIT_MS) {
  if (launcherPort) return true;
  const deadline = Date.now() + maxMs;
  while (!launcherPort && Date.now() < deadline) {
    if (!(await isLauncherWindowOpen())) return false;
    await sleep(40);
  }
  return !!launcherPort;
}

async function clearStaleCapturePending() {
  const { captureInProgress } = await chrome.storage.local.get('captureInProgress');
  if (!captureInProgress) return;
  if (Date.now() - captureInProgress > CAPTURE_PENDING_STALE_MS) {
    await chrome.storage.local.remove('captureInProgress');
  }
}

function sendToLauncherViaPort(msg, requestId) {
  return new Promise((resolve) => {
    const port = launcherPort;
    if (!port) {
      resolve({ ok: false, error: 'Screen helper is still loading. Wait a moment and try again.' });
      return;
    }
    const timeout = setTimeout(() => {
      port.onMessage.removeListener(onReply);
      resolve({ ok: false, error: 'Screen capture timed out. Keep the helper window open.' });
    }, LAUNCHER_REQUEST_TIMEOUT_MS);
    const onReply = (reply) => {
      if (!reply || reply.requestId !== requestId) return;
      clearTimeout(timeout);
      port.onMessage.removeListener(onReply);
      resolve(reply);
    };
    port.onMessage.addListener(onReply);
    port.postMessage({ ...msg, requestId });
  });
}

async function sendToLauncherViaRuntime(msg) {
  const response = await chrome.runtime.sendMessage({ ...msg, target: 'launcher' });
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  return response || { ok: false, error: 'No response from screen capture window.' };
}

async function sendToLauncher(msg) {
  if (!(await isLauncherWindowOpen())) {
    return {
      ok: false,
      error: 'Screen helper window is closed. Start Screen or Window mode again and keep that window open (minimize is OK).',
    };
  }
  await waitForLauncherPort();
  if (launcherPort) {
    const requestId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await sendToLauncherViaPort(msg, requestId);
    if (res && res.ok) return res;
    if (res && res.error && !/loading|timed out|disconnect/i.test(res.error)) return res;
  }
  try {
    return await sendToLauncherViaRuntime(msg);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function stopScreenCaptureSession() {
  try {
    await sendToLauncher({ type: 'STOP_SCREEN_STREAM' });
  } catch { /* launcher may already be closed */ }
  const { screenLauncherWindowId } = await chrome.storage.local.get('screenLauncherWindowId');
  if (screenLauncherWindowId) {
    try { await chrome.windows.remove(screenLauncherWindowId); } catch {}
  }
  await setState({ screenLauncherWindowId: null });
}

async function resolveTabForSession(fallbackPicker = false) {
  const state = await getState();
  let tabId = fallbackPicker ? state.screenPickerTabId : null;
  let windowId = fallbackPicker ? state.screenPickerWindowId : null;

  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab;
    } catch { /* picker tab closed */ }
  }

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab.');
  return tab;
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
}

async function updateBadge() {
  const { isRecording, screenshots } = await getState();
  if (isRecording) {
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    await chrome.action.setBadgeText({
      text: screenshots.length > 0 ? String(screenshots.length) : 'REC',
    });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---------- Start / Stop ----------

async function startRecording(target, _screenStreamId, options = {}) {
  target = target || 'visible';
  const launcherStreamReady = !!options.launcherStreamReady;
  const usePickerContext = target === 'screen' && launcherStreamReady;
  const tab = await resolveTabForSession(usePickerContext);

  // Visible-tab and process require a normal http/https page.
  if (target !== 'screen') {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('https://chromewebstore.google.com')) {
      throw new Error('Cannot capture this page. Open a regular http/https page first.');
    }
  }

  // Screen mode: extension desktopCapture picker (not getDisplayMedia).
  if (target === 'screen' && !launcherStreamReady) {
    const pickerTab = await resolvePickerTabForDesktopCapture(tab.id);
    if (!pickerTab) {
      throw new Error('Open a normal website tab (http or https) in Chrome, then start Screen or Window mode.');
    }
    await setState({
      screenPickerTabId: pickerTab.id,
      screenPickerWindowId: pickerTab.windowId,
    });
    await openScreenLauncher(pickerTab.id);
    return { pending: true };
  }

  await chrome.storage.local.remove('exportPending');
  await setState({
    isRecording: true,
    screenshots: [],
    activeTabId: tab.id,
    activeWindowId: tab.windowId,
    captureTarget: target,
    sessionStartedAt: Date.now(),
    sessionStartedAtUtc: new Date().toISOString(),
    screenPickerTabId: null,
    screenPickerWindowId: null,
  });

  const { settings } = await getState();
  if (wantsTimerForTarget(settings, target)) startTimer(getTimerIntervalMs(settings, target));
  await updateBadge();

  if (target === 'fullpage') {
    await ensureOffscreen();
    await sendToOffscreen({ type: 'RESET_STITCH_BUFFER' });
  }

  if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    await ensureContentScript(tab.id);
    await pushRecordingStateToTab(tab.id);
    if (target === 'process') await syncProcessStepCounter();
  }

  await openStepsPanel(tab.windowId, tab.id);
  await ensureStepIds();
  return { ok: true };
}

async function openScreenLauncher(tabId) {
  const url = new URL(chrome.runtime.getURL('launcher/launcher.html'));
  if (tabId != null) url.searchParams.set('tabId', String(tabId));
  const win = await chrome.windows.create({
    url: url.toString(),
    type: 'normal',
    width: 920,
    height: 720,
    focused: true,
  });
  if (win && win.id != null) {
    await setState({ screenLauncherWindowId: win.id });
  }
}

async function pushRecordingStateToTab(tabId) {
  const { isRecording, captureTarget, settings } = await getState();
  const { exportPending } = await chrome.storage.local.get('exportPending');
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'RECORDING_STATE',
      isRecording,
      captureTarget,
      settings,
      exportPending: !!exportPending,
    });
  } catch (e) {
    console.warn('[QA Tool] RECORDING_STATE push failed:', e?.message || e);
  }
}

async function setExportPending(pending) {
  if (pending) {
    await chrome.storage.local.set({ exportPending: true });
  } else {
    await chrome.storage.local.remove('exportPending');
  }
  const { activeTabId } = await getState();
  if (activeTabId) await pushRecordingStateToTab(activeTabId);
}

async function prepareExport() {
  stopTimer();
  await setExportPending(true);
}

async function cancelExport() {
  await setExportPending(false);
  const { isRecording, settings, captureTarget } = await getState();
  if (isRecording && wantsTimerForTarget(settings, captureTarget)) {
    startTimer(getTimerIntervalMs(settings, captureTarget));
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/content.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: true },
        files: ['content/click-ring.css'],
      });
    } catch (e) {
      console.warn('[QA Tool] Could not inject content script:', e);
    }
  }
}

async function stopAndSave(filename) {
  stopTimer();
  await chrome.storage.local.remove('exportPending');
  const { screenshots, settings, captureTarget } = await getState();

  if (captureTarget === 'screen') {
    await stopScreenCaptureSession();
  }

  if (screenshots.length === 0) {
    await setState({ isRecording: false });
    await updateBadge();
    await closeOffscreen();
    return { ok: false, reason: 'No screenshots captured. Nothing to save.' };
  }

  try {
    const { sessionStartedAt, sessionStartedAtUtc } = await getState();
    const session = {
      startedAt: sessionStartedAt,
      startedAtUtc: sessionStartedAtUtc,
      endedAt: Date.now(),
      endedAtUtc: new Date().toISOString(),
    };
    const pdfDataUrl = await buildPdfViaOffscreen(screenshots, settings, session);
    await chrome.downloads.download({
      url: pdfDataUrl,
      filename: `${sanitizeFilename(filename)}.pdf`,
      saveAs: true,
    });
    await setState({ isRecording: false, screenshots: [] });
    await updateBadge();
    await closeOffscreen();
    return { ok: true, count: screenshots.length };
  } catch (e) {
    console.error('[QA Tool] PDF build failed:', e);
    return { ok: false, reason: e.message || String(e) };
  }
}

function sanitizeFilename(name) {
  return (name || 'QA-Report').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

async function discardSession() {
  stopTimer();
  await chrome.storage.local.remove('exportPending');
  const { captureTarget } = await getState();
  if (captureTarget === 'screen') {
    await stopScreenCaptureSession();
  }
  await setState({ isRecording: false, screenshots: [] });
  await updateBadge();
  await closeOffscreen();
}

// ---------- Offscreen document lifecycle ----------

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

async function hasOffscreen() {
  if (!chrome.offscreen) return false;
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS', 'USER_MEDIA'],
      justification: 'Build PDF with jsPDF and stitch full-page screenshots.',
    });
  }
  for (let i = 0; i < 40; i++) {
    try {
      const pong = await sendToOffscreen({ type: 'PING_OFFSCREEN' });
      if (pong && pong.ok) return;
    } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error('Offscreen document did not become ready.');
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (e) {
    // Ignore.
  }
}

async function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

async function buildPdfViaOffscreen(screenshots, settings, session) {
  await ensureOffscreen();
  const response = await sendToOffscreen({
    type: 'BUILD_PDF_OFFSCREEN',
    screenshots,
    settings,
    session,
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || 'PDF builder did not respond.');
  }
  return response.dataUrl;
}

// ---------- Capture pipeline ----------

function captureGapMs(captureTarget) {
  return captureTarget === 'screen' ? SCREEN_CAPTURE_GAP_MS : MIN_CAPTURE_GAP_MS;
}

async function signalCapturePending(captureTarget) {
  await chrome.storage.local.set({ captureInProgress: Date.now() });
  if (captureTarget === 'screen') {
    await flashBadge('…', 1200, '#3b82f6');
    try {
      await chrome.action.setTitle({ title: 'ScreenClick — capturing…' });
    } catch { /* ignore */ }
    if (launcherPort) {
      try {
        launcherPort.postMessage({ type: 'CAPTURE_UI', phase: 'start' });
      } catch { /* disconnected */ }
    }
  }
}

async function clearCapturePending(ok, errMsg, captureTarget) {
  await chrome.storage.local.remove('captureInProgress');
  if (captureTarget === 'screen') {
    try {
      await chrome.action.setTitle({ title: 'ScreenClick' });
    } catch { /* ignore */ }
    if (launcherPort) {
      try {
        if (ok) {
          launcherPort.postMessage({ type: 'CAPTURE_UI', phase: 'done' });
        } else {
          launcherPort.postMessage({ type: 'CAPTURE_UI', phase: 'err', error: errMsg });
        }
      } catch { /* ignore */ }
    }
    if (ok) await flashBadge('✓', 700, '#16a34a');
  }
}

function captureNow(meta = {}) {
  captureChain = captureChain
    .then(() => doCapture(meta))
    .catch((e) => {
      console.warn('[QA Tool] capture chain error:', e);
    });
  return captureChain;
}

async function doCapture(meta) {
  await clearStaleCapturePending();
  const state = await getState();
  if (!state.isRecording) return;
  const { exportPending } = await chrome.storage.local.get('exportPending');
  if (exportPending) return;

  const captureTarget = state.captureTarget;
  const isScreen = captureTarget === 'screen';
  let ok = false;
  let errMsg = null;

  await signalCapturePending(captureTarget);
  try {
    const gap = captureGapMs(captureTarget) - (Date.now() - lastCaptureAt);
    if (gap > 0) await sleep(gap);

    let dataUrl = null;
    if (captureTarget === 'visible' || captureTarget === 'process') {
      dataUrl = await captureVisibleTab(state);
    } else if (captureTarget === 'fullpage') {
      dataUrl = await captureFullPage(state);
    } else if (isScreen) {
      dataUrl = await captureScreen(state);
    }

    if (!dataUrl) {
      errMsg = 'Capture produced no image.';
      return;
    }
    lastCaptureAt = Date.now();

    let pageUrl = meta.pageUrl;
    if (!pageUrl && state.activeTabId) {
      try {
        const t = await chrome.tabs.get(state.activeTabId);
        pageUrl = t && t.url;
      } catch { /* tab may be gone */ }
    }

    const fresh = await chrome.storage.local.get('screenshots');
    const list = fresh.screenshots || [];
    const capturedAt = Date.now();
    const record = {
      id: makeStepId(),
      dataUrl,
      timestamp: capturedAt,
      timestampUtc: new Date(capturedAt).toISOString(),
      source: meta.source || 'manual',
    };
    if (pageUrl) record.pageUrl = pageUrl;
    const normalizedLabel = normalizeProcessActionLabel(record.source, meta.actionLabel);
    if (normalizedLabel) record.actionLabel = normalizedLabel;
    if (meta.elementInfo) record.elementInfo = meta.elementInfo;

    let nextList = list;
    if (captureTarget === 'process') {
      nextList = finalizeProcessCapture(record, list, meta);
    } else {
      list.push(record);
      nextList = list;
    }

    await setState({ screenshots: nextList, lastCaptureError: null });
    await chrome.storage.local.set({ lastCaptureSuccessAt: Date.now() });
    if (captureTarget === 'process') await syncProcessStepCounter();
    await updateBadge();
    ok = true;
  } catch (e) {
    errMsg = e?.message || String(e);
    console.warn('[QA Tool] capture failed:', errMsg);
    await chrome.storage.local.set({ lastCaptureError: errMsg });
    if (isScreen) await flashBadge('ERR', 1500);
  } finally {
    await clearCapturePending(ok, errMsg, captureTarget);
  }
}

async function captureVisibleTab(state) {
  const windowId = state.activeWindowId || chrome.windows.WINDOW_ID_CURRENT;
  return chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg',
    quality: Math.round((state.settings.imageQuality || 0.8) * 100),
  });
}

async function captureFullPage(state) {
  const tabId = state.activeTabId;
  if (!tabId) throw new Error('No active tab for full-page capture.');

  // 1. Ask content script for page metrics and to scroll to top.
  const start = await chrome.tabs.sendMessage(tabId, { type: 'FULLPAGE_BEGIN' });
  if (!start || !start.ok) {
    throw new Error('Content script could not prepare full-page capture.');
  }

  const { viewportHeight, totalHeight, devicePixelRatio } = start;
  const tilesEstimated = Math.min(FULLPAGE_MAX_TILES, Math.ceil(totalHeight / viewportHeight));
  const tiles = [];

  for (let i = 0; i < tilesEstimated; i++) {
    // Tell content script to scroll to tile i and wait for settle.
    const scrollRes = await chrome.tabs.sendMessage(tabId, {
      type: 'FULLPAGE_SCROLL_TO',
      index: i,
    });
    if (!scrollRes || !scrollRes.ok) break;

    await sleep(FULLPAGE_TILE_SETTLE_MS);

    // Capture this tile via the standard visible-tab API.
    if (i > 0) {
      const gap = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
      if (gap > 0) await sleep(gap);
    }
    const tileDataUrl = await chrome.tabs.captureVisibleTab(state.activeWindowId, {
      format: 'jpeg',
      quality: Math.round((state.settings.imageQuality || 0.8) * 100),
    });
    lastCaptureAt = Date.now();

    tiles.push({
      dataUrl: tileDataUrl,
      yOffset: scrollRes.scrollY,         // CSS pixels from top of doc
      viewportHeight: scrollRes.viewportHeight,
    });

    // Stop early if we've reached the bottom (overlap unavoidable on last tile).
    if (scrollRes.atBottom) break;
  }

  // Restore scroll position.
  await chrome.tabs.sendMessage(tabId, { type: 'FULLPAGE_END' });

  if (tiles.length === 0) throw new Error('No tiles captured.');

  // Single-viewport pages: just use the one tile, no stitching needed.
  if (tiles.length === 1) return tiles[0].dataUrl;

  // Stitch via offscreen doc.
  await ensureOffscreen();
  const stitchResult = await sendToOffscreen({
    type: 'STITCH_TILES',
    tiles,
    totalHeight,
    viewportHeight,
    devicePixelRatio,
    quality: state.settings.imageQuality || 0.8,
  });
  if (!stitchResult || !stitchResult.ok) {
    throw new Error('Stitch failed: ' + (stitchResult && stitchResult.error));
  }
  return stitchResult.dataUrl;
}

async function captureScreen(state) {
  const msg = {
    type: 'CAPTURE_SCREEN_FRAME',
    quality: state.settings.imageQuality || 0.8,
  };
  let lastErr = 'Screen frame capture failed.';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(150);
    const res = await sendToLauncher(msg);
    if (res && res.ok && res.dataUrl) return res.dataUrl;
    lastErr = (res && res.error) || lastErr;
    if (res && res.error && /helper window is closed|sharing ended|not a camera/i.test(res.error)) {
      break;
    }
  }
  throw new Error(lastErr);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- Timer ----------

function startTimer(interval) {
  stopTimer();
  timerHandle = setInterval(triggerTimerCapture, interval);
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

async function triggerTimerCapture() {
  const { activeTabId: tabId, isRecording, captureTarget, settings } = await getState();
  if (!isRecording) return;
  const { exportPending } = await chrome.storage.local.get('exportPending');
  if (exportPending) return;
  if (!wantsTimerForTarget(settings, captureTarget)) return;
  // visible-tab and process modes: route through content script so the
  // green ring and (for process) the step label are produced there.
  if ((captureTarget === 'visible' || captureTarget === 'process') && tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TIMER_TRIGGER' }, { frameId: 0 });
      return;
    } catch {
      // fall through to direct capture
    }
  }
  captureNow({ source: captureTarget === 'process' ? 'process-timer' : 'timer' });
}

async function restoreOnWake() {
  await clearStaleCapturePending();
  const { isRecording, settings, captureTarget } = await getState();
  if (isRecording && wantsTimerForTarget(settings, captureTarget)) {
    startTimer(getTimerIntervalMs(settings, captureTarget));
  }
  await updateBadge();
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.target === 'offscreen' || msg.target === 'launcher')) return false;

  if (msg && msg.type === 'OFFSCREEN_READY') {
    sendResponse({ ok: true });
    return false;
  }

  (async () => {
    try {
      if (msg.type === 'START_RECORDING') {
        const result = await startRecording(msg.target, msg.screenStreamId);
        if (result && result.pending) {
          sendResponse({ ok: true, pending: true });
        } else {
          sendResponse({ ok: true });
        }
      } else if (msg.type === 'SCREEN_PICKER_RESULT') {
        try {
          await startRecording('screen', null, { launcherStreamReady: true });
          sendResponse({ ok: true });
        } catch (e) {
          await stopScreenCaptureSession();
          await clearScreenPickerContext();
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      } else if (msg.type === 'SCREEN_PICKER_CANCELLED') {
        await stopScreenCaptureSession();
        await clearScreenPickerContext();
        sendResponse({ ok: true });
      } else if (msg.type === 'SCREEN_STREAM_ENDED') {
        const { isRecording, captureTarget } = await getState();
        if (isRecording && captureTarget === 'screen') {
          await chrome.storage.local.set({
            lastCaptureError: 'Screen sharing stopped. Start Screen or Window mode again.',
          });
          await stopScreenCaptureSession();
          await setState({ isRecording: false });
          stopTimer();
          await updateBadge();
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'STOP_AND_SAVE') {
        const result = await stopAndSave(msg.filename);
        sendResponse(result);
      } else if (msg.type === 'DISCARD_SESSION') {
        await discardSession();
        sendResponse({ ok: true });
      } else if (msg.type === 'PREPARE_EXPORT') {
        await prepareExport();
        sendResponse({ ok: true });
      } else if (msg.type === 'CANCEL_EXPORT') {
        await cancelExport();
        sendResponse({ ok: true });
      } else if (msg.type === 'TOGGLE_RECORDING_SHORTCUT') {
        await handleToggleCommand();
        sendResponse({ ok: true });
      } else if (msg.type === 'UPDATE_STEP') {
        await updateStepLabel(msg.id, msg.actionLabel);
        sendResponse({ ok: true });
      } else if (msg.type === 'DELETE_STEP') {
        await deleteStep(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === 'MOVE_STEP') {
        await moveStep(msg.id, msg.direction);
        sendResponse({ ok: true });
      } else if (msg.type === 'OPEN_STEPS_PANEL') {
        await ensureStepIds();
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const t = tabs[0];
        await openStepsPanel(t && t.windowId, t && t.id);
        sendResponse({ ok: true });
      } else if (msg.type === 'MIGRATE_STEP_IDS') {
        await ensureStepIds();
        sendResponse({ ok: true });
      } else if (msg.type === 'MANUAL_CAPTURE') {
        await handleCaptureCommand({ manual: true });
        sendResponse({ ok: true });
      } else if (msg.type === 'KEYBOARD_CAPTURE_SHORTCUT') {
        await handleCaptureCommand({ manual: false });
        sendResponse({ ok: true });
      } else if (msg.type === 'CAPTURE_NOW') {
        await captureNow({
          source: msg.source,
          stepNumber: msg.stepNumber,
          actionLabel: msg.actionLabel,
          elementInfo: msg.elementInfo,
          pageUrl: msg.pageUrl,
        });
        sendResponse({ ok: true });
      } else if (msg.type === 'SETTINGS_CHANGED') {
        const { isRecording, settings, captureTarget, activeTabId } = await getState();
        if (isRecording) {
          if (wantsTimerForTarget(settings, captureTarget)) {
            startTimer(getTimerIntervalMs(settings, captureTarget));
          }
          else stopTimer();
          if (activeTabId) await pushRecordingStateToTab(activeTabId);
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.error('[QA Tool] Message handler error:', e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

// ---------- Keyboard commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'capture-screenshot') {
      await handleCaptureCommand();
    } else if (command === 'stop-and-save' || command === 'toggle-recording') {
      await handleToggleCommand();
    } else {
      console.warn('[QA Tool] unhandled command:', command);
    }
  } catch (e) {
    console.error('[QA Tool] command error:', command, e);
  }
});

function keyboardCaptureEnabled(settings, captureTarget, { manual = false } = {}) {
  if (manual) return true;
  if (captureTarget === 'screen') {
    return (settings.screenTriggers || {}).keyboard !== false;
  }
  if (captureTarget === 'process') {
    return (settings.processTriggers || {}).keyboard !== false;
  }
  return (settings.triggers || {}).keyboard !== false;
}

async function handleCaptureCommand({ manual = false } = {}) {
  const now = Date.now();
  if (now - lastKeyboardCaptureAt < KEYBOARD_CAPTURE_DEBOUNCE_MS) return;
  lastKeyboardCaptureAt = now;

  await clearStaleCapturePending();
  const { exportPending } = await chrome.storage.local.get('exportPending');
  if (exportPending) return;

  const { isRecording, activeTabId: tabId, captureTarget, settings } = await getState();
  if (!isRecording) return;
  if (!keyboardCaptureEnabled(settings, captureTarget, { manual })) return;

  if (captureTarget === 'screen') {
    if (!(await isLauncherWindowOpen())) {
      await chrome.storage.local.set({
        lastCaptureError: 'Screen helper window is closed. Keep it open (minimize is OK) while capturing.',
      });
      await flashBadge('!', 2000);
      return;
    }
    const portReady = await waitForLauncherPort();
    if (!portReady) {
      await chrome.storage.local.set({
        lastCaptureError: 'Screen helper is still connecting. Wait a moment and try again.',
      });
      await flashBadge('!', 2000);
      return;
    }
    await flashBadge('…', 500, '#3b82f6');
    captureNow({ source: manual ? 'manual' : 'keyboard' });
    return;
  }

  if ((captureTarget === 'visible' || captureTarget === 'process') && tabId) {
    if (manual) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'MANUAL_CAPTURE_TRIGGER' }, { frameId: 0 });
        return;
      } catch { /* fall through */ }
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'KEYBOARD_TRIGGER',
      }, { frameId: 0 });
      return;
    } catch { /* fall through */ }
  }
  captureNow({
    source: captureTarget === 'process'
      ? (manual ? 'manual' : 'process-keyboard')
      : (manual ? 'manual' : 'keyboard'),
  });
}

function defaultFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `QA-Report-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function handleStopAndSaveCommand() {
  const { isRecording } = await getState();
  if (!isRecording) {
    // Nothing to stop. Briefly flash the badge so the user gets feedback.
    await flashBadge('NONE');
    return;
  }
  const result = await stopAndSave(defaultFilename());
  if (result && !result.ok) {
    await flashBadge('ERR');
    console.warn('[QA Tool] stop-and-save command failed:', result.reason);
  }
}

async function handleToggleCommand() {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) return;
  lastToggleAt = now;

  const { isRecording } = await getState();
  if (isRecording) {
    await handleStopAndSaveCommand();
    return;
  }
  // Start: default to visible-tab mode since the shortcut has no UI to ask.
  try {
    await chrome.storage.local.remove('lastCaptureError');
    const result = await startRecording('visible');
    if (result && result.pending) {
      // Wouldn't happen for visible mode, but defensive.
      return;
    }
    await openStepsPanelForActiveTab();
  } catch (e) {
    const message = e?.message || String(e);
    console.warn('[QA Tool] toggle-start failed:', message);
    await chrome.storage.local.set({ lastCaptureError: message });
    await flashBadge('ERR');
  }
}

async function openStepsPanelForActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab) await openStepsPanel(tab.windowId, tab.id);
}

// Briefly show a temporary badge text, then restore the recording/idle badge.
async function flashBadge(text, holdMs = 1500, bgColor = '#f59e0b') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: bgColor });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => updateBadge().catch(() => {}), holdMs);
  } catch {}
}

// ---------- Lifecycle ----------

async function warnIfShortcutsUnassigned() {
  try {
    const commands = await chrome.commands.getAll();
    const missing = commands.filter((c) => !c.shortcut);
    if (!missing.length) {
      await chrome.storage.local.set({ shortcutsNeedSetup: false });
      return;
    }
    await chrome.storage.local.set({ shortcutsNeedSetup: true });
    await flashBadge('⌨', 6000, '#f59e0b');
    console.warn(
      '[QA Tool] Keyboard shortcuts not assigned in Chrome. Open chrome://extensions/shortcuts and set:',
      missing.map((c) => c.name).join(', '),
    );
  } catch { /* ignore */ }
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('settings');
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  if (chrome.sidePanel) {
    try {
      await ensureSidePanelEnabled();
      if (chrome.sidePanel.setPanelBehavior) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
    } catch { /* older Chrome */ }
  }
  await warnIfShortcutsUnassigned();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { isRecording } = await getState();
  if (isRecording) await pushRecordingStateToTab(tabId);
});

chrome.runtime.onStartup.addListener(restoreOnWake);
restoreOnWake();
