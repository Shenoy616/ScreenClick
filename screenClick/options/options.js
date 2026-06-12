globalThis.ScreenClickTheme?.applyStoredTheme();
globalThis.ScreenClickTheme?.listenThemeChanges();
globalThis.ScreenClickTheme?.bindThemeToggle(document.getElementById('theme-toggle'));

(function buildShortcutChips() {
  globalThis.ScreenClickShortcuts?.applyShortcutLabels?.();
  const hint = document.getElementById('shortcut-platform-hint');
  if (hint && globalThis.ScreenClickShortcuts) {
    const sc = globalThis.ScreenClickShortcuts;
    hint.textContent = sc.isMac
      ? 'On Mac use Cmd+Shift+1 and Cmd+Shift+2 (set in chrome://extensions/shortcuts if needed). Toggle-start defaults to Visible Tab; use the side panel to pick Process Record or Screen mode.'
      : 'On Windows use Ctrl+Shift+1 and Ctrl+Shift+2 (set in chrome://extensions/shortcuts if needed). Toggle-start defaults to Visible Tab; use the side panel to pick Process Record or Screen mode.';
  }
})();

const DEFAULTS = {
  triggers: { click: true, keyboard: true, timer: false },
  screenTriggers: { keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  screenTimerInterval: 10000,
  processTimerInterval: 10000,
  imageQuality: 0.8,
};

const els = {
  click: document.getElementById('trigger-click'),
  kbd: document.getElementById('trigger-keyboard'),
  tmr: document.getElementById('trigger-timer'),
  timerConfig: document.getElementById('timer-config'),
  interval: document.getElementById('timer-interval'),
  quality: document.getElementById('image-quality'),
  qualityVal: document.getElementById('image-quality-value'),
  saveBtn: document.getElementById('save-btn'),
  saveStatus: document.getElementById('save-status'),
  openShortcuts: document.getElementById('open-shortcuts'),
  procClick: document.getElementById('proc-click'),
  procOnlyInteractive: document.getElementById('proc-only-interactive'),
  procInputChange: document.getElementById('proc-input-change'),
  procKeyboard: document.getElementById('proc-keyboard'),
  procTimer: document.getElementById('proc-timer'),
  procTimerConfig: document.getElementById('proc-timer-config'),
  procInterval: document.getElementById('proc-timer-interval'),
  screenKbd: document.getElementById('screen-keyboard'),
  screenTmr: document.getElementById('screen-timer'),
  screenTimerConfig: document.getElementById('screen-timer-config'),
  screenInterval: document.getElementById('screen-timer-interval'),
};

function clampIntervalSec(raw) {
  return Math.min(600, Math.max(2, parseInt(raw, 10) || 10));
}

function updateTimerConfigVisibility() {
  if (els.timerConfig) {
    els.timerConfig.classList.toggle('hidden', !els.tmr.checked);
  }
  if (els.screenTimerConfig) {
    els.screenTimerConfig.classList.toggle('hidden', !els.screenTmr.checked);
  }
  if (els.procTimerConfig) {
    els.procTimerConfig.classList.toggle('hidden', !els.procTimer.checked);
  }
}

async function load() {
  const data = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(data.settings || {}) };
  s.triggers = { ...DEFAULTS.triggers, ...(s.triggers || {}) };
  s.screenTriggers = { ...DEFAULTS.screenTriggers, ...(s.screenTriggers || {}) };
  s.processTriggers = { ...DEFAULTS.processTriggers, ...(s.processTriggers || {}) };
  s.processOptions = { ...DEFAULTS.processOptions, ...(s.processOptions || {}) };

  els.click.checked = s.triggers.click ?? s.triggers.doubleClick ?? true;
  els.kbd.checked = s.triggers.keyboard;
  els.tmr.checked = s.triggers.timer;
  els.interval.value = Math.round(s.timerInterval / 1000);
  els.quality.value = s.imageQuality;
  els.qualityVal.textContent = s.imageQuality.toFixed(2);

  els.procClick.checked = s.processTriggers.click;
  els.procOnlyInteractive.checked = s.processOptions.onlyInteractive;
  els.procInputChange.checked = s.processTriggers.inputChange;
  els.procKeyboard.checked = s.processTriggers.keyboard;
  els.procTimer.checked = s.processTriggers.timer;

  els.screenKbd.checked = s.screenTriggers.keyboard !== false;
  els.screenTmr.checked = !!s.screenTriggers.timer;
  const screenSec = s.screenTimerInterval || s.timerInterval || DEFAULTS.screenTimerInterval;
  els.screenInterval.value = Math.round(screenSec / 1000);
  const procSec = s.processTimerInterval || s.timerInterval || DEFAULTS.processTimerInterval;
  els.procInterval.value = Math.round(procSec / 1000);

  updateTimerConfigVisibility();
}

async function save() {
  const settings = {
    triggers: {
      click: els.click.checked,
      keyboard: els.kbd.checked,
      timer: els.tmr.checked,
    },
    screenTriggers: {
      keyboard: els.screenKbd.checked,
      timer: els.screenTmr.checked,
    },
    processTriggers: {
      click: els.procClick.checked,
      inputChange: els.procInputChange.checked,
      keyboard: els.procKeyboard.checked,
      timer: els.procTimer.checked,
    },
    processOptions: {
      onlyInteractive: els.procOnlyInteractive.checked,
      debounceMs: 250,
    },
    timerInterval: clampIntervalSec(els.interval.value) * 1000,
    screenTimerInterval: clampIntervalSec(els.screenInterval.value) * 1000,
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

els.tmr.addEventListener('change', updateTimerConfigVisibility);
els.screenTmr.addEventListener('change', updateTimerConfigVisibility);
els.procTimer.addEventListener('change', updateTimerConfigVisibility);

els.saveBtn.addEventListener('click', save);

els.openShortcuts.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.theme) return;
  const next = changes.theme.newValue;
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
});

load();
