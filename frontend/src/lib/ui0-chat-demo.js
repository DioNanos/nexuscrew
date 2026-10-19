// UI-0 demo flag. OFF by default: the only way to turn it on is a build-time
// environment variable. Tests may pin it through the global override, which
// is never set by the application.
export const UI0_DEMO_PREFIX = 'ui0-demo';

export function ui0ChatEnabled(env) {
  if (typeof globalThis !== 'undefined' && typeof globalThis.__NC_UI0_CHAT_DEMO__ === 'boolean') {
    return globalThis.__NC_UI0_CHAT_DEMO__;
  }
  try {
    const source = env || (typeof import.meta !== 'undefined' ? import.meta.env : null);
    return source?.VITE_UI0_CHAT_DEMO === '1';
  } catch {
    return false;
  }
}

export function isUi0DemoSession(session) {
  return typeof session === 'string' && session.startsWith(UI0_DEMO_PREFIX);
}

export function ui0DemoRequested(search) {
  try {
    return new URLSearchParams(search || '').get('ui0') === '1';
  } catch {
    return false;
  }
}
