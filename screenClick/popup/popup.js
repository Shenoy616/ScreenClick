// Popup. State machine across: idle → target picker → recording → filename → idle.

// Apply theme as early as possible to avoid flash of wrong theme on open.
(async () => {
  try {
    const { theme } = await chrome.storage.local.get('theme');
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch {}
})();

// Platform detection for shortcut display.
// Chrome maps "Ctrl" → "Cmd" automatically on macOS for the actual binding,
// but we still need to show the right modifier in the UI.
const IS_MAC = (() => {
  const data = navigator.userAgentData;
  if (data && data.platform) return /mac/i.test(data.platform);
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
})();

const MOD_KEY_LABEL = IS_MAC ? 'Command' : 'Control';
const CAPTURE_SHORTCUT = `Shift-${MOD_KEY_LABEL}+S`;

// Populate each shortcut chip with full text like "Shift-Command+1".
document.querySelectorAll('.shortcut-chip').forEach((el) => {
  const key = el.getAttribute('data-key');
  if (!key) return;
  el.textContent = `Shift-${MOD_KEY_LABEL}+${key}`;
});

const els = {
  startBtn: document.getElementById('start-btn'),
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
  modeIndicator: document.getElementById('mode-indicator'),
  modeValue: document.getElementById('mode-value'),
};

const DEFAULT_SETTINGS = {
  triggers: { doubleClick: true, keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  imageQuality: 0.8,
};

const TARGET_LABELS = {
  visible: 'Visible Tab',
  process: 'Process Record',
  fullpage: 'Full Page',
  screen: 'Entire Screen',
};

let savingPdf = false;

async function getState() {
  const data = await chrome.storage.local.get([
    'isRecording', 'screenshots', 'settings', 'captureTarget',
  ]);
  return {
    isRecording: !!data.isRecording,
    screenshotCount: (data.screenshots || []).length,
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    captureTarget: data.captureTarget || 'visible',
  };
}

function renderTriggers(settings, target) {
  if (target === 'process') {
    const p = settings.processTriggers || { click: true, inputChange: false, keyboard: false, timer: false };
    const items = [
      { label: 'Click on interactive elements', on: p.click },
      { label: 'Form input fill (blur, idle, Enter)', on: p.inputChange },
      { label: `Keyboard (${CAPTURE_SHORTCUT})`, on: p.keyboard },
      { label: `Timer (every ${Math.round(settings.timerInterval / 1000)}s)`, on: p.timer },
    ];
    els.triggerList.innerHTML = items
      .map((i) => `<div class="trigger-item ${i.on ? '' : 'off'}">${i.label}</div>`)
      .join('');
    return;
  }
  const t = settings.triggers;
  const dblActive = t.doubleClick && target === 'visible';
  const items = [
    { label: target === 'visible' ? 'Double-click' : 'Double-click (visible tab only)', on: dblActive },
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

  if (state.isRecording) {
    els.startBtn.classList.add('hidden');
    els.stopBtn.classList.remove('hidden');
    els.discardBtn.classList.remove('hidden');
    els.counterSection.classList.remove('hidden');
    els.counter.textContent = state.screenshotCount;
    els.modeIndicator.classList.remove('hidden');
    els.modeValue.textContent = TARGET_LABELS[state.captureTarget] || 'Visible Tab';
  } else {
    els.startBtn.classList.remove('hidden');
    els.stopBtn.classList.add('hidden');
    els.discardBtn.classList.add('hidden');
    els.modeIndicator.classList.add('hidden');
    if (state.screenshotCount > 0) {
      els.counterSection.classList.remove('hidden');
      els.counter.textContent = state.screenshotCount;
    } else {
      els.counterSection.classList.add('hidden');
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

function showTargetPicker() {
  clearError();
  els.targetPicker.classList.remove('hidden');
  els.primaryActions.classList.add('hidden');
  els.infoPanel.classList.add('hidden');
}

function hideTargetPicker() {
  els.targetPicker.classList.add('hidden');
  els.primaryActions.classList.remove('hidden');
  els.infoPanel.classList.remove('hidden');
}

function showFilenameInput() {
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
  els.infoPanel.classList.remove('hidden');
  render();
}

els.startBtn.addEventListener('click', () => {
  showTargetPicker();
});

els.targetCancel.addEventListener('click', () => {
  hideTargetPicker();
});

document.querySelectorAll('.target-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.target;
    btn.disabled = true;
    btn.style.opacity = '0.6';
    clearError();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        target,
      });
      if (response && response.ok) {
        // For screen mode, the SW returns ok+pending and the launcher window
        // continues the flow. We can hide the picker either way; the popup
        // will update via storage onChanged once recording actually starts.
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
  if (!confirm('Discard all screenshots from this session?')) return;
  clearError();
  await chrome.runtime.sendMessage({ type: 'DISCARD_SESSION' });
  render();
});

els.settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Theme toggle: light ⇄ dark, persisted to storage so it survives reload.
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  function refreshToggleTooltip() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.setAttribute('title', label);
    themeToggle.setAttribute('aria-label', label);
  }
  refreshToggleTooltip();
  themeToggle.addEventListener('click', async () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    refreshToggleTooltip();
    try { await chrome.storage.local.set({ theme: next }); } catch {}
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !savingPdf) render();
});

render();
