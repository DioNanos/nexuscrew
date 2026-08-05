// frontend/src/lib/vl-node-detail.js — comandi e stato del foglio per un
// nodo VL. Compagno di node-detail.js, ma per i nodi VL: qui il potere non
// e' `node.actions` (deciso dal server per i peer Fleet), sono le
// `capabilities` che il DEVICE dichiara — un nodo che non dichiara un
// comando non deve avere il bottone (design NC_UI_NODI_VL, 2026-08-05).
//
// `update_candidate` e' esclusa a prescindere in questo giro: e' la
// capability per cui le route sono state tolte dalla federazione, ed e' una
// decisione a se' se e quando esporla.
const NEVER_EXPOSED = new Set(['update_candidate']);

export function vlNodeActions(node) {
  if (!node || node.kind !== 'vl') return [];
  const caps = Array.isArray(node.capabilities) ? node.capabilities : [];
  const seen = new Set();
  const out = [];
  for (const cap of caps) {
    if (typeof cap !== 'string' || !cap || NEVER_EXPOSED.has(cap) || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out;
}

// Lo stato di un comando NON torna nel POST (risponde solo {id,
// status:'submitted'}): l'esito vero arriva dopo, in `node.lastAck`, al
// prossimo poll di /api/vl-nodes; `node.inflight` dice se un comando e' in
// volo ORA. `pending` e' il comando che QUESTA sessione ha appena
// sottomesso — {id, kind, submittedAt} | null.
//
// Regola che vale su tutta la funzione: mai leggere un `lastAck` come
// l'esito di un comando diverso da quello a cui appartiene (`id`
// combacia), e mai inventare un successo prima che il server lo confermi.
export function vlCommandStatus(node, pending) {
  if (!node) return null;
  // Un comando in volo e' lo stato piu' fresco che il server conosce,
  // indipendentemente da chi l'ha sottomesso: vince su tutto il resto.
  if (node.inflight && typeof node.inflight === 'object') {
    return { phase: 'inflight', kind: node.inflight.kind };
  }
  if (pending) {
    if (node.lastAck && node.lastAck.id === pending.id) {
      return {
        phase: 'done', kind: pending.kind,
        status: node.lastAck.status, result: node.lastAck.result, at: node.lastAck.at,
      };
    }
    // Nessun inflight, nessun ack per QUESTO id: inviato, non ancora fatto —
    // anche se esiste un lastAck, appartiene a un comando precedente.
    return { phase: 'submitted', kind: pending.kind };
  }
  if (node.lastAck && typeof node.lastAck === 'object') {
    return {
      phase: 'done', kind: null,
      status: node.lastAck.status, result: node.lastAck.result, at: node.lastAck.at,
    };
  }
  return null;
}
