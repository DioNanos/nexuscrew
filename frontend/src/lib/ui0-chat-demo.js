// UI-0 demo flag. OFF by default: the only way to turn it on is a build-time
// environment variable. There is no runtime override in the bundle.

export function ui0ChatEnabled(env) {
  try {
    const source = env || (typeof import.meta !== 'undefined' ? import.meta.env : null);
    return source?.VITE_UI0_CHAT_DEMO === '1';
  } catch {
    return false;
  }
}

export function ui0DemoRequested(search) {
  try {
    return new URLSearchParams(search || '').get('ui0') === '1';
  } catch {
    return false;
  }
}
