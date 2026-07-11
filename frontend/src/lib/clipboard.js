export async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value); return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = value; ta.readOnly = true;
    ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (ok) return true;
  } catch (_) {}
  return false;
}
