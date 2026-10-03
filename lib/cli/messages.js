'use strict';
// Messaggi per chi sta al terminale (o legge il log del servizio) quando la porta e' occupata. Il nodo NON si sposta
// piu' da solo su un'altra porta: dev'essere chiaro cosa fare. Lingue: it, en, es. Se la lingua non si puo'
// determinare (servizio senza LANG) escono tutte e tre, una per riga: cosi' si legge comunque.
const LANGS = ['it', 'en', 'es'];

const WHY = {
  en: 'A new port is a new address: the installed app would lose its token and settings.',
  it: 'Una porta nuova è un indirizzo nuovo: l\'app installata perderebbe token e impostazioni.',
  es: 'Un puerto nuevo es una dirección nueva: la app instalada perdería el token y los ajustes.',
};

const CATALOG = {
  'busy-other': {
    en: ({ port }) => `Port ${port} is in use by another process. The node does not move to another port on its own. ${WHY.en} Free port ${port}, or choose another one explicitly: nexuscrew init --port <N>.`,
    it: ({ port }) => `La porta ${port} è occupata da un altro processo. Il nodo non passa da solo a un'altra porta. ${WHY.it} Libera la porta ${port}, oppure scegline un'altra in modo esplicito: nexuscrew init --port <N>.`,
    es: ({ port }) => `El puerto ${port} está ocupado por otro proceso. El nodo no cambia de puerto por su cuenta. ${WHY.es} Libera el puerto ${port} o elige otro de forma explícita: nexuscrew init --port <N>.`,
  },
  'busy-paired': {
    en: ({ port }) => `Port ${port} is busy and paired peers exist: refusing automatic port change (the peers point at this port). Free port ${port}, or choose another one explicitly and re-pair the peers: nexuscrew init --port <N>.`,
    it: ({ port }) => `La porta ${port} è occupata e ci sono nodi accoppiati: cambio automatico di porta rifiutato (i nodi puntano a questa porta). Libera la porta ${port}, oppure scegline un'altra in modo esplicito e riaccoppia i nodi: nexuscrew init --port <N>.`,
    es: ({ port }) => `El puerto ${port} está ocupado y hay nodos emparejados: cambio automático de puerto rechazado (los nodos apuntan a este puerto). Libera el puerto ${port} o elige otro de forma explícita y vuelve a emparejar los nodos: nexuscrew init --port <N>.`,
  },
  'busy-token': {
    en: ({ port }) => `Port ${port} answers as a NexusCrew node that rejects this token. The port is not changed. Check ~/.nexuscrew/token or the instance running there.`,
    it: ({ port }) => `La porta ${port} risponde come un nodo NexusCrew che rifiuta questo token. La porta non viene cambiata. Controlla ~/.nexuscrew/token o l'istanza che gira lì.`,
    es: ({ port }) => `El puerto ${port} responde como un nodo NexusCrew que rechaza este token. El puerto no se cambia. Revisa ~/.nexuscrew/token o la instancia que corre allí.`,
  },
  'busy-own-slow': {
    en: ({ port }) => `The NexusCrew process on port ${port} is running but does not answer yet. The port is not changed. Retry in a moment (nexuscrew show) or check the log (nexuscrew logs).`,
    it: ({ port }) => `Il processo NexusCrew sulla porta ${port} è avviato ma non risponde ancora. La porta non viene cambiata. Riprova fra poco (nexuscrew show) o controlla il log (nexuscrew logs).`,
    es: ({ port }) => `El proceso NexusCrew en el puerto ${port} está en marcha pero aún no responde. El puerto no se cambia. Reintenta en un momento (nexuscrew show) o revisa el log (nexuscrew logs).`,
  },
};

// NEXUSCREW_LANG, poi LC_ALL, LC_MESSAGES, LANG: la prima variabile impostata decide; se non e' it/en/es -> 'all'.
function pickLang(env = process.env) {
  for (const name of ['NEXUSCREW_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = String(env[name] || '').trim();
    if (!value || value === 'C' || value === 'POSIX' || /^C\./.test(value)) continue;
    const base = value.slice(0, 2).toLowerCase();
    return LANGS.includes(base) ? base : 'all';
  }
  return 'all';
}

function portMessage(key, params, { lang, env } = {}) {
  const entry = CATALOG[key];
  if (!entry) throw new Error(`messaggio sconosciuto: ${key}`);
  const chosen = lang || pickLang(env);
  if (chosen === 'all') return ['en', 'it', 'es'].map((l) => entry[l](params)).join('\n');
  return (entry[chosen] || entry.en)(params);
}

module.exports = { LANGS, pickLang, portMessage };
