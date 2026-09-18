'use strict';
// (lato NC): una cella STANDALONE deliberata non deve ricevere il canale
// identita'. Prima il supervisore aggiungeva SEMPRE fd 3:4 +
// NEXUSCREW_IDENTITY_FD, anche quando il launcher aveva risolto
// CODEX_APP_SERVER_IDENTITY_REQUIRED=0: il child avviava l'handshake contro un
// lease server legacy che rispondeva `revoked`, e la cella moriva. La decisione
// nasce in lib/fleet/managed.js (dove nasce il flag) e viaggia nel payload: il
// supervisore NON la ricalcola, cosi' i due non possono divergere.
//
// La seconda meta' dello stesso difetto: se l'authority e' configurata ma non
// costruibile, il lancio e' RIFIUTATO con un codice, non degradato a standalone
// in silenzio (prima: `0` + una riga di log).
//
// SUI DESCRITTORI, misurato: `fstat` sul figlio NON distingue i due casi in
// generale — un figlio node eredita fd interni del processo che lancia
// (misurato qui: fd 3 = anon_inode:[eventpoll], fd 4 = anon_inode:[io_uring]
// anche con lo stdio a 3 voci). Il segnale affidabile e' la voce 3:4 dello
// stdio passato allo spawn: quando il canale c'e', node crea per il figlio una
// socketpair (misurato: fd 3/4 = socket:[...]). Quindi si asseriscono ENTRAMBI:
// l'array di stdio (deterministico) e l'osservazione del figlio vero
// (corroborante, ma non unica).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { main } = require('../lib/fleet/cell-exec.js');
const { identityLaunchRefusal } = require('../lib/fleet/runtime.js');

const CHILD_REPORT = `
  const fs = require('node:fs');
  const fds = {};
  for (const fd of [3, 4]) {
    try {
      const st = fs.fstatSync(fd);
      fds[fd] = { socket: st.isSocket(), fifo: st.isFIFO() };
    } catch (error) { fds[fd] = { closed: error.code }; }
  }
  fs.writeFileSync(process.argv[1], JSON.stringify({
    identityFd: process.env.NEXUSCREW_IDENTITY_FD === undefined
      ? null : String(process.env.NEXUSCREW_IDENTITY_FD),
    nexucrewEnv: Object.keys(process.env).filter((k) => k.startsWith('NEXUSCREW_')).sort(),
    fds,
  }));
`;

// Figlio VERO lanciato dal supervisore vero; lo stdio viene osservato al
// passaggio, non simulato.
async function launchChild(extraPayload = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-standalone-'));
  const out = path.join(dir, 'child.json');
  const errors = [];
  let stdio = null;
  const payload = {
    command: process.execPath,
    args: ['-e', CHILD_REPORT, out],
    env: { PATH: process.env.PATH },
    supervise: { enabled: false },
    ...extraPayload,
  };
  const events = new (require('node:events').EventEmitter)();
  try {
    const code = await main(['--socket', '/unused', '--nonce', 'a'.repeat(64)], {
      receivePayload: async () => payload,
      spawn: (command, args, options) => {
        stdio = options.stdio;
        return spawn(command, args, options);
      },
      process: events,
      writeError: (line) => errors.push(String(line)),
    });
    const observed = JSON.parse(fs.readFileSync(out, 'utf8'));
    return { code, observed, errors, stdio };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('standalone (identityChannel: false): niente pipe 3:4, niente NEXUSCREW_IDENTITY_FD', async () => {
  const { code, observed, errors, stdio } = await launchChild({ identityChannel: false });
  assert.equal(code, 0, errors.join(''));
  assert.equal(stdio.length, 3, `nessuna pipe creata: stdio=${JSON.stringify(stdio)}`);
  assert.equal(observed.identityFd, null, observed.nexucrewEnv.join(','));
  assert.ok(!observed.nexucrewEnv.includes('NEXUSCREW_IDENTITY_FD'), observed.nexucrewEnv.join(','));
  const asSocketPair = observed.fds[3].socket === true && observed.fds[4].socket === true;
  assert.equal(asSocketPair, false,
    `il figlio non deve vedere la socketpair del canale: ${JSON.stringify(observed.fds)}`);
});

test('protetta (identityChannel: true): fd 3:4 come pipe e NEXUSCREW_IDENTITY_FD presente', async () => {
  const { code, observed, errors, stdio } = await launchChild({ identityChannel: true });
  assert.equal(code, 0, errors.join(''));
  assert.deepEqual(stdio, ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']);
  assert.equal(observed.identityFd, '3:4');
  assert.ok(observed.fds[3].socket === true && observed.fds[4].socket === true,
    `il canale e' una coppia di descrittori aperti: ${JSON.stringify(observed.fds)}`);
});

test('payload senza il campo (caller precedenti): il canale resta quello di prima', async () => {
  const { code, observed, errors, stdio } = await launchChild();
  assert.equal(code, 0, errors.join(''));
  assert.equal(stdio.length, 5);
  assert.equal(observed.identityFd, '3:4');
});

test('rifiuto: authority costruibile, standalone o payload assente -> nessun rifiuto', () => {
  assert.equal(identityLaunchRefusal({ identityChannel: true }), null);
  assert.equal(identityLaunchRefusal({ identityChannel: false }), null);
  assert.equal(identityLaunchRefusal(undefined), null);
});

test('rifiuto: authority configurata ma non costruibile -> IDENTITY_AUTHORITY_UNAVAILABLE col motivo', () => {
  const refusal = identityLaunchRefusal({
    identityChannel: false,
    identityAuthorityUnavailable: 'daemon and launcher credentials are identical',
  });
  assert.equal(refusal.code, 'IDENTITY_AUTHORITY_UNAVAILABLE');
  assert.equal(refusal.status, 500);
  assert.match(refusal.message, /daemon and launcher credentials are identical/);
});
