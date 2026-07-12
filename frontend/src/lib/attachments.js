import { apiFetch, routeBase } from './api.js';

const EXTENSIONS = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
  ['image/webp', 'webp'], ['application/pdf', 'pdf'], ['text/plain', 'txt'],
]);

export function hasFilePayload(transfer) {
  if (!transfer) return false;
  if (transfer.files && transfer.files.length > 0) return true;
  if (Array.from(transfer.items || []).some((item) => item && item.kind === 'file')) return true;
  return Array.from(transfer.types || []).includes('Files');
}

export function filesFromTransfer(transfer) {
  if (!transfer) return [];
  const direct = Array.from(transfer.files || []).filter(Boolean);
  if (direct.length) return direct;
  return Array.from(transfer.items || [])
    .filter((item) => item && item.kind === 'file' && typeof item.getAsFile === 'function')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

export function attachmentName(file, index = 0, now = Date.now()) {
  const existing = String(file?.name || '').trim();
  if (existing) return existing;
  const ext = EXTENSIONS.get(String(file?.type || '').toLowerCase()) || 'bin';
  return `clipboard-${now}-${index + 1}.${ext}`;
}

// Uploads continue after an individual error so a multi-file drop is never
// silently truncated. `paste=true` asks the server to inject each saved path
// into the PTY without an Enter; composer attachments use paste=false.
export async function uploadSessionFiles({
  files, token, session, node = '', paste = true, fetchImpl = apiFetch, onProgress = () => {}, now = Date.now(),
} = {}) {
  const list = Array.from(files || []).filter(Boolean);
  const paths = []; const errors = [];
  if (!session || !list.length) return { paths, errors };
  const base = routeBase(node ? String(node).split('/') : []);
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    const name = attachmentName(file, index, now);
    onProgress({ index, total: list.length, name, state: 'uploading' });
    try {
      const body = new FormData();
      body.append('session', session);
      body.append('paste', paste ? 'true' : 'false');
      body.append('file', file, name);
      const response = await fetchImpl(`${base}/files/upload`, token, { method: 'POST', body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.error) throw new Error(result.error || `HTTP ${response.status}`);
      paths.push(result.path);
      onProgress({ index, total: list.length, name, state: 'done', path: result.path });
    } catch (error) {
      const message = String(error?.message || error);
      errors.push({ name, message });
      onProgress({ index, total: list.length, name, state: 'error', error: message });
    }
  }
  return { paths, errors };
}
