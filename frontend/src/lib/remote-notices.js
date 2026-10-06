// Arretrato delle notifiche importate dai feed remoti: merge puro con dedup
// per (ownerId,eventId), cap sulle piu' recenti e normalizzazione del ts.
// Funzioni pure: nulla qui tocca DOM o stato React.

export const MAX_REMOTE_NOTICES = 50;

export function normalizeTs(value) {
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function noticeKeyOf(ownerId, eventId) {
  return `${String(ownerId)}|${String(eventId)}`;
}

// Da un envelope importato alla card consultabile. Solo il tipo notificatorio
// e' ammesso e solo con un identificatore; il testo resta stringa (l'escaping
// e' del renderer React). Non-ammissibile -> null.
export function toRemoteNotice(envelope, ownerId) {
  if (!envelope || typeof envelope !== 'object') return null;
  const frame = envelope.frame && typeof envelope.frame === 'object' ? envelope.frame : envelope;
  if (frame.type !== 'notify' || !envelope.eventId) return null;
  // ASK alerts belong to the answerable card, never to the generic history.
  if (typeof frame.askId === 'string' && frame.askId) return null;
  const title = typeof frame.title === 'string' ? frame.title : '';
  const body = typeof frame.body === 'string' ? frame.body : '';
  if (!title && !body) return null;
  return {
    key: noticeKeyOf(ownerId, envelope.eventId),
    ownerId: String(ownerId),
    eventId: String(envelope.eventId),
    title,
    body,
    urgency: frame.urgency === 'high' ? 'high' : 'normal',
    ts: normalizeTs(envelope.ts),
  };
}

// Il cap tiene le card con ts piu' recente, non le ultime inserite.
export function boundedByTs(list) {
  return [...list].sort((a, b) => b.ts - a.ts).slice(0, MAX_REMOTE_NOTICES);
}

// Merge dedup: le card correnti di un owner ancora attivo (presente in
// keepOwners) sopravvivono, le incoming (dallo snapshot) aggiornano per key.
// keepOwners null = nessun owner viene scartato (arrivo dal canale live).
export function mergeRemoteNotices(current, incoming, keepOwners) {
  const merged = new Map();
  for (const c of current || []) {
    if (!keepOwners || keepOwners.has(c.ownerId)) merged.set(c.key, c);
  }
  for (const c of incoming || []) {
    if (c) merged.set(c.key, c);
  }
  return [...merged.values()];
}
