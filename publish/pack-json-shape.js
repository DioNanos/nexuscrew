'use strict';

// D-384/NC_0952 — `npm pack --json` cambia FORMA dell'output fra versioni del
// package manager, e la documentazione (`docs.npmjs.com/cli/v12/commands/npm-pack`,
// sezione `json`) non la descrive: dice solo «Whether or not to output JSON data,
// rather than the normal output».
//
// Misurato su questa macchina (Node 24.21.0):
// • npm ≤ 11: ARRAY di report, un elemento per pacchetto — è la forma che il
//   verifier di pubblicazione ha sempre aspettato;
// • npm 12.1.0: OGGETTO chiavato per nome pacchetto (lo scope incluso,
//   `@mmmbuto/nexuscrew`), con gli stessi campi dentro (filename, files, …).
//
// `packEntries` normalizza alla forma array: il chiamante fa il suo `[0]`
// senza sapere con quale npm sta girando. Fallisce chiudo su input che non
// sia né array né oggetto.

function packEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed);
  throw new Error('npm pack --json: formato non riconosciuto (né array né oggetto)');
}

module.exports = { packEntries };
