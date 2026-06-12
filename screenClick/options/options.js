globalThis.ScreenClickTheme?.applyStoredTheme();
globalThis.ScreenClickTheme?.listenThemeChanges();
globalThis.ScreenClickTheme?.bindThemeToggle(document.getElementById('theme-toggle'));

const DEFAULTS = {
  triggers: { click: true, keyboard: false, timer: false },
  screenTriggers: { keyboard: false, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: false, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  screenTimerInterval: 10000,
  processTimerInterval: 10000,
  imageQuality: 0.8,
};

const els = {
  quality: document.getElementById('image-quality'),
  qualityVal: document.getElementById('image-quality-value'),
  saveBtn: document.getElementById('save-btn'),
  saveStatus: document.getElementById('save-status'),
  procClick: document.getElementById('proc-click'),
  procOnlyInteractive: document.getElementById('proc-only-interactive'),
  procInputChange: document.getElementById('proc-input-change'),
  procTimer: document.getElementById('proc-timer'),
  procTimerConfig: document.getElementById('proc-timer-config'),
  procInterval: document.getElementById('proc-timer-interval'),
};

function clampIntervalSec(raw) {
  return Math.min(600, Math.max(2, parseInt(raw, 10) || 10));
}

function updateTimerConfigVisibility() {
  els.procTimerConfig.classList.toggle('hidden', !els.procTimer.checked);
}

async function load() {
  const data = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(data.settings || {}) };
  s.processTriggers = { ...DEFAULTS.processTriggers, ...(s.processTriggers || {}) };
  s.processOptions = { ...DEFAULTS.processOptions, ...(s.processOptions || {}) };

  els.quality.value = s.imageQuality;
  els.qualityVal.textContent = s.imageQuality.toFixed(2);

  els.procClick.checked = s.processTriggers.click;
  els.procOnlyInteractive.checked = s.processOptions.onlyInteractive;
  els.procInputChange.checked = s.processTriggers.inputChange;
  els.procTimer.checked = s.processTriggers.timer;

  const procSec = s.processTimerInterval || s.timerInterval || DEFAULTS.processTimerInterval;
  els.procInterval.value = Math.round(procSec / 1000);

  updateTimerConfigVisibility();
}

async function save() {
  const data = await chrome.storage.local.get('settings');
  const existing = data.settings || {};

  const settings = {
    ...DEFAULTS,
    ...existing,
    processTriggers: {
      click: els.procClick.checked,
      inputChange: els.procInputChange.checked,
      keyboard: false,
      timer: els.procTimer.checked,
    },
    processOptions: {
      onlyInteractive: els.procOnlyInteractive.checked,
      debounceMs: 250,
    },
    processTimerInterval: clampIntervalSec(els.procInterval.value) * 1000,
    imageQuality: parseFloat(els.quality.value),
  };

  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' });

  els.saveStatus.textContent = 'Saved.';
  els.saveStatus.classList.add('show');
  setTimeout(() => els.saveStatus.classList.remove('show'), 1500);
}

els.quality.addEventListener('input', () => {
  els.qualityVal.textContent = parseFloat(els.quality.value).toFixed(2);
});

els.procTimer.addEventListener('change', updateTimerConfigVisibility);

els.saveBtn.addEventListener('click', save);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.theme) return;
  const next = changes.theme.newValue;
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
});

load();
