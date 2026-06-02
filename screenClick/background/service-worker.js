// Service worker. Manifest V3.
// Responsibilities: session state, capture orchestration for three target
// modes (visible tab, full page, entire screen), timer, keyboard command,
// offscreen document lifecycle, downloads, badge updates.

const DEFAULT_SETTINGS = {
  triggers: { doubleClick: true, keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  imageQuality: 0.8,
  includeTimestamp: true,
};

// Chrome rate-limits captureVisibleTab to ~2/sec. Keep a serialized queue
// with a minimum inter-capture gap.
const MIN_CAPTURE_GAP_MS = 600;
// Settling time per full-page scroll tile, lets animations/lazy-load settle.
const FULLPAGE_TILE_SETTLE_MS = 280;
// Max number of tiles for a full-page capture (safety cap on infinite pages).
const FULLPAGE_MAX_TILES = 30;

let timerHandle = null;
let captureChain = Promise.resolve();
let lastCaptureAt = 0;

// ---------- State helpers ----------

async function getState() {
  const data = await chrome.storage.local.get([
    'isRecording', 'screenshots', 'settings',
    'activeTabId', 'activeWindowId', 'captureTarget',
  ]);
  return {
    isRecording: !!data.isRecording,
    screenshots: data.screenshots || [],
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    activeTabId: data.activeTabId || null,
    activeWindowId: data.activeWindowId || null,
    captureTarget: data.captureTarget || 'visible',
  };
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

async function startRecording(target, screenStreamId) {
  target = target || 'visible';
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error('No active tab.');

  // Visible-tab and full-page require a normal http/https page.
  if (target !== 'screen') {
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('https://chromewebstore.google.com')) {
      throw new Error('Cannot capture this page. Open a regular http/https page first.');
    }
  }

  // Screen mode: if we don't have a stream ID yet, open the launcher
  // window which will show the picker, then call us back via
  // SCREEN_PICKER_RESULT. Return early; the launcher restarts this flow.
  if (target === 'screen' && !screenStreamId) {
    await openScreenLauncher();
    return { pending: true };
  }

  await setState({
    isRecording: true,
    screenshots: [],
    activeTabId: tab.id,
    activeWindowId: tab.windowId,
    captureTarget: target,
    sessionStartedAt: Date.now(),
  });

  const { settings } = await getState();
  const wantsTimer = target === 'process'
    ? !!(settings.processTriggers && settings.processTriggers.timer)
    : !!settings.triggers.timer;
  if (wantsTimer) startTimer(settings.timerInterval);
  await updateBadge();

  if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    await ensureContentScript(tab.id);
  }

  if (target === 'fullpage') {
    await ensureOffscreen();
    await sendToOffscreen({ type: 'RESET_STITCH_BUFFER' });
  }
  if (target === 'screen') {
    await ensureOffscreen();
    const r = await sendToOffscreen({ type: 'START_SCREEN_STREAM', streamId: screenStreamId });
    if (!r || !r.ok) {
      await discardSession();
      throw new Error('Failed to start screen stream: ' + (r && r.error));
    }
  }

  return { ok: true };
}

async function openScreenLauncher() {
  await chrome.windows.create({
    url: chrome.runtime.getURL('launcher/launcher.html'),
    type: 'popup',
    width: 480,
    height: 220,
    focused: true,
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/content.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/click-ring.css'],
      });
    } catch (e) {
      console.warn('[QA Tool] Could not inject content script:', e);
    }
  }
}

async function stopAndSave(filename) {
  stopTimer();
  const { screenshots, settings, captureTarget } = await getState();

  // Stop screen stream and clean up offscreen state if applicable.
  if (captureTarget === 'screen') {
    try { await sendToOffscreen({ type: 'STOP_SCREEN_STREAM' }); } catch {}
  }

  if (screenshots.length === 0) {
    await setState({ isRecording: false });
    await updateBadge();
    await closeOffscreen();
    return { ok: false, reason: 'No screenshots captured. Nothing to save.' };
  }

  try {
    const pdfDataUrl = await buildPdfViaOffscreen(screenshots, settings);
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
  const { captureTarget } = await getState();
  if (captureTarget === 'screen') {
    try { await sendToOffscreen({ type: 'STOP_SCREEN_STREAM' }); } catch {}
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
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS', 'USER_MEDIA'],
    justification: 'Build PDF with jsPDF, stitch full-page screenshots, and capture screen streams.',
  });
  // Wait briefly for the document to be ready.
  await sleep(50);
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

async function buildPdfViaOffscreen(screenshots, settings) {
  await ensureOffscreen();
  const response = await sendToOffscreen({
    type: 'BUILD_PDF_OFFSCREEN',
    screenshots,
    settings,
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || 'PDF builder did not respond.');
  }
  return response.dataUrl;
}

// ---------- Capture pipeline ----------

function captureNow(meta = {}) {
  captureChain = captureChain.then(() => doCapture(meta)).catch((e) => {
    console.warn('[QA Tool] capture chain error:', e);
  });
  return captureChain;
}

async function doCapture(meta) {
  const state = await getState();
  if (!state.isRecording) return;

  // Respect inter-capture rate-limit gap.
  const wait = MIN_CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);

  let dataUrl = null;
  try {
    if (state.captureTarget === 'visible' || state.captureTarget === 'process') {
      dataUrl = await captureVisibleTab(state);
    } else if (state.captureTarget === 'fullpage') {
      dataUrl = await captureFullPage(state);
    } else if (state.captureTarget === 'screen') {
      dataUrl = await captureScreen(state);
    }
  } catch (e) {
    console.warn('[QA Tool] capture failed:', e?.message || e);
    return;
  }

  if (!dataUrl) return;
  lastCaptureAt = Date.now();

  // Resolve the page URL: content script supplies it when capture is
  // triggered there. For SW-initiated paths (e.g. timer fallback in screen
  // mode), look up the active tab's URL.
  let pageUrl = meta.pageUrl;
  if (!pageUrl && state.activeTabId) {
    try {
      const t = await chrome.tabs.get(state.activeTabId);
      pageUrl = t && t.url;
    } catch { /* tab may be gone */ }
  }

  const fresh = await chrome.storage.local.get('screenshots');
  const list = fresh.screenshots || [];
  const record = {
    dataUrl,
    timestamp: Date.now(),
    source: meta.source || 'manual',
  };
  if (pageUrl) record.pageUrl = pageUrl;
  // Carry process-record metadata if present.
  if (meta.stepNumber) record.stepNumber = meta.stepNumber;
  if (meta.actionLabel) record.actionLabel = meta.actionLabel;
  if (meta.elementInfo) record.elementInfo = meta.elementInfo;
  list.push(record);
  await setState({ screenshots: list });
  await updateBadge();
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
  await ensureOffscreen();
  const res = await sendToOffscreen({
    type: 'CAPTURE_SCREEN_FRAME',
    quality: state.settings.imageQuality || 0.8,
  });
  if (!res || !res.ok) {
    throw new Error('Screen frame capture failed: ' + (res && res.error));
  }
  return res.dataUrl;
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
  const { activeTabId: tabId, isRecording, captureTarget } = await getState();
  if (!isRecording) return;
  // visible-tab and process modes: route through content script so the
  // green ring and (for process) the step label are produced there.
  if ((captureTarget === 'visible' || captureTarget === 'process') && tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'TIMER_TRIGGER' });
      return;
    } catch {
      // fall through to direct capture
    }
  }
  captureNow({ source: 'timer' });
}

async function restoreOnWake() {
  const { isRecording, settings, captureTarget } = await getState();
  const wantsTimer = captureTarget === 'process'
    ? !!(settings.processTriggers && settings.processTriggers.timer)
    : !!settings.triggers.timer;
  if (isRecording && wantsTimer) startTimer(settings.timerInterval);
  await updateBadge();
}

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === 'offscreen') return false;

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
        await startRecording('screen', msg.streamId);
        sendResponse({ ok: true });
      } else if (msg.type === 'SCREEN_PICKER_CANCELLED') {
        sendResponse({ ok: true });
      } else if (msg.type === 'STOP_AND_SAVE') {
        const result = await stopAndSave(msg.filename);
        sendResponse(result);
      } else if (msg.type === 'DISCARD_SESSION') {
        await discardSession();
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
        const { isRecording, settings, captureTarget } = await getState();
        if (isRecording) {
          const wantsTimer = captureTarget === 'process'
            ? !!(settings.processTriggers && settings.processTriggers.timer)
            : !!settings.triggers.timer;
          if (wantsTimer) startTimer(settings.timerInterval);
          else stopTimer();
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
    } else if (command === 'stop-and-save') {
      await handleStopAndSaveCommand();
    } else if (command === 'toggle-recording') {
      await handleToggleCommand();
    }
  } catch (e) {
    console.error('[QA Tool] command error:', command, e);
  }
});

async function handleCaptureCommand() {
  const { isRecording, activeTabId: tabId, captureTarget } = await getState();
  if (!isRecording) return;
  if ((captureTarget === 'visible' || captureTarget === 'process') && tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'KEYBOARD_TRIGGER' });
      return;
    } catch { /* fall through */ }
  }
  captureNow({ source: 'keyboard' });
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
  const { isRecording } = await getState();
  if (isRecording) {
    await handleStopAndSaveCommand();
    return;
  }
  // Start: default to visible-tab mode since the shortcut has no UI to ask.
  try {
    const result = await startRecording('visible');
    if (result && result.pending) {
      // Wouldn't happen for visible mode, but defensive.
      return;
    }
  } catch (e) {
    console.warn('[QA Tool] toggle-start failed:', e?.message || e);
    await flashBadge('ERR');
  }
}

// Briefly show a temporary badge text, then restore the recording/idle badge.
async function flashBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => updateBadge().catch(() => {}), 1500);
  } catch {}
}

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get('settings');
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onStartup.addListener(restoreOnWake);
restoreOnWake();
