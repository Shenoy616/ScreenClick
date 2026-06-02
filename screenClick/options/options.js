// Apply persisted theme as early as possible.
(async () => {
  try {
    const { theme } = await chrome.storage.local.get('theme');
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch {}
})();

// Build shortcut chip labels using the platform-correct modifier.
(function buildShortcutChips() {
  const data = navigator.userAgentData;
  const isMac = (data && data.platform)
    ? /mac/i.test(data.platform)
    : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const mod = isMac ? 'Command' : 'Control';
  document.querySelectorAll('.shortcut-chip').forEach((el) => {
    const key = el.getAttribute('data-key');
    if (!key) return;
    el.textContent = `Shift-${mod}+${key}`;
  });
})();

const DEFAULTS = {
  triggers: { doubleClick: true, keyboard: true, timer: false },
  processTriggers: { click: true, inputChange: true, keyboard: true, timer: false },
  processOptions: { onlyInteractive: true, debounceMs: 250 },
  timerInterval: 10000,
  imageQuality: 0.8,
};

const els = {
  dbl: document.getElementById('trigger-doubleclick'),
  kbd: document.getElementById('trigger-keyboard'),
  tmr: document.getElementById('trigger-timer'),
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
};

async function load() {
  const data = await chrome.storage.local.get('settings');
  const s = { ...DEFAULTS, ...(data.settings || {}) };
  // Defensive merges so older stored settings don't break.
  s.triggers = { ...DEFAULTS.triggers, ...(s.triggers || {}) };
  s.processTriggers = { ...DEFAULTS.processTriggers, ...(s.processTriggers || {}) };
  s.processOptions = { ...DEFAULTS.processOptions, ...(s.processOptions || {}) };

  els.dbl.checked = s.triggers.doubleClick;
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
}

async function save() {
  const settings = {
    triggers: {
      doubleClick: els.dbl.checked,
      keyboard: els.kbd.checked,
      timer: els.tmr.checked,
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
    timerInterval: Math.max(2, parseInt(els.interval.value, 10) || 10) * 1000,
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

els.saveBtn.addEventListener('click', save);

els.openShortcuts.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Sync theme when toggled from popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.theme) return;
  const next = changes.theme.newValue;
  if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
});

load();
