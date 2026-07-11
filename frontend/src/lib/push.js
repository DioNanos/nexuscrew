// Web Push lato browser (MCP bridge): subscribe/unsubscribe con chiave VAPID
// del server. Tutto best-effort e feature-detected: dove push non e' supportato
// (context non sicuro, browser vecchi) si degrada a 'unsupported' senza errori.
import { apiFetch } from './api.js';

function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

// La applicationServerKey vuole la VAPID public key base64url come Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// Stato corrente: 'unsupported' | 'denied' | 'subscribed' | 'idle'.
export async function getPushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'idle';
  } catch (_) { return 'idle'; }
}

export async function subscribePush(token) {
  if (!pushSupported()) throw new Error('push-unsupported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('push-denied');
  const r = await apiFetch('/api/push/vapid', token);
  const { publicKey } = await r.json();
  if (!publicKey) throw new Error('vapid non disponibile');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const res = await apiFetch('/api/push/subscribe', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!res.ok) {
    // Rollback: il server non ha persistito -> niente subscription orfana.
    try { await sub.unsubscribe(); } catch (_) {}
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  return true;
}

export async function unsubscribePush(token) {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch (_) {}
  try {
    await apiFetch('/api/push/subscribe', token, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (_) { /* best-effort: il server rimuove comunque su push 404/410 */ }
  return true;
}
