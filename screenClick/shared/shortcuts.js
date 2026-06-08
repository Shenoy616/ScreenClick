// Shared capture shortcut: Shift+Command+2 (Mac) / Shift+Ctrl+2 (Windows).
(function (root) {
  const IS_MAC = (() => {
    const data = navigator.userAgentData;
    if (data && data.platform) return /mac/i.test(data.platform);
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  })();

  function isCaptureShortcutKey(e) {
    if (!e || e.repeat) return false;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod || !e.shiftKey || e.altKey) return false;
    return e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2';
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

  root.ScreenClickShortcuts = {
    isCaptureShortcutKey,
    isEditableTarget,
    requestKeyboardCapture,
    modKeyLabel: IS_MAC ? 'Command' : 'Control',
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
