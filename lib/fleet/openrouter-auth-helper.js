'use strict';

const ALLOWED_ENV_KEY = 'OPENROUTER_API_KEY';
const MAX_TOKEN_BYTES = 16 * 1024;

function readOpenRouterCredential(name, env = process.env) {
  if (name !== ALLOWED_ENV_KEY) throw new Error('unsupported credential request');
  const value = env[name];
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_TOKEN_BYTES
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('credential unavailable');
  }
  return value;
}

if (require.main === module) {
  try { process.stdout.write(readOpenRouterCredential(process.argv[2])); }
  catch (_) { process.exitCode = 1; }
}

module.exports = { ALLOWED_ENV_KEY, MAX_TOKEN_BYTES, readOpenRouterCredential };
