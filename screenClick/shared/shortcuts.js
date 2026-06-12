// Shared shortcuts: Shift+Control+1 (toggle) and Shift+Control+2 (capture).
(function (root) {
  const IS_MAC = (() => {
    const data = navigator.userAgentData;
    if (data && data.platform) return /mac/i.test(data.platform);
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  })();

  const SHIFTED_DIGIT_KEYS = {
    1: '!',
    2: '@',
    3: '#',
    4: '$',
    5: '%',
    6: '^',
    7: '&',
    8: '*',
    9: '(',
    0: ')',
  };

  function hasShortcutModifier(e) {
    // On Mac, Chrome often registers Control+Shift for extension commands; accept Command too.
    if (IS_MAC) return e.ctrlKey || e.metaKey;
    return e.ctrlKey;
  }

  function isModShiftDigit(e, digit) {
    if (!e || e.repeat) return false;
    if (!hasShortcutModifier(e) || !e.shiftKey || e.altKey) return false;
    const key = String(digit);
    return (
      e.key === key
      || e.key === SHIFTED_DIGIT_KEYS[key]
      || e.code === `Digit${key}`
      || e.code === `Numpad${key}`
    );
  }

  function isCaptureShortcutKey(e) {
    return isModShiftDigit(e, '2');
  }

  function isToggleShortcutKey(e) {
    return isModShiftDigit(e, '1');
  }

  function isEditableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return !!el.closest?.('[contenteditable="true"]');
  }

  function requestKeyboardCapture() {
    try {
      chrome.runtime.sendMessage({ type: 'KEYBOARD_CAPTURE_SHORTCUT' });
    } catch { /* ignore */ }
  }

  function requestToggleRecording() {
    try {
      chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING_SHORTCUT' });
    } catch { /* ignore */ }
  }

  // Page-level fallback when chrome.commands shortcuts are not bound (common for unpacked extensions).
  function bindPageShortcuts({
    allowToggle = () => true,
    allowCapture = () => false,
  } = {}) {
    document.addEventListener('keydown', (e) => {
      if (isEditableTarget(e.target)) return;

      if (isToggleShortcutKey(e)) {
        if (!allowToggle()) return;
        e.preventDefault();
        e.stopPropagation();
        requestToggleRecording();
        return;
      }

      if (!allowCapture() || !isCaptureShortcutKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      requestKeyboardCapture();
    }, true);
  }

  function shortcutLabel(digit) {
    return `Shift-Control+${digit}`;
  }

  function shortcutChip(digit) {
    return IS_MAC ? `^⇧${digit}` : `Ctrl+Shift+${digit}`;
  }

  root.ScreenClickShortcuts = {
    isCaptureShortcutKey,
    isToggleShortcutKey,
    isEditableTarget,
    requestKeyboardCapture,
    requestToggleRecording,
    bindPageShortcuts,
    shortcutLabel,
    shortcutChip,
    modKeyLabel: 'Control',
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
