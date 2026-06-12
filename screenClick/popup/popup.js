// Popup. State machine across: idle → target picker → recording → filename → idle.

// Apply theme as early as possible to avoid flash of wrong theme on open.
globalThis.ScreenClickTheme?.applyStoredTheme();

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
  triggers: { click: true, keyboard: false, timer: false },
  screenTriggers: { keyboard: false, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: false, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  screenTimerInterval: 10000,
  processTimerInterval: 10000,
  imageQuality: 0.8,
};

let savingPdf = false;
let popupSession = { isRecording: false, captureTarget: 'process', settings: null };
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
    console.warn('[Uni Capture popup] sidePanel.open:', e?.message || e);
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

function canAutoClosePopup() {
  if (!els.filenameSection.classList.contains('hidden')) return false;
  if (!els.targetPicker.classList.contains('hidden')) return true;
  return popupSession.isRecording;
}

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
  if (!canAutoClosePopup()) return;
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
    captureTarget: data.captureTarget || 'process',
    lastCaptureError: data.lastCaptureError || null,
    captureInProgress: !!data.captureInProgress,
  };
}

function renderTriggers(settings) {
  const p = settings.processTriggers || { click: true, inputChange: false, keyboard: false, timer: false };
  const items = [
    { label: 'Single click on interactive elements', on: p.click },
    { label: 'Form input fill (blur, idle, Enter)', on: p.inputChange },
    { label: `Timer (every ${Math.round((settings.processTimerInterval || settings.timerInterval) / 1000)}s)`, on: p.timer },
    { label: 'Capture button', on: true },
  ];
  els.triggerList.innerHTML = items
    .map((i) => `<div class="trigger-item ${i.on ? '' : 'off'}">${i.label}</div>`)
    .join('');
}

async function render() {
  const state = await getState();
  popupSession.isRecording = state.isRecording;
  popupSession.captureTarget = state.captureTarget;
  popupSession.settings = state.settings;
  renderTriggers(state.settings);

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
    if (!filenameOpen) {
      showTargetPicker();
      scheduleRecordingAutoClose();
    } else {
      clearRecordingAutoClose();
    }
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

function resetTargetButtons() {
  document.querySelectorAll('.target-btn').forEach((btn) => {
    btn.disabled = false;
    btn.style.opacity = '';
  });
}

function showTargetPicker() {
  clearError();
  resetTargetButtons();
  els.targetPicker.classList.remove('hidden');
  els.primaryActions.classList.add('hidden');
  els.infoPanel.classList.add('hidden');
  scheduleRecordingAutoClose();
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
  chrome.runtime.sendMessage({ type: 'PREPARE_EXPORT' }).catch(() => {});
  setTimeout(() => { els.filenameInput.focus(); els.filenameInput.select(); }, 30);
}

function hideFilenameInput() {
  els.filenameSection.classList.add('hidden');
  els.primaryActions.classList.remove('hidden');
  chrome.runtime.sendMessage({ type: 'CANCEL_EXPORT' }).catch(() => {});
  render();
}

els.captureBtn.addEventListener('click', async () => {
  clearError();
  try {
    await chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
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
      }
    } catch (e) {
      showError(e.message || 'Could not reach extension background.');
    } finally {
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
