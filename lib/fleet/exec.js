'use strict';
const { execFile } = require('node:child_process');

// Esecutore serializzato del binario fleet: UNA invocazione alla volta
// (fleet tocca systemd/tmux reali: due comandi concorrenti = stato incoerente),
// timeout duro, stderr propagato nell'errore. Argomenti SEMPRE array (no shell).
function createFleetExec(bin, { timeoutMs = 15000 } = {}) {
  let chain = Promise.resolve();

  function exec(args) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal === 'SIGKILL') return reject(new Error('fleet timeout'));
          return reject(new Error(`fleet ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`));
        }
        resolve(String(stdout));
      });
    });
  }

  function run(args) {
    const next = chain.then(() => exec(args));
    // la coda non si spezza sugli errori (catch), ma il chiamante li vede
    chain = next.catch(() => {});
    return next;
  }

  return { run };
}

module.exports = { createFleetExec };
