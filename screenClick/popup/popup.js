// Popup. State machine across: idle → target picker → recording → filename → idle.

// Apply theme as early as possible to avoid flash of wrong theme on open.
globalThis.ScreenClickTheme?.applyStoredTheme();

// Platform detection for shortcut display.
// Chrome maps "Ctrl" → "Cmd" automatically on macOS for the actual binding,
// but we still need to show the right modifier in the UI.
const IS_MAC = (() => {
  const data = navigator.userAgentData;
  if (data && data.platform) return /mac/i.test(data.platform);
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
})();

const MOD_KEY_LABEL = IS_MAC ? 'Command' : 'Control';
const CAPTURE_SHORTCUT = `Shift-${MOD_KEY_LABEL}+2`;

// Populate each shortcut chip with full text like "Shift-Command+1".
document.querySelectorAll('.shortcut-chip').forEach((el) => {
  const key = el.getAttribute('data-key');
  if (!key) return;
  el.textContent = `Shift-${MOD_KEY_LABEL}+${key}`;
});

const els = {
  captureBtn: document.getElementById('capture-btn'),
  stopBtn: document.getElementById('stop-btn'),
  discardBtn: document.getElementById('discard-btn'),
  counterSection: document.getElementById('counter-section'),
  counter: document.getElementById('counter'),
  triggerList: document.getElementById('trigger-list'),
  infoPanel: document.getElementById('info-panel'),
  settingsLink: document.getElementById('settings-link'),
  errorBanner: document.getElementById('error-banner'),
  filenameSection: document.getElementById('filename-section'),
  filenameInput: document.getElementById('filename-input'),
  filenameSave: document.getElementById('filename-save'),
  filenameCancel: document.getElementById('filename-cancel'),
  targetPicker: document.getElementById('target-picker'),
  targetCancel: document.getElementById('target-cancel'),
  primaryActions: document.getElementById('primary-actions'),
};

const DEFAULT_SETTINGS = {
  triggers: { click: true, keyboard: true, timer: false },
  screenTriggers: { keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  screenTimerInterval: 10000,
  imageQuality: 0.8,
};

let savingPdf = false;
let recordingAutoCloseTimer = null;
let recordingAutoCloseEnabled = false;
let pointerOverPopup = false;
let popupWindowId = null;
let popupTabId = null;

const RECORDING_POPUP_AUTO_CLOSE_MS = 3000;

// sidePanel.open() must run synchronously on click (before any await) or Chrome blocks it.
function openSidePanelNow() {
  if (!chrome.sidePanel?.open) return;
  const opts = popupTabId != null
    ? { tabId: popupTabId }
    : popupWindowId != null
      ? { windowId: popupWindowId }
      : null;
  if (!opts) return;
  chrome.sidePanel.open(opts).catch((e) => {
    console.warn('[ScreenClick popup] sidePanel.open:', e?.message || e);
  });
}

function cachePopupTarget() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id != null) popupTabId = tabs[0].id;
  });
  chrome.windows.getCurrent((w) => {
    if (w?.id != null) popupWindowId = w.id;
  });
}

cachePopupTarget();

function clearRecordingAutoCloseTimer() {
  if (recordingAutoCloseTimer) {
    clearTimeout(recordingAutoCloseTimer);
    recordingAutoCloseTimer = null;
  }
}

function clearRecordingAutoClose() {
  recordingAutoCloseEnabled = false;
  clearRecordingAutoCloseTimer();
}

function armRecordingAutoClose() {
  if (!recordingAutoCloseEnabled || pointerOverPopup || recordingAutoCloseTimer) return;
  recordingAutoCloseTimer = setTimeout(() => {
    recordingAutoCloseTimer = null;
    if (pointerOverPopup) {
      armRecordingAutoClose();
      return;
    }
    if (recordingAutoCloseEnabled) window.close();
  }, RECORDING_POPUP_AUTO_CLOSE_MS);
}

function scheduleRecordingAutoClose() {
  if (!els.filenameSection.classList.contains('hidden')) return;
  recordingAutoCloseEnabled = true;
  armRecordingAutoClose();
}

document.body.addEventListener('mouseenter', () => {
  pointerOverPopup = true;
  clearRecordingAutoCloseTimer();
});

document.body.addEventListener('mouseleave', () => {
  pointerOverPopup = false;
  armRecordingAutoClose();
});

async function getState() {
  const data = await chrome.storage.local.get([
    'isRecording', 'screenshots', 'settings', 'captureTarget', 'lastCaptureError',
    'captureInProgress',
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  settings.screenTriggers = { ...DEFAULT_SETTINGS.screenTriggers, ...(settings.screenTriggers || {}) };
  return {
    isRecording: !!data.isRecording,
    screenshotCount: (data.screenshots || []).length,
    settings,
    captureTarget: data.captureTarget || 'visible',
    lastCaptureError: data.lastCaptureError || null,
    captureInProgress: !!data.captureInProgress,
  };
}

function renderTriggers(settings, target) {
  if (target === 'process') {
    const p = settings.processTriggers || { click: true, inputChange: false, keyboard: false, timer: false };
    const items = [
      { label: 'Single click on interactive elements', on: p.click },
      { label: 'Form input fill (blur, idle, Enter)', on: p.inputChange },
      { label: `Keyboard (${CAPTURE_SHORTCUT})`, on: p.keyboard },
      { label: `Timer (every ${Math.round(settings.timerInterval / 1000)}s)`, on: p.timer },
    ];
    els.triggerList.innerHTML = items
      .map((i) => `<div class="trigger-item ${i.on ? '' : 'off'}">${i.label}</div>`)
      .join('');
    return;
  }
  if (target === 'screen') {
    const s = settings.screenTriggers || {};
    const sec = Math.round((settings.screenTimerInterval || settings.timerInterval) / 1000);
    const items = [
      { label: `Keyboard (${CAPTURE_SHORTCUT})`, on: s.keyboard !== false },
      { label: `Timer (every ${sec}s)`, on: !!s.timer },
      { label: 'Capture button (below)', on: true },
    ];
    els.triggerList.innerHTML = items
      .map((i) => `<div class="trigger-item ${i.on ? '' : 'off'}">${i.label}</div>`)
      .join('');
    return;
  }
  const t = settings.triggers || {};
  const clickOn = (t.click ?? t.doubleClick ?? true) && target === 'visible';
  const items = [
    { label: target === 'visible' ? 'Click' : 'Click (visible tab only)', on: clickOn },
    { label: `Keyboard (${CAPTURE_SHORTCUT})`, on: t.keyboard },
    { label: `Timer (every ${Math.round(settings.timerInterval / 1000)}s)`, on: t.timer },
  ];
  els.triggerList.innerHTML = items
    .map((i) => `<div class="trigger-item ${i.on ? '' : 'off'}">${i.label}</div>`)
    .join('');
}

async function render() {
  const state = await getState();
  renderTriggers(state.settings, state.captureTarget);

  const filenameOpen = !els.filenameSection.classList.contains('hidden');

  if (state.lastCaptureError) {
    showError(state.lastCaptureError);
  } else {
    clearError();
  }

  if (state.isRecording) {
    els.targetPicker.classList.add('hidden');
    els.primaryActions.classList.remove('hidden');
    els.infoPanel.classList.remove('hidden');
    els.captureBtn.classList.remove('hidden');
    els.stopBtn.classList.remove('hidden');
    els.discardBtn.classList.remove('hidden');
    els.counterSection.classList.remove('hidden');
    els.counterSection.classList.toggle('is-capturing', state.captureInProgress);
    els.counter.textContent = state.captureInProgress
      ? `${state.screenshotCount} …`
      : String(state.screenshotCount);
    scheduleRecordingAutoClose();
  } else {
    clearRecordingAutoClose();
    els.captureBtn.classList.add('hidden');
    els.stopBtn.classList.add('hidden');
    els.discardBtn.classList.add('hidden');
    els.infoPanel.classList.add('hidden');
    if (state.screenshotCount > 0) {
      els.counterSection.classList.remove('hidden');
      els.counter.textContent = state.screenshotCount;
    } else {
      els.counterSection.classList.add('hidden');
    }
    if (!filenameOpen) showTargetPicker();
  }
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.classList.remove('hidden');
}

function clearError() {
  els.errorBanner.classList.add('hidden');
  els.errorBanner.textContent = '';
}

function showTargetPicker() {
  clearError();
  els.targetPicker.classList.remove('hidden');
  els.primaryActions.classList.add('hidden');
  els.infoPanel.classList.add('hidden');
}

function hideTargetPicker() {
  els.targetPicker.classList.add('hidden');
  els.primaryActions.classList.remove('hidden');
}

function showFilenameInput() {
  clearRecordingAutoClose();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  els.filenameInput.value = `QA-Report-${stamp}`;
  els.filenameSection.classList.remove('hidden');
  els.primaryActions.classList.add('hidden');
  els.infoPanel.classList.add('hidden');
  setTimeout(() => { els.filenameInput.focus(); els.filenameInput.select(); }, 30);
}

function hideFilenameInput() {
  els.filenameSection.classList.add('hidden');
  els.primaryActions.classList.remove('hidden');
  render();
}

els.captureBtn.addEventListener('click', async () => {
  clearError();
  try {
    await chrome.runtime.sendMessage({ type: 'CAPTURE_NOW', source: 'manual' });
    setTimeout(render, 400);
  } catch (e) {
    showError(e.message || 'Capture failed.');
  }
});

els.targetCancel.addEventListener('click', () => {
  window.close();
});

document.querySelectorAll('.target-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    openSidePanelNow();
    btn.disabled = true;
    btn.style.opacity = '0.6';
    clearError();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        target,
      });
      if (response && response.ok) {
        hideTargetPicker();
        render();
      } else {
        showError((response && response.error) || 'Could not start recording.');
        btn.disabled = false;
        btn.style.opacity = '';
      }
    } catch (e) {
      showError(e.message || 'Could not reach extension background.');
      btn.disabled = false;
      btn.style.opacity = '';
    }
  });
});

els.stopBtn.addEventListener('click', () => {
  clearRecordingAutoClose();
  clearError();
  showFilenameInput();
});

els.filenameCancel.addEventListener('click', () => {
  hideFilenameInput();
});

els.filenameSave.addEventListener('click', async () => {
  clearError();
  const filename = els.filenameInput.value.trim() || 'QA-Report';
  els.filenameSave.disabled = true;
  els.filenameSave.textContent = 'Building...';
  savingPdf = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'STOP_AND_SAVE',
      filename,
    });
    if (response && response.ok) {
      hideFilenameInput();
    } else {
      showError((response && response.reason) || 'PDF build failed.');
      els.filenameSave.disabled = false;
      els.filenameSave.textContent = 'Save PDF';
    }
  } catch (e) {
    showError(e.message || 'PDF build failed.');
    els.filenameSave.disabled = false;
    els.filenameSave.textContent = 'Save PDF';
  } finally {
    savingPdf = false;
  }
});

els.filenameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.filenameSave.click();
  if (e.key === 'Escape') els.filenameCancel.click();
});

els.discardBtn.addEventListener('click', async () => {
  clearRecordingAutoClose();
  if (!confirm('Discard all screenshots from this session?')) return;
  clearError();
  await chrome.runtime.sendMessage({ type: 'DISCARD_SESSION' });
  render();
});

els.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

globalThis.ScreenClickTheme?.bindThemeToggle(document.getElementById('theme-toggle'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !savingPdf) {
    if (changes.lastCaptureError?.newValue) {
      showError(changes.lastCaptureError.newValue);
    }
    render();
  }
});

render();
