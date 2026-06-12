// Activation shortcut only: Cmd+Shift+1 / Ctrl+Shift+1 (start or stop capturing).
(function (root) {
  const IS_MAC = (() => {
    const data = navigator.userAgentData;
    if (data && data.platform) return /mac/i.test(data.platform);
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  })();

  const SHIFTED_DIGIT_KEYS = { 1: '!' };

  function hasShortcutModifier(e) {
    if (IS_MAC) return e.metaKey || e.ctrlKey;
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

  function requestToggleRecording() {
    try {
      chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING_SHORTCUT' });
    } catch { /* ignore */ }
  }

  // Page-level fallback when chrome.commands is not bound (common for unpacked extensions).
  function bindActivationShortcut({ allowToggle = () => true } = {}) {
    document.addEventListener('keydown', (e) => {
      if (isEditableTarget(e.target)) return;
      if (!isToggleShortcutKey(e)) return;
      if (!allowToggle()) return;
      e.preventDefault();
      e.stopPropagation();
      requestToggleRecording();
    }, true);
  }

  root.ScreenClickShortcuts = {
    isToggleShortcutKey,
    isEditableTarget,
    requestToggleRecording,
    bindActivationShortcut,
    isMac: IS_MAC,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
