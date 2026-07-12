// High-level composer delivery. Text must travel through xterm's paste path so
// the active TUI receives a real bracketed-paste event when it requested one;
// Enter is sent separately only after the paste was accepted.
export const CR = String.fromCharCode(13);

export function stripTrailingNewlines(value) {
  const text = String(value || '');
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code === 10 || code === 13) end -= 1;
    else break;
  }
  return text.slice(0, end);
}

export function createComposerSubmitter({ isReady, paste, send }) {
  return (text) => {
    if (!text || !isReady()) return false;
    try {
      // paste() is deliberately separate from send(CR): agent TUIs can otherwise
      // absorb Enter into their non-bracketed paste-burst detector.
      if (paste(text) === false || !isReady()) return false;
      return send(CR) !== false;
    } catch (_) {
      return false;
    }
  };
}
