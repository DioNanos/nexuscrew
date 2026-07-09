'use strict';
const { verify } = require('./token.js');

function bearerFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// 401 uniforme: nessun dettaglio su cosa è andato storto.
function requireToken(token) {
  return (req, res, next) => {
    if (verify(token, bearerFrom(req))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = { requireToken, bearerFrom };
