// La fonte viva della vista VL, per le shell dove la lista dei gruppi non c'è.
//
// Su mobile `App` chiama `useNodes(token, false)`: la lista è spenta e vuota
// (`useNodes.js:106`), e la lista mobile vive dentro `SessionList`, che mentre
// la vista è a schermo pieno non è montata. Senza una fonte, la vista non può
// sapere se il nodo è ancora corrente — e con la regola «il polling si sospende
// verso un peer non corrente» resterebbe muta per sempre.
//
// Questa lettura esiste per quello, e solo per quello: UNA GET dei nodi VL
// dell'owner (la stessa che alimenta la lista), ogni quattro secondi, **mentre
// una vista è aperta**. Non è il polling completo di `useNodes` (nodi, sessioni
// remote, fleet per route): costa una richiesta leggera invece di cinque, ed è
// il motivo per cui non ho semplicemente acceso `useNodes` su mobile.
//
// Ritorna `null` finché la fonte non ha risposto almeno una volta — e `null`
// vuol dire «non lo so», non «non c'è»: la differenza la usa `risolviVlSession`.

import { useEffect, useState } from 'react';
import { getVlNodes } from '../lib/api.js';
import { vlNodeToPeer } from '../lib/vl-nodes-model.js';

export const VL_LIVE_POLL_MS = 4000;

// L'owner nella forma che `vlNodeToPeer` si aspetta — la stessa che `useNodes`
// costruisce per il nodo locale e per quelli federati (`useNodes.js:343–370`):
// `{ instanceId, route, label }`. Passargli la sola route lascia
// `ownerInstanceId` a null sul peer, e il confronto con la sessione (che
// l'owner ce l'ha, perché viene dalla lista vera) non torna mai: la vista si
// chiude su un nodo che c'è.
function ownerDi(sessione, route) {
  return {
    instanceId: typeof sessione.ownerInstanceId === 'string' ? sessione.ownerInstanceId : null,
    route,
    label: typeof sessione.ownerLabel === 'string' && sessione.ownerLabel ? sessione.ownerLabel : null,
  };
}

// La risposta dichiara CHI risponde: `instanceId` nella busta e, su ogni nodo,
// `instanceId` e un `id` owner-qualified (`lib/vl-nodes/routes.js`). Il solo
// nodeId non basta a distinguere due owner: una route riassegnata ad un altro
// owner restituirebbe lo stesso nodeId sotto un'altra identità, e l'adapter lo
// ribattezzerebbe con l'owner che ci si aspetta. Perciò la risposta vale solo
// se la fonte dichiarata è quella attesa; altrimenti — o se non dichiara nulla —
// la fonte non attesta né la presenza né l'assenza («non lo so»).
function fonteAttesa(out, atteso) {
  if (typeof atteso !== 'string' || !atteso) return false;
  if (out?.instanceId !== atteso) return false;
  const nodi = Array.isArray(out.nodes) ? out.nodes : [];
  return nodi.every((n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.instanceId !== undefined && n.instanceId !== atteso) return false;
    if (typeof n.id === 'string' && n.id.includes(':') && n.id.split(':')[0] !== atteso) return false;
    return true;
  });
}

export function useVlNodeLive(token, sessione, attivo) {
  // L'esito pubblicato porta con sé la chiave che l'ha prodotto: credenziale,
  // nodo, owner e route. Lo stato che arriva al consumatore vale solo per la
  // chiave corrente; cambiata la chiave, ciò che era stato pubblicato per la
  // vecchia non si consegna più («non lo so») finché la nuova non risponde.
  const chiave = JSON.stringify([
    token || null,
    (sessione && sessione.nodeId) || null,
    (sessione && sessione.ownerInstanceId) || null,
    Array.isArray(sessione && sessione.route) ? sessione.route : [],
  ]);
  const [esito, setEsito] = useState(null);
  useEffect(() => {
    if (!attivo || !token || !sessione || !sessione.nodeId) {
      setEsito(null);
      return undefined;
    }
    const route = Array.isArray(sessione.route) ? sessione.route : [];
    const owner = ownerDi(sessione, route);

    // La guardia nasce e muore con QUESTO effetto. Prima era un ref condiviso
    // fra gli effetti: il cleanup lo metteva a false e il nuovo effetto lo
    // riportava a true, così la risposta di un effetto morto passava il
    // controllo e scriveva nello stato di quello nuovo.
    let vivo = true;
    // I giri di questo effetto si numerano: una risposta partita prima non può
    // sovrascrivere quella partita dopo. Il periodo può scadere mentre una
    // lettura è ancora in volo, e la più vecchia può arrivare per ultima.
    let giro = 0;
    let pubblicato = 0;

    // L'unico punto che pubblica, per successi ed errori: vale la stessa
    // guardia (`seq > ultimoPubblicato`), così un errore più recente non lascia
    // a un successo più vecchio l'autorità di scavalcarlo.
    const pubblica = (seq, valore) => {
      if (!vivo || seq <= pubblicato) return;
      pubblicato = seq;
      setEsito({ chiave, seq, valore });
    };

    const leggi = async () => {
      if (!vivo) return;
      const mio = giro + 1;
      giro = mio;
      try {
        const out = await getVlNodes(token, route);
        if (!vivo || mio <= pubblicato) return;
        if (!fonteAttesa(out, sessione.ownerInstanceId)) {
          // Un'altra fonte, o una fonte che non dichiara chi è: non attesta
          // né la presenza né l'assenza.
          pubblica(mio, null);
          return;
        }
        const nodi = Array.isArray(out?.nodes) ? out.nodes : [];
        const peer = nodi
          .map((n) => vlNodeToPeer(n, owner))
          .find((p) => p && p.nodeId === sessione.nodeId
            && (p.ownerInstanceId || null) === (sessione.ownerInstanceId || null));
        // La risposta può dichiararsi una fotografia (`stale: true`): quel
        // giudizio viaggia col peer, e la vista lo mostra invece di tacerlo.
        const nonCorrente = out?.stale === true || (peer && peer.stale === true);
        pubblica(mio, {
          peer: peer ? { ...peer, stale: nonCorrente === true } : null,
          trovato: !!peer,
        });
      } catch (_) {
        // La fonte non risponde: non si afferma né la presenza né l'assenza.
        pubblica(mio, null);
      }
    };

    leggi();
    const timer = setInterval(leggi, VL_LIVE_POLL_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [token, attivo, sessione && sessione.nodeId, sessione && sessione.ownerInstanceId, JSON.stringify(sessione && sessione.route)]);

  return attivo && esito && esito.chiave === chiave ? esito.valore : null;
}
