'use strict';
const { verify } = require('./token.js');

function bearerFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// 401 uniforme: nessun dettaglio su cosa è andato storto.
// `token` puo' essere una stringa (storico) o un holder live {get}: l'holder si
// rilegge ad OGNI richiesta, cosi' una rotazione (audit F7 / §4b(3)) invalida il
// vecchio token senza restart. backward-compat: la stringa resta accettata.
function requireToken(token) {
  const read = (token && typeof token === 'object' && typeof token.get === 'function')
    ? token.get
    : () => token;
  return (req, res, next) => {
    if (verify(read(), bearerFrom(req))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = { requireToken, bearerFrom };
