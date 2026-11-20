'use strict';
// Child process of the two-incarnation cleanup test. Each child requires its
// own fresh copy of the runtime module and drives its own incarnation through
// a one-JSON-object-per-line protocol on stdin/stdout, so the parent can
// orchestrate ready -> qualify -> publish -> cleanup -> verify -> exit with
// barriers instead of sleeps. The child touches only the world paths it
// receives from the parent and terminates by itself after its own idle
// deadline, so a lost parent never leaks it and no signal is ever needed.
const fs = require('node:fs');
const readline = require('node:readline');

const spedisci = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

// Own idle deadline: no command for 120 s -> orderly self exit.
let scadenzaInattivita = null;
function riarmaScadenza() {
  if (scadenzaInattivita !== null) clearTimeout(scadenzaInattivita);
  scadenzaInattivita = setTimeout(() => process.exit(0), 120000);
  scadenzaInattivita.unref();
}
riarmaScadenza();

let modulo = null;
let deps = null;
let qualificato = null;
let linkOriginale = null;

const righe = readline.createInterface({ input: process.stdin });
righe.on('line', (line) => {
  riarmaScadenza();
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (_) {
    spedisci({ id: null, error: 'bad-json' });
    return;
  }
  try {
    switch (cmd.op) {
      case 'init':
        modulo = require(cmd.modulePath);
        deps = {
          execPath: cmd.execPath,
          versionsNode: process.versions.node,
          tmpdir: cmd.stageDir,
          probe: () => ({
            status: 0, stdout: `v${process.versions.node}\n`, stderr: '', error: null,
          }),
        };
        spedisci({ id: cmd.id, ready: true, nonce: modulo.getCreationRegistry().nonce });
        break;
      case 'qualifica': {
        const r = modulo.qualifica(deps);
        if (r.ok) qualificato = r;
        spedisci({ id: cmd.id, ok: r.ok, code: r.code || null, motivo: r.motivo || null, path: r.path || null });
        break;
      }
      case 'pubblica': {
        const r = modulo.pubblica(qualificato, cmd.staging, deps);
        spedisci({ id: cmd.id, ok: r.ok, code: r.code || null, motivo: r.motivo || null, path: r.path || null });
        break;
      }
      case 'deny-link':
        if (linkOriginale === null) {
          linkOriginale = fs.linkSync;
          fs.linkSync = () => {
            const e = new Error('EACCES: link denied');
            e.code = 'EACCES';
            throw e;
          };
        }
        spedisci({ id: cmd.id, denied: true });
        break;
      case 'allow-link':
        if (linkOriginale !== null) {
          fs.linkSync = linkOriginale;
          linkOriginale = null;
        }
        spedisci({ id: cmd.id, denied: false });
        break;
      case 'cleanup': {
        // The synthetic quiescence proof: in the wiring step the real
        // coordinator builds it; here the child attests its own incarnation.
        const prova = {
          nonce: modulo.getCreationRegistry().nonce,
          processDisarmed: true,
          processQuiescent: true,
          fleetDisarmed: true,
          timedOut: false,
          producers: 0,
          claims: 0,
          consumers: 0,
          canCleanupOwnedResources: true,
          deadlineMono: performance.now() + 30000,
        };
        const r = modulo.cleanupInstance(prova);
        spedisci({
          id: cmd.id,
          outcome: r.outcome,
          reason: r.reason,
          counts: r.counts,
          replayed: r.replayed,
        });
        break;
      }
      case 'cleanup-foreign': {
        // A proof of ANOTHER incarnation, same shape and a foreign nonce,
        // handed to this module BEFORE any terminal: the crossed nonce/seq
        // case (two fresh incarnations number their entries from the same
        // base, so the first seq matches and only the nonce differs).
        const prova = {
          nonce: cmd.nonce,
          processDisarmed: true,
          processQuiescent: true,
          fleetDisarmed: true,
          timedOut: false,
          producers: 0,
          claims: 0,
          consumers: 0,
          canCleanupOwnedResources: true,
          deadlineMono: performance.now() + 30000,
        };
        const r = modulo.cleanupInstance(prova);
        spedisci({
          id: cmd.id,
          outcome: r.outcome,
          reason: r.reason,
          counts: r.counts,
          replayed: r.replayed,
        });
        break;
      }
      case 'nonce':
        spedisci({ id: cmd.id, nonce: modulo.getCreationRegistry().nonce });
        break;
      case 'verify': {
        const r = modulo.qualifica(deps);
        spedisci({ id: cmd.id, ok: r.ok, code: r.code || null, motivo: r.motivo || null, path: r.path || null });
        break;
      }
      case 'exit':
        spedisci({ id: cmd.id, bye: true });
        process.exit(0);
        break;
      default:
        spedisci({ id: cmd.id, error: 'unknown-op' });
    }
  } catch (e) {
    spedisci({ id: cmd.id, error: e && e.message ? e.message : String(e) });
  }
});
