// Resolver unico per il titolo visibile di una cella (Tranche D, piano 0.8.27).
//
// Il titolo visibile di una cella gestita deriva SEMPRE dal campo Fleet
// `cell` (es. `Dev`). Per una sessione tmux unmanaged il fallback e' il nome
// della sessione. Route, nome nodo e tmuxSession restano identita' tecniche
// (drag/drop, attach WS, deck, ACL, files) e NON vengono concatenati al
// titolo visibile: non si fa stripping ingenuo del prefisso `cloud-`.
//
// Il resolver e' puro e side-effect free: lavora sul roster Fleet gia'
// caricato (celle locali + gruppi per-nodo) oppure su una cella Fleet gia'
// risolta dal chiamante. Nessuna fetch per-tile: la SingleView puo' riusare
// la propria lookup fleetStatus passando la `cell` trovata.

// Trova la cella Fleet che gestisce una sessione tmux a partire dalle
// identita' stabili del tile (route + ownerId) e dal roster caricato.
// Ritorna null se la sessione non e' gestita dalla flotta.
//
//   - node == null/''  -> lookup locale: prima cella con tmuxSession === session.
//   - node presente    -> lookup nel gruppo remoto la cui route (join '/)')
//                         coincide con node; ownerId (instanceId del proprietario)
//                         funge da tiebreaker cosicche' celle omonime su route
//                         o owner diversi restino distinte (Gate D).
export function findManagedCell({ session, node, ownerId, cells, nodeGroups } = {}) {
  const name = typeof session === 'string' ? session : '';
  if (!name) return null;
  if (node) {
    const groups = Array.isArray(nodeGroups) ? nodeGroups : [];
    for (const g of groups) {
      if (!g) continue;
      const route = Array.isArray(g.route) ? g.route : [];
      if (route.join('/') !== node) continue;
      if (ownerId && g.instanceId && String(ownerId) !== String(g.instanceId)) continue;
      const found = (Array.isArray(g.cells) ? g.cells : []).find((c) => c && c.tmuxSession === name);
      if (found) return found;
    }
    return null;
  }
  const local = Array.isArray(cells) ? cells : [];
  return local.find((c) => c && c.tmuxSession === name) || null;
}

// Titolo visibile di un tile/cella, applicato a celle locali, direct e routed.
//
//   - `cell` gia' risolta (SingleView che riutilizza la lookup fleetStatus):
//     usa direttamente cell.cell.
//   - altrimenti risolve dal roster passato (GridTile via GridView/App): cerca
//     la cella gestita per (node/ownerId, tmuxSession).
//   - nessuna cella gestita trovata: ritorna il nome sessione tmux (fallback
//     per sessioni unmanaged).
//
// `session` e' sempre la tmuxSession reale usata per l'attach al PTY: viene
// sostituita SOLO come etichetta visibile, mai come identita' del tile.
export function cellDisplayName({ session, cell, node, ownerId, cells, nodeGroups } = {}) {
  const name = typeof session === 'string' ? session : '';
  if (cell && typeof cell.cell === 'string' && cell.cell) return cell.cell;
  const found = findManagedCell({ session: name, node, ownerId, cells, nodeGroups });
  return found && found.cell ? found.cell : name;
}
