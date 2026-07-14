'use strict';

// Shared by managed providers, the local credential store and the HTTP API.
// Mixed-case names are valid POSIX environment keys and are intentionally
// preserved for custom providers.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function validEnvKey(value) {
  return typeof value === 'string' && ENV_KEY_RE.test(value);
}

module.exports = { ENV_KEY_RE, validEnvKey };
