'use strict';
// Unit del confine «runtime Node qualificato» della claim vl: il candidato e'
// il runtime effettivo del processo, qualificato (catena, uid, mode, fd
// stabile), fotografato in copia privata e sondato con `--version` isolato.
// Nessun hash di release: l'hash misurato e' integrita' della fotografia, non
// un consenso. Contesti fs/probe iniettabili SOLO come seam interni di test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const nodo = require('../lib/fleet/vl-node-runtime.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Un runtime finto completo: binario leggibile/eseguibile nostro, in una
// catena 0755 nostra. La probe e' un seam che risponde la versione attesa.
function mondoRuntime(t, { versione = '26.12.1', bin = '#!/bin/sh\nexit 0\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true, mode: 0o755 });
  const exec = path.join(root, 'bin', 'node');
  fs.writeFileSync(exec, bin);
  fs.chmodSync(exec, 0o755);
  const viste = [];
  const deps = {
    execPath: exec,
    versionsNode: versione,
    tmpdir: path.join(root, 'stage'),
    probe: (exe, argv, opzioni) => {
      viste.push({ exe, argv, env: { ...(opzioni && opzioni.env) } });
      return { status: 0, stdout: `v${versione}\n`, stderr: '', error: null };
    },
  };
  return { root, exec, deps, viste };
}

test('runtime: il runtime reale del runner si qualifica senza manifest', async (t) => {
  const d = mondoRuntime(t);
  const r = nodo.qualifica(d.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, '26.12.1');
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(r.path).length, fs.readFileSync(d.exec).length);
  const st = fs.lstatSync(r.path);
  assert.equal(st.mode & 0o777, 0o500);
  assert.equal(st.uid, process.getuid());
  // La fotografia e' una copia nostra, non un alias del sorgente.
  const sorgente = fs.lstatSync(d.exec);
  assert.ok(st.ino !== sorgente.ino || st.dev !== sorgente.dev, 'alias del sorgente');
  // La seconda qualifica riusa lo stesso oggetto gia' verificato.
  const r2 = nodo.qualifica(d.deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.path, r.path);
});

test('runtime: la probe riceve env minimo, senza NODE_OPTIONS/NODE_PATH', async (t) => {
  const d = mondoRuntime(t);
  process.env.NODE_OPTIONS = '--max-old-space-size=1';
  process.env.NODE_PATH = '/tmp/evil';
  t.after(() => { delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH; });
  const r = nodo.qualifica(d.deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(d.viste.length, 1);
  assert.equal(d.viste[0].argv.join(' '), '--version');
  assert.equal(d.viste[0].env.NODE_OPTIONS, undefined);
  assert.equal(d.viste[0].env.NODE_PATH, undefined);
  // La fotografia e' l'eseguibile sondato, non il sorgente aggiornabile.
  assert.equal(d.viste[0].exe, r.path);
});

test('runtime: versioni incompatibili o ambigue rifiutano con PIN_VERSION', async (t) => {
  for (const versione of ['17.9.0', '26.12.1-nightly.1', 'v26.12.1', '26.12', '']) {
    const d = mondoRuntime(t, { versione });
    const r = nodo.qualifica(d.deps);
    assert.equal(r.ok, false, versione);
    assert.equal(r.code, 'PIN_VERSION', versione);
  }
});

test('runtime: probe incerta rifiuta senza sonde alternative', async (t) => {
  const casi = [
    { status: 0, stdout: 'v25.0.0\n', stderr: '', error: null },
    { status: 0, stdout: 'v26.12.1\nv26.12.1\n', stderr: '', error: null },
    { status: 0, stdout: '', stderr: 'boom', error: null },
    { status: 1, stdout: 'v26.12.1\n', stderr: 'x', error: null },
    { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } },
    { status: 0, stdout: 'v26.12.1\njunk', stderr: '', error: null },
  ];
  for (const esito of casi) {
    const d = mondoRuntime(t);
    d.deps.probe = () => esito;
    const r = nodo.qualifica(d.deps);
    assert.equal(r.ok, false, JSON.stringify(esito));
    assert.equal(r.code, 'PIN_VERSION', JSON.stringify(esito));
  }
});

test('runtime: percorso e oggetto non qualificabili rifiutano con PIN_REREAD', async (t) => {
  const relativi = [ 'bin/node', '', null ];
  for (const execPath of relativi) {
    const d = mondoRuntime(t);
    const r = nodo.qualifica({ ...d.deps, execPath });
    assert.equal(r.ok, false, JSON.stringify(execPath));
    assert.equal(r.code, 'PIN_REREAD');
  }
  const d = mondoRuntime(t);
  // file non regolare
  const dirAlPosto = path.join(d.root, 'bin', 'node2');
  fs.mkdirSync(dirAlPosto);
  const rDir = nodo.qualifica({ ...d.deps, execPath: dirAlPosto });
  assert.equal(rDir.ok, false);
  assert.equal(rDir.code, 'PIN_REREAD');
  // setuid/setgid
  fs.chmodSync(d.exec, 0o4755);
  const rSetuid = nodo.qualifica(d.deps);
  assert.equal(rSetuid.ok, false);
  assert.equal(rSetuid.code, 'PIN_REREAD');
  fs.chmodSync(d.exec, 0o755);
  // scrivibile da altri
  fs.chmodSync(d.exec, 0o777);
  const rLargo = nodo.qualifica(d.deps);
  assert.equal(rLargo.ok, false);
  assert.equal(rLargo.code, 'PIN_REREAD');
  fs.chmodSync(d.exec, 0o755);
  // uid estraneo (seam del lstat)
  const lstatReale = fs.lstatSync;
  const rUid = nodo.qualifica({
    ...d.deps,
    lstat: (p) => {
      const st = lstatReale(p);
      if (p !== d.exec) return st;
      const finto = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
      finto.uid = process.getuid() + 1;
      return finto;
    },
  });
  assert.equal(rUid.ok, false);
  assert.equal(rUid.code, 'PIN_REREAD');
  // antenato scrivibile da altri
  fs.chmodSync(path.join(d.root, 'bin'), 0o777);
  const rAntenato = nodo.qualifica(d.deps);
  assert.equal(rAntenato.ok, false);
  assert.equal(rAntenato.code, 'PIN_REREAD');
  fs.chmodSync(path.join(d.root, 'bin'), 0o755);
});

test('runtime: solo ENOENT e\' assenza, gli errori di I/O rifiutano', async (t) => {
  const d = mondoRuntime(t);
  const rAssente = nodo.qualifica({ ...d.deps, execPath: path.join(d.root, 'bin', 'manca') });
  assert.equal(rAssente.ok, false);
  assert.equal(rAssente.code, 'PIN_ABSENT');
  const lstatReale = fs.lstatSync;
  const rIo = nodo.qualifica({
    ...d.deps,
    lstat: (p) => {
      if (p === d.exec) { const e = new Error('io'); e.code = 'EIO'; throw e; }
      return lstatReale(p);
    },
  });
  assert.equal(rIo.ok, false);
  assert.equal(rIo.code, 'PIN_REREAD');
});

test('runtime: la sorgente aggiornata dopo la qualifica non cambia i byte in uso', async (t) => {
  const d = mondoRuntime(t);
  const prima = nodo.qualifica(d.deps);
  assert.equal(prima.ok, true);
  fs.writeFileSync(d.exec, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(d.exec, 0o755);
  // L'istanza gia' qualificata pubblica sempre la fotografia dei byte letti.
  const dopo = nodo.qualifica(d.deps);
  assert.equal(dopo.ok, true);
  assert.equal(dopo.hash, prima.hash);
  assert.equal(fs.readFileSync(dopo.path).length, fs.readFileSync(prima.path).length);
});

test('runtime: pubblicazione per-home della fotografia qualificata', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-h-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  // La parent esiste sempre quando la pubblicazione parte dal flusso reale:
  // la garantisce il chiamante prima di preparare il pin.
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const p1 = nodo.pubblica(q, staging);
  assert.equal(p1.ok, true, JSON.stringify(p1));
  const st = fs.lstatSync(p1.path);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o777, 0o500);
  // Ripubblicazione: lo stesso contenuto riusa il nome, un finale mutato rifiuta.
  const p2 = nodo.pubblica(q, staging);
  assert.equal(p2.ok, true);
  assert.equal(p2.path, p1.path);
  fs.rmSync(p1.path);
  fs.writeFileSync(p1.path, 'sostituito');
  fs.chmodSync(p1.path, 0o500);
  const p3 = nodo.pubblica(q, staging);
  assert.equal(p3.ok, false, 'un finale non corrispondente deve rifiutare');
  assert.equal(p3.code, 'PIN_REREAD');
});

test('runtime: la fotografia mutata in staging privato rifiuta, EEXIST non basta', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true);
  fs.rmSync(q.path);
  fs.writeFileSync(q.path, 'tampered', { mode: 0o500 });
  fs.chmodSync(q.path, 0o500);
  const r = nodo.qualifica(d.deps);
  assert.equal(r.ok, false, 'una copia privata mutata deve rifiutare');
  assert.equal(r.code, 'PIN_REREAD');
});

// L'istanza gia' qualificata resta vincolata alla fotografia che ha
// qualificato: se quella sparisce, la sorgente NON si riqualifica con un
// hash nuovo nella stessa istanza. La riqualifica e' di una nuova istanza.
test('runtime: la fotografia persa rifiuta senza riqualificare la sorgente', async (t) => {
  const d = mondoRuntime(t);
  const prima = nodo.qualifica(d.deps);
  assert.equal(prima.ok, true, JSON.stringify(prima));
  // La fotografia sparisce e la sorgente cambia con byte compatibili.
  fs.rmSync(prima.path);
  fs.writeFileSync(d.exec, '#!/bin/sh\nexit 7\n');
  fs.chmodSync(d.exec, 0o755);
  const dopo = nodo.qualifica(d.deps);
  assert.equal(dopo.ok, false, 'la fotografia persa deve rifiutare senza riqualificare');
  assert.equal(dopo.code, 'PIN_REREAD');
  // Una NUOVA istanza qualifica la sorgente nuova: e' il rientro legittimo.
  const modulo = require.resolve('../lib/fleet/vl-node-runtime.js');
  delete require.cache[modulo];
  const nodo2 = require(modulo);
  const nuova = nodo2.qualifica(d.deps);
  assert.equal(nuova.ok, true, JSON.stringify(nuova));
  assert.notEqual(nuova.hash, prima.hash);
});

// La lettura dichiarata stabile deve accorgersi del file che cambia mentre
// viene letto: stessi inode e size ma mtime nuovo, nome sostituito con un
// inode diverso, antenato sostituito dopo l'apertura.
test('runtime: la lettura rileva mutazione in corsa e sostituzione di nome o catena', async (t) => {
  const readReale = fs.readSync;
  const mutazioni = [
    {
      nome: 'stessa size con mtime nuovo',
      muta: (m) => {
        const fw = fs.openSync(m.exec, 'r+');
        fs.writeSync(fw, Buffer.from('#!/bin/sh\nexit 7\n'));
        fs.closeSync(fw);
        const poi = new Date(Date.now() + 10000);
        fs.utimesSync(m.exec, poi, poi);
      },
    },
    {
      nome: 'nome sostituito con inode diverso',
      muta: (m) => {
        const byte = fs.readFileSync(m.exec);
        fs.renameSync(m.exec, `${m.exec}.tenuta`);
        fs.writeFileSync(m.exec, byte, { mode: 0o755 });
        fs.chmodSync(m.exec, 0o755);
      },
    },
    {
      nome: 'antenato sostituito dopo l\'apertura',
      muta: (m) => {
        const bin = path.join(m.root, 'bin');
        fs.renameSync(bin, `${bin}.tenuta`);
        fs.mkdirSync(bin, { mode: 0o755 });
        fs.chmodSync(bin, 0o755);
        fs.copyFileSync(`${bin}.tenuta/node`, path.join(bin, 'node'));
        fs.chmodSync(path.join(bin, 'node'), 0o755);
      },
    },
  ];
  for (const { nome, muta } of mutazioni) {
    const m = mondoRuntime(t);
    let giaLetto = false;
    const hook = (fd, buf, off, len, pos) => {
      const n = readReale(fd, buf, off, len, pos);
      if (!giaLetto && n > 0) {
        giaLetto = true;
        muta(m);
      }
      return n;
    };
    const r = nodo.qualifica({ ...m.deps, read: hook });
    assert.equal(r.ok, false, `${nome}: il file mutato in lettura deve rifiutare`);
    assert.equal(r.code, 'PIN_REREAD', nome);
  }
});

// Lo storage della fotografia si qualifica anche al riuso: un genitore
// simbolico non e' la directory privata; il fsync della directory non e'
// best effort: il suo fallimento rifiuta la qualifica e la pubblicazione.
test('runtime: storage qualificato al riuso e fsync della directory vincolante', async (t) => {
  // Genitore della fotografia sostituito con un symlink alla directory tenuta.
  const d = mondoRuntime(t);
  const prima = nodo.qualifica(d.deps);
  assert.equal(prima.ok, true, JSON.stringify(prima));
  const dirFoto = path.dirname(prima.path);
  const tenuta = `${dirFoto}.tenuta`;
  fs.renameSync(dirFoto, tenuta);
  fs.symlinkSync(tenuta, dirFoto);
  const riuso = nodo.qualifica(d.deps);
  assert.equal(riuso.ok, false, 'un genitore simbolico dello storage deve rifiutare');
  assert.equal(riuso.code, 'PIN_REREAD');

  // EIO solo sul fsync della directory: scrittura e file restano validi.
  const fsyncSeam = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      const e = new Error('io'); e.code = 'EIO'; throw e;
    }
    fs.fsyncSync(fd);
  };
  const d2 = mondoRuntime(t);
  const q2 = nodo.qualifica({ ...d2.deps, fsync: fsyncSeam });
  assert.equal(q2.ok, false, 'il fallimento del fsync della directory deve rifiutare');
  assert.equal(q2.code, 'PIN_STAGE');

  // Anche la pubblicazione per-home fsync la propria directory, fail-closed.
  const d3 = mondoRuntime(t);
  const q3 = nodo.qualifica(d3.deps);
  assert.equal(q3.ok, true);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-p-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  // La parent della staging e' garantita dal chiamante del flusso reale.
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const p = nodo.pubblica(q3, path.join(home, '.nexuscrew', 'vl-claim-pin'), { fsync: fsyncSeam });
  assert.equal(p.ok, false, 'la pubblicazione senza fsync della directory deve rifiutare');
  assert.equal(p.code, 'PIN_STAGE');
});

// Lo staging per-home si crea solo sull'assenza attestata: una directory
// preesistente non qualificata (mode, proprietario, link) rifiuta senza
// chmod di riparazione.
test('runtime: lo staging preesistente non qualificato si rifiuta, non si ripara', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-s-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(staging, { recursive: true, mode: 0o775 });
  fs.chmodSync(staging, 0o775);
  const p = nodo.pubblica(q, staging);
  assert.equal(p.ok, false, 'una directory di staging preesistente non qualificata deve rifiutare');
  assert.equal(p.code, 'PIN_DIR');
  // Niente riparazione: i permessi restano quelli trovati.
  assert.equal(fs.lstatSync(staging).mode & 0o777, 0o775, 'lo staging e\' stato riparato');
});

// Lo staging puo' comparire DOPO l'assenza attestata dal lstat e prima della
// creazione: la creazione deve essere esclusiva, cosi' il nome comparso nel
// frattempo non viene niente creato niente riparato. Si qualifica senza
// riparazione o si rifiuta, e i permessi trovati restano invariati.
test('runtime: lo staging comparso dopo l assenza attestata non si ripara', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-race-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const lstatReale = fs.lstatSync;
  let inserita = false;
  const deps = {
    ...d.deps,
    lstat: (p) => {
      try {
        return lstatReale(p);
      } catch (e) {
        if (p === staging && e && e.code === 'ENOENT' && !inserita) {
          // La directory compare fra l'osservazione dell'assenza e la
          // creazione: un concorrente, non questa chiamata.
          inserita = true;
          fs.mkdirSync(staging, { mode: 0o775 });
          fs.chmodSync(staging, 0o775);
        }
        throw e;
      }
    },
  };
  const p = nodo.pubblica(q, staging, deps);
  assert.equal(p.ok, false, 'uno staging comparso dopo l assenza attestata deve rifiutare');
  assert.equal(p.code, 'PIN_DIR');
  assert.equal(lstatReale(staging).mode & 0o777, 0o775, 'lo staging comparso nel frattempo e\' stato riparato');
});

// Il nome appena creato puo' essere spostato e sostituito PRIMA del primo
// lstat che segue il mkdir: la qualifica non puo' appoggiarsi a un chmod
// correttivo sul pathname, perche' quel chmod non e' vincolato all'oggetto
// creato dalla chiamata. Sola qualifica: il sostituto 0775 resta invariato.
test('runtime: il nome creato sostituito prima della prima verifica non si ripara', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-created-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const conservata = `${staging}.originale`;
  const lstatReale = fs.lstatSync;
  let assenzaVista = false;
  let sostituita = false;
  const deps = {
    ...d.deps,
    lstat: (p) => {
      let st;
      try {
        st = lstatReale(p);
      } catch (e) {
        if (p === staging && e && e.code === 'ENOENT') assenzaVista = true;
        throw e;
      }
      if (p === staging && assenzaVista && !sostituita) {
        // La directory appena creata viene spostata e al suo nome compare
        // una directory 0775 di un altro, prima del primo lstat utile.
        sostituita = true;
        fs.renameSync(staging, conservata);
        fs.mkdirSync(staging, { mode: 0o775 });
        fs.chmodSync(staging, 0o775);
        return lstatReale(staging);
      }
      return st;
    },
  };
  const p = nodo.pubblica(q, staging, deps);
  assert.ok(sostituita, 'il seam deve aver sostituito il nome creato');
  assert.equal(p.ok, false, 'un nome sostituito dopo la creazione deve rifiutare');
  assert.equal(p.code, 'PIN_DIR');
  assert.equal(lstatReale(staging).mode & 0o777, 0o775, 'il sostituto e\' stato riparato');
  assert.notEqual(lstatReale(conservata).ino, lstatReale(staging).ino,
    'il nome accettato sarebbe la directory creata');
});

// Con un umask che restringe oltre 0700 il nome creato non e' qualificabile
// (mode esatto 0700) e non viene riparato: fail-closed, senza chmod.
test('runtime: un umask restrittivo rifiuta la creazione senza ripararla', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-umask-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const umaskPrima = process.umask(0o277);
  t.after(() => {
    process.umask(umaskPrima);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  });
  const p = nodo.pubblica(q, staging, d.deps);
  process.umask(umaskPrima);
  assert.equal(p.ok, false, 'un nome creato sotto 0700 non e\' qualificato');
  assert.equal(p.code, 'PIN_DIR');
  assert.equal(fs.lstatSync(staging).mode & 0o777, 0o500, 'il nome creato e\' stato riparato');
});

// Il mkdir della directory di staging e' non ricorsivo: un parent assente non
// viene creato e la pubblicazione rifiuta.
test('runtime: parent assente rifiuta con PIN_DIR senza creare il parent', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-noparent-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const parent = path.join(home, '.nexuscrew');
  const staging = path.join(parent, 'vl-claim-pin');
  const p = nodo.pubblica(q, staging, d.deps);
  assert.equal(p.ok, false, 'senza parent la pubblicazione deve rifiutare');
  assert.equal(p.code, 'PIN_DIR');
  assert.equal(fs.existsSync(parent), false, 'il parent non deve essere stato creato');
});

// Modello dichiarato: i processi dello stesso uid che modificano il parent
// privato sono fidati. Un sostituto 0700 dello stesso uid al nome dello
// staging e' quindi accettato. Non e' un negativo di sicurezza e non afferma
// nulla sull'identita' (inode) della directory creata e di quella usata.
test('runtime: un sostituto 0700 dello stesso uid e\' accettato (modello dichiarato)', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-same-uid-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const lstatReale = fs.lstatSync;
  let assenzaVista = false;
  let sostituita = false;
  const deps = {
    ...d.deps,
    lstat: (p) => {
      let st;
      try {
        st = lstatReale(p);
      } catch (e) {
        if (p === staging && e && e.code === 'ENOENT') assenzaVista = true;
        throw e;
      }
      if (p === staging && assenzaVista && !sostituita) {
        sostituita = true;
        fs.renameSync(staging, `${staging}.originale`);
        fs.mkdirSync(staging, { mode: 0o700 });
        fs.chmodSync(staging, 0o700);
        return lstatReale(staging);
      }
      return st;
    },
  };
  const p = nodo.pubblica(q, staging, deps);
  assert.ok(sostituita, 'il seam deve aver sostituito il nome creato');
  assert.equal(p.ok, true, JSON.stringify(p));
  // Il finale pubblicato e' il path RESTITUITO, nella forma
  // <staging>/inst-<32hex>/<hash>: il chiamante non ricostruisce un path
  // globale, il namespace d'istanza non e' prevedibile dall'esterno.
  assert.equal(path.basename(p.path), q.hash);
  assert.match(path.basename(path.dirname(p.path)), /^inst-[0-9a-f]{32}$/);
  assert.equal(path.dirname(path.dirname(p.path)), staging);
});

// Il finale letto per fd deve restare privato COERENTE con la prima
// identita': un chmod che allarga i permessi fra lo stat del nome e
// l'apertura non puo' essere accettato.
test('runtime: il finale non piu\' privato fra stat e apertura rifiuta', async (t) => {
  const d = mondoRuntime(t);
  const prima = nodo.qualifica(d.deps);
  assert.equal(prima.ok, true, JSON.stringify(prima));
  const openReale = fs.openSync;
  const foto = prima.path;
  const deps = {
    ...d.deps,
    open: (p, flags, mode) => {
      if (p === foto) fs.chmodSync(foto, 0o777);
      return openReale(p, flags, mode);
    },
  };
  const dopo = nodo.qualifica(deps);
  assert.equal(dopo.ok, false, 'un finale letto dopo un allargamento di permessi deve rifiutare');
  assert.equal(dopo.code, 'PIN_REREAD');
  try { fs.chmodSync(foto, 0o500); } catch (_) {}
});

// ---- publication on filesystems that deny link(2)

function negaLinkNodo(t, code) {
  const orig = fs.linkSync;
  fs.linkSync = () => { const e = new Error(`${code}: link denied`); e.code = code; throw e; };
  t.after(() => { fs.linkSync = orig; });
}

for (const code of ['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EXDEV']) {
  test(`runtime: link ${code} still qualifies and publishes a verified 0500 copy`, async (t) => {
    const d = mondoRuntime(t);
    negaLinkNodo(t, code);
    const q = nodo.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(fs.lstatSync(q.path).mode & 0o777, 0o500);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-nolink-'));
    t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
    const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
    const p = nodo.pubblica(q, staging, d.deps);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(path.basename(p.path), q.hash);
    assert.match(path.basename(path.dirname(p.path)), /^inst-[0-9a-f]{32}$/);
    assert.equal(path.dirname(path.dirname(p.path)), staging);
    assert.equal(fs.lstatSync(p.path).mode & 0o777, 0o500);
    assert.equal(fs.lstatSync(p.path).uid, process.getuid());
    assert.equal(sha256(fs.readFileSync(p.path)), q.hash);
    // A second publication finds the object and re-verifies it.
    const again = nodo.pubblica(q, staging, d.deps);
    assert.equal(again.ok, true, JSON.stringify(again));
  });
}

test('runtime: a non-link failure is a staging failure, not a fallback', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  negaLinkNodo(t, 'ENOSPC');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-nospc-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p = nodo.pubblica(q, staging, d.deps);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'PIN_STAGE');
  assert.equal(fs.existsSync(path.join(staging, q.hash)), false);
  // Il finale vive nel namespace d'istanza: nessun oggetto creato nemmeno lì.
  const ns = fs.readdirSync(staging).find((n) => /^inst-[0-9a-f]{32}$/.test(n));
  assert.ok(ns, 'il namespace di istanza deve esistere nello staging');
  assert.equal(fs.existsSync(path.join(staging, ns, q.hash)), false);
});

// An errno outside the five link-denied codes (EIO) is a staging failure:
// the exclusive fallback must never be entered for it.
test('runtime: link EIO is a staging failure, not a fallback', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  negaLinkNodo(t, 'EIO');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-eio-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  const p = nodo.pubblica(q, staging, d.deps);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'PIN_STAGE');
  const ns = fs.readdirSync(staging).find((n) => /^inst-[0-9a-f]{32}$/.test(n));
  assert.ok(ns, 'il namespace di istanza deve esistere nello staging');
  assert.equal(fs.existsSync(path.join(staging, ns, q.hash)), false);
});

// A hard link created and removed while the stable read is in flight mutates
// ONLY the ctime of the inode: content, mtime and size stay identical. That
// is the exact mechanism of the sibling-process race on the shared snapshot
// before per-instance isolation, made deterministic on the snapshot reuse
// path (cache-hit stable read of the photograph).
test('runtime: solo ctime mutato durante la lettura rifiuta', async (t) => {
  const d = mondoRuntime(t);
  const prima = nodo.qualifica(d.deps);
  assert.equal(prima.ok, true, JSON.stringify(prima));
  const readReale = fs.readSync;
  let giaMutato = false;
  const deps = {
    ...d.deps,
    read: (fd, buf, off, len, pos) => {
      const n = readReale(fd, buf, off, len, pos);
      if (!giaMutato && n > 0) {
        giaMutato = true;
        const alias = `${prima.path}.alias`;
        fs.linkSync(prima.path, alias);
        fs.unlinkSync(alias);
      }
      return n;
    },
  };
  const dopo = nodo.qualifica(deps);
  assert.equal(dopo.ok, false, 'un ctime mutato durante la lettura stabile deve rifiutare');
  assert.equal(dopo.code, 'PIN_REREAD');
  assert.equal(dopo.motivo, 'fotografia');
  // The object stays byte-identical: the refusal can only come from ctime.
  assert.equal(sha256(fs.readFileSync(prima.path)), prima.hash);
  assert.equal(fs.lstatSync(prima.path).nlink, 1);
});

// ---- deterministic isolation between two incarnations

// Fresh copy of the module state: a new incarnation with its own nonce and
// its own caches, without touching any other require-cache entry.
function copiaFrescaModulo() {
  const modulo = require.resolve('../lib/fleet/vl-node-runtime.js');
  delete require.cache[modulo];
  return require(modulo);
}

// Two incarnations (fresh module copies), SAME deps.tmpdir and SAME home.
// B qualifies, publishes and really removes its own resources while A's
// objects stay alive. Oracle (deterministic, no timestamps relied upon for
// the red): the sets of (dev,ino) pairs of photographs, temporaries and
// per-home finals of every exercised home — including finals actually read
// through EEXIST — recorded while the objects exist, are disjoint between
// A and B (objects alive at the same time: a recycled inode is not
// sharing). nlink and ctime of A's photograph and A's final are observed
// at the BOUNDARY of every link/unlink/publication of B, not only before
// and after the whole cycle. A's cache-hit still succeeds at the end.
test('runtime: due istanze non condividono inode node (isolamento deterministico)', async (t) => {
  const d = mondoRuntime(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-iso-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');

  const ident = (p) => { const st = fs.lstatSync(p); return `${st.dev}:${st.ino}`; };
  let fase = 'A';
  const ids = { A: new Set(), B: new Set() };
  const linkReale = fs.linkSync;
  const unlinkReale = fs.unlinkSync;

  let fotoA = null;
  let finaleA = null;
  let baseFoto = null;
  let baseFinale = null;
  const confini = [];
  const bordo = () => {
    if (!fotoA || !finaleA) return;
    try {
      const f = fs.lstatSync(fotoA);
      const l = fs.lstatSync(finaleA);
      confini.push({
        foto: { dev: f.dev, ino: f.ino, nlink: f.nlink, ctimeMs: f.ctimeMs },
        finale: { dev: l.dev, ino: l.ino, nlink: l.nlink, ctimeMs: l.ctimeMs },
      });
    } catch (e) {
      confini.push({ err: e && e.message ? e.message : String(e) });
    }
  };
  // Boundary seam: every link(2)/unlink(2) of B's cycle observes A's
  // photograph and A's final before and after the call, and records the
  // identity of the source object while it is alive (the photograph
  // temporary during the snapshot publish, the photograph itself during
  // the per-home publish).
  fs.linkSync = function linkConBordo(src, dest) {
    try { ids[fase].add(ident(src)); } catch (_) { /* source vanished: not sharing */ }
    bordo();
    try {
      return linkReale(src, dest);
    } finally { bordo(); }
  };
  fs.unlinkSync = function unlinkConBordo(p) {
    bordo();
    try {
      return unlinkReale(p);
    } finally { bordo(); }
  };
  t.after(() => { fs.linkSync = linkReale; fs.unlinkSync = unlinkReale; });

  // Incarnation A warms up on the shared home.
  const qA = nodo.qualifica(d.deps);
  assert.equal(qA.ok, true, JSON.stringify(qA));
  ids.A.add(ident(qA.path));
  const pA = nodo.pubblica(qA, staging);
  assert.equal(pA.ok, true, JSON.stringify(pA));
  ids.A.add(ident(pA.path));
  fotoA = qA.path;
  finaleA = pA.path;
  const fBase = fs.lstatSync(fotoA);
  const lBase = fs.lstatSync(finaleA);
  baseFoto = { dev: fBase.dev, ino: fBase.ino, nlink: fBase.nlink, ctimeMs: fBase.ctimeMs };
  baseFinale = { dev: lBase.dev, ino: lBase.ino, nlink: lBase.nlink, ctimeMs: lBase.ctimeMs };

  // Incarnation B: fresh module copy, same tmpdir seam, same home.
  fase = 'B';
  const nodoB = copiaFrescaModulo();
  const qB = nodoB.qualifica(d.deps);
  assert.equal(qB.ok, true, JSON.stringify(qB));
  ids.B.add(ident(qB.path));
  const pB = nodoB.pubblica(qB, staging);
  assert.equal(pB.ok, true, JSON.stringify(pB));
  ids.B.add(ident(pB.path));
  assert.equal(d.viste.length, 2, 'B deve avere qualificato ex novo');

  // Disjoint (dev,ino) sets before any cleanup: identity, not a timestamp
  // jump, and not an incidental failure of the removal step.
  const condivisi = [...ids.A].filter((x) => ids.B.has(x));
  assert.equal(condivisi.length, 0, `inode condivisi fra incarnazioni: ${condivisi.join(', ')}`);
  assert.notEqual(path.dirname(qB.path), path.dirname(qA.path), 'directory d\'istanza condivisa');
  assert.notEqual(path.dirname(pB.path), path.dirname(pA.path), 'namespace per home condiviso');

  // B removes ONLY its own resources: final, namespace, photograph,
  // instance directory. The shared parent stays. The boundary hooks stay
  // installed so these unlinks are observed too.
  fs.unlinkSync(pB.path);
  fs.rmdirSync(path.dirname(pB.path));
  fs.unlinkSync(qB.path);
  fs.rmdirSync(path.dirname(qB.path));

  fs.linkSync = linkReale;
  fs.unlinkSync = unlinkReale;

  // A's photograph and final unchanged (dev, ino, nlink, ctimeMs) at every
  // boundary of B's operations, with no boundary stat error skipped.
  assert.ok(confini.length >= 4, `osservazioni ai confini insufficienti: ${confini.length}`);
  for (const [i, o] of confini.entries()) {
    assert.ok(o && !o.err, `errore lstat al confine ${i}: ${o && o.err}`);
    assert.deepEqual(o.foto, baseFoto, `identita/stato della fotografia di A mutati al confine ${i}`);
    assert.deepEqual(o.finale, baseFinale, `identita/stato del finale di A mutati al confine ${i}`);
  }

  // B really removed its own resources; A's are untouched and alive.
  assert.equal(fs.existsSync(qB.path), false, 'la fotografia di B deve essere rimossa');
  assert.equal(fs.existsSync(path.dirname(qB.path)), false, 'la directory d\'istanza di B deve essere rimossa');
  assert.equal(fs.existsSync(path.dirname(pB.path)), false, 'il namespace di B deve essere rimosso');
  assert.equal(fs.existsSync(qA.path), true, 'la fotografia di A non deve essere cancellata');
  assert.equal(fs.existsSync(pA.path), true, 'il finale di A non deve essere cancellato');
  assert.equal(fs.lstatSync(fotoA).mode & 0o777, 0o500, 'la fotografia di A e\' stata riparata');
  const fDopo = fs.lstatSync(fotoA);
  assert.deepEqual(
    { dev: fDopo.dev, ino: fDopo.ino, nlink: fDopo.nlink, ctimeMs: fDopo.ctimeMs },
    baseFoto,
    'la fotografia di A e\' mutata dopo il ciclo di B',
  );
  const lDopo = fs.lstatSync(finaleA);
  assert.deepEqual(
    { dev: lDopo.dev, ino: lDopo.ino, nlink: lDopo.nlink, ctimeMs: lDopo.ctimeMs },
    baseFinale,
    'il finale di A e\' mutato dopo il ciclo di B',
  );

  // A's cache-hit still succeeds on its own photograph, without a new probe.
  const riusoA = nodo.qualifica(d.deps);
  assert.equal(riusoA.ok, true, JSON.stringify(riusoA));
  assert.equal(riusoA.path, qA.path);
  assert.equal(d.viste.length, 2, 'il riuso di A non deve ripetere la probe');
});

// ---- single incarnation: photograph reuse across claims and homes

test('runtime: riuso della fotografia su claim ripetute e home multiple senza probe né copie', async (t) => {
  const d = mondoRuntime(t);
  const q1 = nodo.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  assert.equal(d.viste.length, 1);
  const stFoto = fs.lstatSync(q1.path);

  const homes = [];
  t.after(() => { for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) {} } });
  const namespaces = [];
  const finali = [];
  for (let i = 0; i < 3; i += 1) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-riuso-'));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
    const p = nodo.pubblica(q1, path.join(home, '.nexuscrew', 'vl-claim-pin'));
    assert.equal(p.ok, true, JSON.stringify(p));
    // The published final is a hard link to the SAME photograph: no fresh
    // copy per operation, identity stable, nlink growing only by the links.
    const stF = fs.lstatSync(p.path);
    assert.equal(stF.dev, stFoto.dev);
    assert.equal(stF.ino, stFoto.ino);
    const stDopo = fs.lstatSync(q1.path);
    assert.equal(stDopo.ino, stFoto.ino, 'la fotografia e\' stata ricreata');
    assert.equal(stDopo.nlink, stFoto.nlink + i + 1, 'nlink incoerente con i soli hard link di pubblicazione');
    namespaces.push(path.basename(path.dirname(p.path)));
    finali.push(p.path);
  }
  // One incarnation: every home shares the same instance namespace.
  assert.equal(new Set(namespaces).size, 1);
  // Cache-hit: same object again, no new probe.
  const q2 = nodo.qualifica(d.deps);
  assert.equal(q2.ok, true, JSON.stringify(q2));
  assert.equal(q2.path, q1.path);
  assert.equal(d.viste.length, 1, 'il riuso non deve ripetere la probe');

  // A NEW incarnation (fresh module copy, nothing else cleared) qualifies
  // from scratch: it does not adopt, repair or delete the previous one.
  const ctimePrima = fs.lstatSync(q1.path).ctimeMs;
  const nodo2 = copiaFrescaModulo();
  const q3 = nodo2.qualifica(d.deps);
  assert.equal(q3.ok, true, JSON.stringify(q3));
  assert.equal(d.viste.length, 2, 'la nuova incarnazione deve ripetere la probe');
  assert.notEqual(q3.path, q1.path);
  assert.notEqual(path.dirname(q3.path), path.dirname(q1.path));
  assert.notEqual(fs.lstatSync(q3.path).ino, stFoto.ino);
  const stVecchia = fs.lstatSync(q1.path);
  assert.equal(stVecchia.ino, stFoto.ino, 'la fotografia precedente e\' stata sostituita');
  assert.equal(stVecchia.nlink, stFoto.nlink + 3, 'la fotografia precedente e\' stata toccata');
  assert.equal(stVecchia.ctimeMs, ctimePrima, 'la fotografia precedente e\' stata riparata o mutata');
  // Distinct namespace on the SAME home: no adoption and no deletion.
  const p3 = nodo2.pubblica(q3, path.join(homes[0], '.nexuscrew', 'vl-claim-pin'));
  assert.equal(p3.ok, true, JSON.stringify(p3));
  assert.notEqual(path.dirname(p3.path), path.dirname(finali[0]));
  assert.equal(fs.existsSync(finali[0]), true, 'il finale della incarnazione precedente e\' stato cancellato');
  // The old incarnation still reuses its own photograph.
  const q4 = nodo.qualifica(d.deps);
  assert.equal(q4.ok, true, JSON.stringify(q4));
  assert.equal(q4.path, q1.path);
  assert.equal(d.viste.length, 2, 'il riuso della vecchia incarnazione non deve ripetere la probe');
});

test('runtime: an incomplete object under the final name is refused and never replaced', async (t) => {
  const d = mondoRuntime(t);
  const q = nodo.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  negaLinkNodo(t, 'EACCES');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-resid-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(staging, { mode: 0o700 });
  // Una prima pubblicazione crea il namespace d'istanza e il finale; il
  // finale viene poi sostituito con il residuo incompleto di un fallback
  // interrotto, al path RESTITUITO (l'unico nome finale possibile).
  const p0 = nodo.pubblica(q, staging, d.deps);
  assert.equal(p0.ok, true, JSON.stringify(p0));
  const residuo = p0.path;
  fs.rmSync(residuo);
  fs.writeFileSync(residuo, '#!/bin', { mode: 0o600 });
  const p = nodo.pubblica(q, staging, d.deps);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'PIN_REREAD');
  assert.equal(fs.readFileSync(residuo, 'utf8'), '#!/bin');
});

test('runtime: an initial EEXIST stays closed without regenerating the nonce on retries', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  const origMkdirSync = fs.mkdirSync;
  const instTargets = [];
  let planted = null;
  fs.mkdirSync = (target, opts) => {
    if (typeof target === 'string' && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
      instTargets.push(path.basename(target));
      if (!planted) {
        origMkdirSync(target, { mode: 0o755 });
        fs.writeFileSync(path.join(target, 'foreign.txt'), 'keep');
        planted = target;
      }
    }
    return origMkdirSync(target, opts);
  };
  try {
    const r1 = mod.qualifica(d.deps);
    const r2 = mod.qualifica(d.deps);
    const r3 = mod.qualifica(d.deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'PIN_DIR');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'PIN_DIR');
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'PIN_DIR');
  } finally {
    fs.mkdirSync = origMkdirSync;
  }
  assert.equal(instTargets.length, 3);
  assert.equal(new Set(instTargets).size, 1, `nonce changed across EEXIST retries: ${instTargets.join(',')}`);
  assert.deepEqual(fs.readdirSync(parent), [instTargets[0]]);
  assert.equal(fs.lstatSync(planted).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(planted, 'foreign.txt'), 'utf8'), 'keep');
});

test('runtime: a foreign collision under one parent does not mutate the foreign dir or change another parent nonce', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const exec2 = path.join(d.root, 'bin', 'node-two');
  const exec3 = path.join(d.root, 'bin', 'node-three');
  fs.copyFileSync(d.exec, exec2);
  fs.copyFileSync(d.exec, exec3);
  fs.chmodSync(exec2, 0o755);
  fs.chmodSync(exec3, 0o755);

  const p1Tmp = path.join(d.root, 'p1');
  const p2Tmp = path.join(d.root, 'p2');
  const q1 = mod.qualifica({ ...d.deps, tmpdir: p1Tmp });
  assert.equal(q1.ok, true, JSON.stringify(q1));
  const instName = path.basename(path.dirname(q1.path));
  const inst1Dir = path.dirname(q1.path);
  const inst1Ino = fs.lstatSync(inst1Dir).ino;

  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const p2Parent = path.join(p2Tmp, `nc-vl-node-${uid}`);
  fs.mkdirSync(p2Parent, { recursive: true, mode: 0o700 });
  const foreignP2Dir = path.join(p2Parent, instName);
  fs.mkdirSync(foreignP2Dir, { mode: 0o755 });
  fs.writeFileSync(path.join(foreignP2Dir, 'sentinel.txt'), 'foreign-p2');

  const r2a = mod.qualifica({ ...d.deps, execPath: exec2, tmpdir: p2Tmp });
  const r2b = mod.qualifica({ ...d.deps, execPath: exec2, tmpdir: p2Tmp });
  assert.equal(r2a.ok, false);
  assert.equal(r2a.code, 'PIN_DIR');
  assert.equal(r2b.ok, false);
  assert.equal(r2b.code, 'PIN_DIR');
  assert.deepEqual(fs.readdirSync(p2Parent), [instName]);
  assert.equal(fs.lstatSync(foreignP2Dir).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(foreignP2Dir, 'sentinel.txt'), 'utf8'), 'foreign-p2');

  const q1Next = mod.qualifica({ ...d.deps, execPath: exec3, tmpdir: p1Tmp });
  assert.equal(q1Next.ok, true, JSON.stringify(q1Next));
  assert.equal(path.dirname(q1Next.path), inst1Dir);
  assert.equal(path.basename(path.dirname(q1Next.path)), instName);
  assert.equal(fs.lstatSync(path.dirname(q1Next.path)).ino, inst1Ino);

  const staging = path.join(d.root, 'home', '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
  const pub = mod.pubblica(q1Next, staging, d.deps);
  assert.equal(pub.ok, true, JSON.stringify(pub));
  assert.equal(path.basename(path.dirname(pub.path)), instName);
});

test('runtime: a post-mkdir lstat failure binds the created directory and avoids extra allocations or scans', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  const origMkdirSync = fs.mkdirSync;
  const origChmodSync = fs.chmodSync;
  const origReaddirSync = fs.readdirSync;
  const origRmSync = fs.rmSync;
  const origRmdirSync = fs.rmdirSync;
  let mkdirInstCount = 0;
  let chmodInstCount = 0;
  let readdirParentCount = 0;
  let removeInstCount = 0;
  let failInstLstat = true;
  fs.mkdirSync = (target, opts) => {
    if (typeof target === 'string' && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
      mkdirInstCount += 1;
    }
    return origMkdirSync(target, opts);
  };
  fs.chmodSync = (target, mode) => {
    if (typeof target === 'string' && path.basename(target).startsWith('inst-')) chmodInstCount += 1;
    return origChmodSync(target, mode);
  };
  fs.readdirSync = (target, opts) => {
    if (target === parent) readdirParentCount += 1;
    return origReaddirSync(target, opts);
  };
  fs.rmSync = (target, opts) => {
    if (typeof target === 'string' && path.basename(target).startsWith('inst-')) removeInstCount += 1;
    return origRmSync(target, opts);
  };
  fs.rmdirSync = (target, opts) => {
    if (typeof target === 'string' && path.basename(target).startsWith('inst-')) removeInstCount += 1;
    return origRmdirSync(target, opts);
  };
  try {
    const deps = {
      ...d.deps,
      lstat: (target) => {
        if (failInstLstat && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
          const e = new Error('EACCES');
          e.code = 'EACCES';
          throw e;
        }
        return fs.lstatSync(target);
      },
    };
    const r1 = mod.qualifica(deps);
    const r2 = mod.qualifica(deps);
    failInstLstat = false;
    const r3 = mod.qualifica(deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'PIN_DIR');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'PIN_DIR');
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'PIN_DIR');
  } finally {
    fs.mkdirSync = origMkdirSync;
    fs.chmodSync = origChmodSync;
    fs.readdirSync = origReaddirSync;
    fs.rmSync = origRmSync;
    fs.rmdirSync = origRmdirSync;
  }
  assert.equal(mkdirInstCount, 1);
  assert.equal(chmodInstCount, 0);
  assert.equal(readdirParentCount, 0);
  assert.equal(removeInstCount, 0);
  assert.equal(fs.readdirSync(parent).filter((n) => n.startsWith('inst-')).length, 1);
});

test('runtime: a restrictive umask qualification failure never creates extra instance directories', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  const origMkdirSync = fs.mkdirSync;
  const origChmodSync = fs.chmodSync;
  let mkdirInstCount = 0;
  let chmodInstCount = 0;
  fs.mkdirSync = (target, opts) => {
    if (typeof target === 'string' && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
      mkdirInstCount += 1;
    }
    return origMkdirSync(target, opts);
  };
  fs.chmodSync = (target, mode) => {
    if (typeof target === 'string' && path.basename(target).startsWith('inst-')) chmodInstCount += 1;
    return origChmodSync(target, mode);
  };
  origMkdirSync(parent, { recursive: true, mode: 0o700 });
  const prevUmask = process.umask(0o177);
  t.after(() => process.umask(prevUmask));
  try {
    const r1 = mod.qualifica(d.deps);
    const r2 = mod.qualifica(d.deps);
    process.umask(prevUmask);
    const r3 = mod.qualifica(d.deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'PIN_DIR');
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'PIN_DIR');
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'PIN_DIR');
  } finally {
    process.umask(prevUmask);
    fs.mkdirSync = origMkdirSync;
    fs.chmodSync = origChmodSync;
  }
  assert.equal(mkdirInstCount, 1);
  assert.equal(chmodInstCount, 0);
  assert.equal(fs.readdirSync(parent).filter((n) => n.startsWith('inst-')).length, 1);
});

test('runtime: a failed parent fsync retries sync on the same instance directory without recreating it', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
  const origMkdirSync = fs.mkdirSync;
  let mkdirInstCount = 0;
  let failFsync = true;
  fs.mkdirSync = (target, opts) => {
    if (typeof target === 'string' && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
      mkdirInstCount += 1;
    }
    return origMkdirSync(target, opts);
  };
  try {
    const deps = {
      ...d.deps,
      fsync: (fd) => {
        if (failFsync) {
          const e = new Error('EIO');
          e.code = 'EIO';
          throw e;
        }
        fs.fsyncSync(fd);
      },
    };
    const r1 = mod.qualifica(deps);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'PIN_STAGE');
    const created = fs.readdirSync(parent).filter((n) => n.startsWith('inst-'));
    assert.equal(created.length, 1);
    failFsync = false;
    const r2 = mod.qualifica(deps);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(path.dirname(r2.path), path.join(parent, created[0]));
  } finally {
    fs.mkdirSync = origMkdirSync;
  }
  assert.equal(mkdirInstCount, 1);
});

test('runtime: a cache hit refuses read-only without recreating a deleted container or snapshot', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const q1 = mod.qualifica(d.deps);
  assert.equal(q1.ok, true, JSON.stringify(q1));
  assert.equal(d.viste.length, 1);
  const srcBefore = fs.readFileSync(d.exec);
  const dirFoto = path.dirname(q1.path);
  fs.rmSync(dirFoto, { recursive: true, force: true });

  const origMkdirSync = fs.mkdirSync;
  let mkdirCalls = 0;
  fs.mkdirSync = (...args) => {
    mkdirCalls += 1;
    return origMkdirSync(...args);
  };
  try {
    const q2 = mod.qualifica(d.deps);
    assert.equal(q2.ok, false);
    assert.equal(q2.code, 'PIN_REREAD');
    assert.equal(q2.motivo, 'fotografia');
  } finally {
    fs.mkdirSync = origMkdirSync;
  }
  assert.equal(mkdirCalls, 0);
  assert.equal(fs.existsSync(dirFoto), false);
  assert.equal(fs.existsSync(q1.path), false);
  assert.equal(d.viste.length, 1);
  assert.deepEqual(fs.readFileSync(d.exec), srcBefore);
});

test('registry: snapshot accessor is deeply frozen and never leaks mutable internal references', (t) => {
  const mod = copiaFrescaModulo();
  const initial = mod.getCreationRegistry();
  assert.equal(initial.nonce, null);
  assert.deepEqual(initial.entries, []);
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.entries));
  assert.throws(() => { initial.entries.push({}); }, TypeError);

  const d = mondoRuntime(t);
  const q = mod.qualifica(d.deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const snap1 = mod.getCreationRegistry();
  assert.ok(typeof snap1.nonce === 'string' && snap1.nonce.length === 32);
  assert.ok(snap1.entries.length >= 3);
  assert.ok(Object.isFrozen(snap1.entries[0]));
  assert.throws(() => { snap1.entries[0].cleanupAllowed = false; }, TypeError);
  const snap2 = mod.getCreationRegistry();
  assert.notStrictEqual(snap1, snap2);
  assert.equal(snap2.entries[0].cleanupAllowed, true);
});

test('registry state 1 (not-created): failed mkdir/open and foreign EEXIST across dirs, namespaces, tmp, and finals are never owned', (t) => {
  // 1a. Missing instance parent (failed mkdir)
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const r = mod.qualifica({
      ...d.deps,
      mkdir: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_DIR');
    assert.deepEqual(mod.getCreationRegistry().owned, []);
  }

  // 1b. Foreign EEXIST on instance-dir -> not-created, cleanupAllowed false across retries
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
    const origMkdirSync = fs.mkdirSync;
    let planted = null;
    fs.mkdirSync = (target, opts) => {
      if (typeof target === 'string' && path.dirname(target) === parent && path.basename(target).startsWith('inst-') && !planted) {
        origMkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(path.join(target, 'keep.txt'), 'foreign');
        planted = target;
      }
      return origMkdirSync(target, opts);
    };
    try {
      const r1 = mod.qualifica(d.deps);
      const r2 = mod.qualifica(d.deps);
      assert.equal(r1.ok, false);
      assert.equal(r1.code, 'PIN_DIR');
      assert.equal(r2.ok, false);
      assert.equal(r2.code, 'PIN_DIR');
    } finally {
      fs.mkdirSync = origMkdirSync;
    }
    const snap = mod.getCreationRegistry();
    assert.equal(snap.instanceDirs.length, 1);
    assert.equal(snap.instanceDirs[0].state, 'not-created');
    assert.equal(snap.instanceDirs[0].cleanupAllowed, false);
    assert.equal(snap.instanceDirs[0].dev, null);
    assert.equal(snap.instanceDirs[0].ino, null);
    assert.deepEqual(snap.owned, []);
    assert.equal(fs.readFileSync(path.join(planted, 'keep.txt'), 'utf8'), 'foreign');
  }

  // 1c. openSync failure on .tmp -> temp-file recorded as not-created
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origOpen = fs.openSync;
    const r = mod.qualifica({
      ...d.deps,
      open: (p, flags, mode) => {
        if (typeof p === 'string' && p.includes('.tmp-')) {
          const e = new Error('EACCES');
          e.code = 'EACCES';
          throw e;
        }
        return origOpen(p, flags, mode);
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
    const snap = mod.getCreationRegistry();
    assert.equal(snap.tempFiles.length, 1);
    assert.equal(snap.tempFiles[0].state, 'not-created');
    assert.equal(snap.tempFiles[0].cleanupAllowed, false);
    assert.equal(snap.tempFiles[0].cause, 'EACCES');
  }

  // 1d. Foreign EEXIST on home-namespace and home-final (even if preexisting file passes verify)
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    const nonce = mod.getCreationRegistry().nonce;

    const stagingForeignNs = path.join(d.root, 'home-foreign-ns', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.join(stagingForeignNs, `inst-${nonce}`), { recursive: true, mode: 0o700 });
    const pNs = mod.pubblica(q, stagingForeignNs, d.deps);
    assert.equal(pNs.ok, false);
    assert.equal(pNs.code, 'PIN_DIR');

    // Race EEXIST on home-final via pubblicaEsclusiva during home publication
    const stagingRaceFinal = path.join(d.root, 'home-eexist-final', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.dirname(stagingRaceFinal), { recursive: true, mode: 0o700 });
    const nsDir = path.join(stagingRaceFinal, `inst-${nonce}`);
    const finalDest = path.join(nsDir, q.hash);
    const origLink = fs.linkSync;
    fs.linkSync = (src, dest) => {
      if (dest === finalDest) {
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, 0o500);
        const e = new Error('EEXIST');
        e.code = 'EEXIST';
        throw e;
      }
      return origLink(src, dest);
    };
    try {
      const pFinal = mod.pubblica(q, stagingRaceFinal, d.deps);
      assert.equal(pFinal.ok, true, JSON.stringify(pFinal));
    } finally {
      fs.linkSync = origLink;
    }
    const snap = mod.getCreationRegistry();
    const foreignNsEntry = snap.homeNamespaces.find((e) => e.path === path.join(stagingForeignNs, `inst-${nonce}`));
    assert.ok(foreignNsEntry);
    assert.equal(foreignNsEntry.state, 'not-created');
    assert.equal(foreignNsEntry.cleanupAllowed, false);

    const foreignFinalEntry = snap.homeFinals.find((e) => e.path === finalDest);
    assert.ok(foreignFinalEntry);
    assert.equal(foreignFinalEntry.state, 'not-created');
    assert.equal(foreignFinalEntry.cleanupAllowed, false);
    assert.equal(foreignFinalEntry.dev, null);
    assert.equal(foreignFinalEntry.ino, null);
  }
});

test('registry state 2 (created-identity-unknown): lstat/fstat failures never allow cleanup and never backfill on later stat success', (t) => {
  // 2a. instance-dir post-mkdir lstat failure with late stat clearance on retry
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
    let failLstat = true;
    const deps = {
      ...d.deps,
      lstat: (target) => {
        if (failLstat && path.dirname(target) === parent && path.basename(target).startsWith('inst-')) {
          const e = new Error('EACCES');
          e.code = 'EACCES';
          throw e;
        }
        return fs.lstatSync(target);
      },
    };
    assert.equal(mod.qualifica(deps).code, 'PIN_DIR');
    failLstat = false;
    assert.equal(mod.qualifica(deps).code, 'PIN_DIR');
    const snap = mod.getCreationRegistry();
    assert.equal(snap.instanceDirs.length, 1);
    const entry = snap.instanceDirs[0];
    assert.equal(entry.state, 'created-identity-unknown');
    assert.equal(entry.dev, null);
    assert.equal(entry.ino, null);
    assert.equal(entry.uid, null);
    assert.equal(entry.mode, null);
    assert.equal(entry.qualified, false);
    assert.equal(entry.cleanupAllowed, false);
  }

  // 2b. home-namespace post-mkdir lstat failure with late stat clearance on retry
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true);
    const staging = path.join(d.root, 'home-ns-unknown', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    const nsName = `inst-${mod.getCreationRegistry().nonce}`;
    const nsPath = path.join(staging, nsName);
    let failNsLstat = true;
    const deps = {
      ...d.deps,
      lstat: (target) => {
        if (target === nsPath) {
          // Pre-check calls lstat before mkdirSync (expects ENOENT); only fail after mkdirSync exists
          let exists = false;
          try { fs.lstatSync(target); exists = true; } catch (_) {}
          if (exists && failNsLstat) {
            const e = new Error('EIO');
            e.code = 'EIO';
            throw e;
          }
        }
        return fs.lstatSync(target);
      },
    };
    assert.equal(mod.pubblica(q, staging, deps).code, 'PIN_DIR');
    failNsLstat = false;
    assert.equal(mod.pubblica(q, staging, deps).code, 'PIN_DIR');
    const entry = mod.getCreationRegistry().homeNamespaces.find((e) => e.path === nsPath);
    assert.ok(entry);
    assert.equal(entry.state, 'created-identity-unknown');
    assert.equal(entry.dev, null);
    assert.equal(entry.ino, null);
    assert.equal(entry.cleanupAllowed, false);
    assert.equal(fs.lstatSync(nsPath).isDirectory(), true);
  }

  // 2c. temp-file fstatSync failure with residual .tmp on disk: never backfills
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origFstat = fs.fstatSync;
    let failTmpFstat = true;
    const deps = {
      ...d.deps,
      fstat: (fd) => {
        if (failTmpFstat) {
          // Only trigger once .tmp fd is open (source node fd already ran through qualifica)
          try {
            const st = origFstat(fd);
            if (st.size === 0) {
              failTmpFstat = false;
              const e = new Error('EIO: tmp fstat');
              e.code = 'EIO';
              throw e;
            }
            return st;
          } catch (err) {
            throw err;
          }
        }
        return origFstat(fd);
      },
      unlink: () => {
        const e = new Error('EPERM: residual tmp');
        e.code = 'EPERM';
        throw e;
      },
    };
    const r = mod.qualifica(deps);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
    const snap = mod.getCreationRegistry();
    assert.equal(snap.tempFiles.length, 1);
    const tmpEntry = snap.tempFiles[0];
    assert.equal(tmpEntry.state, 'created-identity-unknown');
    assert.equal(tmpEntry.dev, null);
    assert.equal(tmpEntry.ino, null);
    assert.equal(tmpEntry.cleanupAllowed, false);
    assert.equal(tmpEntry.unlinked, false);
    assert.equal(fs.existsSync(tmpEntry.path), true);
  }

  // 2d. wx uncertain-after-create without fstat identity -> created-identity-unknown, no backfill
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true);
    const staging = path.join(d.root, 'home-wx-unknown', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    const origLink = fs.linkSync;
    const origFstat = fs.fstatSync;
    fs.linkSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    fs.fstatSync = (fd) => {
      const st = origFstat(fd);
      if (st.isFile() && st.size === 0) {
        const e = new Error('EIO');
        e.code = 'EIO';
        throw e;
      }
      return st;
    };
    try {
      const p = mod.pubblica(q, staging, d.deps);
      assert.equal(p.ok, false);
      assert.equal(p.code, 'PIN_REREAD');
    } finally {
      fs.linkSync = origLink;
      fs.fstatSync = origFstat;
    }
    const entry = mod.getCreationRegistry().homeFinals[0];
    assert.ok(entry);
    assert.equal(entry.state, 'created-identity-unknown');
    assert.equal(entry.dev, null);
    assert.equal(entry.ino, null);
    assert.equal(entry.cleanupAllowed, false);
    assert.equal(fs.existsSync(entry.path), true);
  }
});

test('registry state 3 (created-unqualified): preserves dev/ino/uid/mode/cause for dirs, residual tmp, link failure, and uncertain wx', (t) => {
  // 3a. instance-dir under restrictive umask -> created-unqualified with exact mode/ino, cleanupAllowed false
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const parent = path.join(d.deps.tmpdir, `nc-vl-node-${uid}`);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const prev = process.umask(0o177);
    t.after(() => process.umask(prev));
    try {
      assert.equal(mod.qualifica(d.deps).code, 'PIN_DIR');
    } finally {
      process.umask(prev);
    }
    const entry = mod.getCreationRegistry().instanceDirs[0];
    assert.ok(entry);
    const st = fs.lstatSync(entry.path);
    assert.equal(entry.state, 'created-unqualified');
    assert.equal(entry.dev, st.dev);
    assert.equal(entry.ino, st.ino);
    assert.equal(entry.uid, st.uid);
    assert.equal(entry.mode, 0o600);
    assert.equal(entry.qualified, false);
    assert.equal(entry.cleanupAllowed, false);
    assert.equal(entry.cause, 'unqualified-dir');
  }

  // 3b. home-namespace under restrictive umask
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true);
    const staging = path.join(d.root, 'home-umask-ns', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const prev = process.umask(0o177);
    t.after(() => process.umask(prev));
    try {
      assert.equal(mod.pubblica(q, staging, d.deps).code, 'PIN_DIR');
    } finally {
      process.umask(prev);
    }
    const entry = mod.getCreationRegistry().homeNamespaces[0];
    assert.ok(entry);
    const st = fs.lstatSync(entry.path);
    assert.equal(entry.state, 'created-unqualified');
    assert.equal(entry.dev, st.dev);
    assert.equal(entry.ino, st.ino);
    assert.equal(entry.uid, st.uid);
    assert.equal(entry.mode, 0o600);
    assert.equal(entry.qualified, false);
    assert.equal(entry.cleanupAllowed, false);
    assert.equal(entry.cause, 'unqualified-dir');
  }

  // 3c. residual .tmp after failed fsync + failed unlink -> created-unqualified with fstat dev/ino/uid/mode/cause
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origFstat = fs.fstatSync;
    const r = mod.qualifica({
      ...d.deps,
      fsync: (fd) => {
        if (origFstat(fd).isFile()) {
          const e = new Error('EIO');
          e.code = 'EIO';
          throw e;
        }
        fs.fsyncSync(fd);
      },
      unlink: () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
    const snap = mod.getCreationRegistry();
    const tmpEntry = snap.tempFiles[0];
    assert.ok(tmpEntry);
    const stTmp = fs.lstatSync(tmpEntry.path);
    assert.equal(tmpEntry.state, 'created-unqualified');
    assert.equal(tmpEntry.dev, stTmp.dev);
    assert.equal(tmpEntry.ino, stTmp.ino);
    assert.equal(tmpEntry.uid, stTmp.uid);
    assert.equal(tmpEntry.mode, 0o500);
    assert.equal(tmpEntry.qualified, false);
    assert.equal(tmpEntry.unlinked, false);
    assert.equal(tmpEntry.cleanupAllowed, true);
    assert.equal(tmpEntry.cause, 'EIO');
    assert.ok(snap.partials.some((e) => e.path === tmpEntry.path));
  }

  // 3d. wx uncertain-after-create with created {dev, ino} preserves full metadata & cleanupAllowed
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true);
    const staging = path.join(d.root, 'home-wx-uncertain', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    const origLink = fs.linkSync;
    const origFsync = fs.fsyncSync;
    fs.linkSync = () => { const e = new Error('EXDEV'); e.code = 'EXDEV'; throw e; };
    fs.fsyncSync = () => { const e = new Error('EIO: disk'); e.code = 'EIO'; throw e; };
    try {
      const p = mod.pubblica(q, staging, d.deps);
      assert.equal(p.ok, false);
      assert.equal(p.code, 'PIN_REREAD');
    } finally {
      fs.linkSync = origLink;
      fs.fsyncSync = origFsync;
    }
    const snap = mod.getCreationRegistry();
    const finalEntry = snap.homeFinals[0];
    assert.ok(finalEntry);
    const st = fs.lstatSync(finalEntry.path);
    assert.equal(finalEntry.state, 'created-unqualified');
    assert.equal(finalEntry.dev, st.dev);
    assert.equal(finalEntry.ino, st.ino);
    assert.equal(finalEntry.uid, st.uid);
    assert.equal(finalEntry.mode, 0o600);
    assert.equal(finalEntry.qualified, false);
    assert.equal(finalEntry.cleanupAllowed, true);
    assert.equal(finalEntry.cause, 'EIO');
    assert.ok(snap.partials.some((e) => e.path === finalEntry.path));
  }

  // 3e. link publish whose post-link qualification fails -> snapshot-file in created-unqualified
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origLstat = fs.lstatSync;
    const origLink = fs.linkSync;
    let linkedDest = null;
    fs.linkSync = (src, dest) => {
      linkedDest = dest;
      return origLink(src, dest);
    };
    let failedPostLink = false;
    try {
      const r = mod.qualifica({
        ...d.deps,
        lstat: (target) => {
          if (linkedDest && target === linkedDest && !failedPostLink) {
            failedPostLink = true;
            const e = new Error('EIO: post-link lstat');
            e.code = 'EIO';
            throw e;
          }
          return origLstat(target);
        },
      });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PIN_REREAD');
    } finally {
      fs.linkSync = origLink;
    }
    const sf = mod.getCreationRegistry().snapshots.find((e) => e.path === linkedDest);
    assert.ok(sf);
    const stDest = fs.lstatSync(linkedDest);
    assert.equal(sf.state, 'created-unqualified');
    assert.equal(sf.dev, stDest.dev);
    assert.equal(sf.ino, stDest.ino);
    assert.equal(sf.uid, stDest.uid);
    assert.equal(sf.mode, stDest.mode & 0o777);
    assert.equal(sf.qualified, false);
    assert.equal(sf.cleanupAllowed, true);
    assert.equal(sf.cause, 'leggiFinale-failed');
  }
});

test('registry state 4 (qualified-unsynced): fsync failure stays qualified-unsynced across failed retries and advances cleanly when sync succeeds', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  let failDirFsync = false;
  let blockReads = false;
  const origFstat = fs.fstatSync;
  const origLstat = fs.lstatSync;
  const deps = {
    ...d.deps,
    fsync: (fd) => {
      const st = origFstat(fd);
      if (failDirFsync && st.isDirectory()) {
        const e = new Error('EIO: dir sync');
        e.code = 'EIO';
        throw e;
      }
      fs.fsyncSync(fd);
    },
    lstat: (target) => {
      if (blockReads && typeof target === 'string' && target.includes('vl-claim-pin')) {
        const e = new Error('EIO: read');
        e.code = 'EIO';
        throw e;
      }
      return origLstat(target);
    },
  };

  // First succeed snapshot sync, then fail fsync on publica (home-namespace + home-final)
  const q = mod.qualifica(deps);
  assert.equal(q.ok, true, JSON.stringify(q));
  const staging = path.join(d.root, 'home-state4', '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
  failDirFsync = true;
  const p1 = mod.pubblica(q, staging, deps);
  assert.equal(p1.ok, false);
  assert.equal(p1.code, 'PIN_STAGE');

  const snap1 = mod.getCreationRegistry();
  const ns1 = snap1.homeNamespaces[0];
  const fin1 = snap1.homeFinals[0];
  // Presence first: a registry that lost the entries must fail on the
  // assertion below, not on a TypeError reading .state of undefined.
  assert.ok(ns1, 'the home-namespace entry must be present');
  assert.ok(fin1, 'the home-final entry must be present');
  assert.equal(ns1.state, 'qualified-unsynced');
  assert.equal(ns1.qualified, true);
  assert.equal(ns1.durabilitySynced, false);
  assert.equal(ns1.cleanupAllowed, true);
  assert.equal(fin1.state, 'qualified-unsynced');
  assert.equal(fin1.qualified, true);
  assert.equal(fin1.durabilitySynced, false);
  assert.equal(fin1.cleanupAllowed, true);
  assert.ok(Number.isSafeInteger(fin1.ino));

  // Second attempt hits EEXIST on home-final + failing dir fsync -> must preserve State 4!
  const p2 = mod.pubblica(q, staging, deps);
  assert.equal(p2.ok, false);
  assert.equal(p2.code, 'PIN_STAGE');
  const snap2 = mod.getCreationRegistry();
  const ns2 = snap2.homeNamespaces[0];
  const fin2 = snap2.homeFinals[0];
  assert.ok(ns2, 'the home-namespace entry must survive the retry');
  assert.ok(fin2, 'the home-final entry must survive the retry');
  assert.equal(ns2.state, 'qualified-unsynced');
  assert.equal(fin2.state, 'qualified-unsynced');
  assert.equal(fin2.ino, fin1.ino);
  assert.equal(fin2.cleanupAllowed, true);

  // Another failing retry on an unrelated path error still keeps State 4 intact
  blockReads = true;
  assert.equal(mod.pubblica(q, staging, deps).ok, false);
  blockReads = false;
  const snap2b = mod.getCreationRegistry();
  assert.ok(snap2b.homeFinals[0], 'the home-final entry must survive the failing retry');
  assert.equal(snap2b.homeFinals[0].state, 'qualified-unsynced');

  // Healthy retry finally completes fsync -> transitions to qualified-synced
  failDirFsync = false;
  const p3 = mod.pubblica(q, staging, deps);
  assert.equal(p3.ok, true, JSON.stringify(p3));
  const snap3 = mod.getCreationRegistry();
  const ns3 = snap3.homeNamespaces[0];
  const fin3 = snap3.homeFinals[0];
  assert.ok(ns3, 'the home-namespace entry must be present after the healthy retry');
  assert.ok(fin3, 'the home-final entry must be present after the healthy retry');
  assert.equal(ns3.state, 'qualified-synced');
  assert.equal(ns3.durabilitySynced, true);
  assert.equal(fin3.state, 'qualified-synced');
  assert.equal(fin3.durabilitySynced, true);
  assert.equal(fin3.ino, fin1.ino);
});

test('registry state 5 (qualified-synced): tracks instance-dir, snapshot, home-namespace, and home-final via both link and wx paths', (t) => {
  // 5a. via link(2)
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    const staging = path.join(d.root, 'home-link', '.nexuscrew', 'vl-claim-pin');
    fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
    const pub = mod.pubblica(q, staging, d.deps);
    assert.equal(pub.ok, true, JSON.stringify(pub));

    const snap = mod.getCreationRegistry();
    assert.equal(snap.instanceDirs.length, 1);
    assert.equal(snap.snapshots.length, 1);
    assert.equal(snap.homeNamespaces.length, 1);
    assert.equal(snap.homeFinals.length, 1);
    assert.equal(snap.tempFiles.length, 1);

    for (const entry of [snap.instanceDirs[0], snap.snapshots[0], snap.homeNamespaces[0], snap.homeFinals[0]]) {
      const st = fs.lstatSync(entry.path);
      assert.equal(entry.state, 'qualified-synced');
      assert.equal(entry.qualified, true);
      assert.equal(entry.durabilitySynced, true);
      assert.equal(entry.cleanupAllowed, true);
      assert.equal(entry.dev, st.dev);
      assert.equal(entry.ino, st.ino);
      assert.equal(entry.uid, st.uid);
      assert.equal(entry.mode, st.mode & 0o777);
      assert.equal(entry.nonce, snap.nonce);
    }
    assert.equal(snap.homeFinals[0].ino, snap.snapshots[0].ino);
    // The temporary's descriptor was synced, but the directory entry of its
    // name was never fsynced before the removal: it stays qualified-unsynced
    // and only records the fileSynced proof, never durability.
    assert.equal(snap.tempFiles[0].state, 'qualified-unsynced');
    assert.equal(snap.tempFiles[0].fileSynced, true);
    assert.equal(snap.tempFiles[0].durabilitySynced, false);
    assert.equal(snap.tempFiles[0].unlinked, true);
    assert.equal(snap.tempFiles[0].cleanupAllowed, false);
  }

  // 5b. via wx fallback (linkSync denied) -> snapshot and home-final are distinct inodes
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origLink = fs.linkSync;
    fs.linkSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
    let q;
    let pub;
    try {
      q = mod.qualifica(d.deps);
      assert.equal(q.ok, true, JSON.stringify(q));
      const staging = path.join(d.root, 'home-wx', '.nexuscrew', 'vl-claim-pin');
      fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
      pub = mod.pubblica(q, staging, d.deps);
      assert.equal(pub.ok, true, JSON.stringify(pub));
    } finally {
      fs.linkSync = origLink;
    }
    const snap = mod.getCreationRegistry();
    const sf = snap.snapshots[0];
    const hf = snap.homeFinals[0];
    assert.equal(sf.state, 'qualified-synced');
    assert.equal(hf.state, 'qualified-synced');
    assert.equal(sf.cleanupAllowed, true);
    assert.equal(hf.cleanupAllowed, true);
    assert.notEqual(hf.ino, sf.ino, 'wx fallback produces distinct snapshot and per-home final inodes');
    assert.equal(hf.ino, fs.lstatSync(pub.path).ino);
    assert.equal(sf.ino, fs.lstatSync(q.path).ino);
  }
});

// A failed fstat of the freshly created temporary leaves a residual whose
// identity is unknown: the name is never removed, because after the close
// of the descriptor it may already point to a substitute object this
// incarnation never created.
test('registry: a failed fstat of the created temporary never unlinks the unknown residual', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const origFstat = fs.fstatSync;
  const origOpen = fs.openSync;
  const origClose = fs.closeSync;
  const origUnlink = fs.unlinkSync;
  const origRename = fs.renameSync;
  const origWriteFileSync = fs.writeFileSync;
  let tmpFd = null;
  let tmpPath = null;
  let substituted = false;
  let unlinkCalls = 0;
  const deps = {
    ...d.deps,
    open: (p, flags, mode) => {
      const fd = origOpen(p, flags, mode);
      if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
        tmpFd = fd;
        tmpPath = p;
      }
      return fd;
    },
    fstat: (fd) => {
      if (fd === tmpFd) {
        const e = new Error('EIO: tmp fstat');
        e.code = 'EIO';
        throw e;
      }
      return origFstat(fd);
    },
    close: (fd) => {
      if (fd === tmpFd && !substituted) {
        // Between the failed identity read and the closed descriptor the
        // name starts pointing at a substitute object: a pathname removal
        // would delete exactly that substitute.
        substituted = true;
        origRename(tmpPath, `${tmpPath}.originale`);
        origWriteFileSync(tmpPath, 'sentinel', { mode: 0o400 });
      }
      return origClose(fd);
    },
    unlink: (p) => {
      if (p === tmpPath) unlinkCalls += 1;
      return origUnlink(p);
    },
  };
  const r = mod.qualifica(deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_STAGE');
  assert.ok(tmpPath, 'the temporary must have been created and opened');
  assert.equal(substituted, true, 'the substitute must be in place before any removal could run');
  assert.equal(unlinkCalls, 0, 'the unknown residual must never be removed by pathname');
  const snap = mod.getCreationRegistry();
  const entry = snap.tempFiles[0];
  assert.ok(entry);
  assert.equal(entry.state, 'created-identity-unknown');
  assert.equal(entry.unlinked, false);
  assert.equal(entry.cleanupAllowed, false);
  assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'sentinel', 'the substitute must be preserved');
});

// A successful fsync of the temporary's descriptor attests the file object
// only: durability of the NAME requires the directory fsync, which can fail
// or never happen when the publication fails. The registry must keep the
// promise separated (fileSynced vs durabilitySynced) and must reflect the
// post-fchmod mode read from the same descriptor.
test('registry: a synced temporary never claims durability and records the post-fchmod mode from its descriptor', (t) => {
  const origFstat = fs.fstatSync;

  // A. File synced, publication fine, name removed, DIRECTORY fsync failed:
  //    the removed temporary stays qualified-unsynced with fileSynced=true.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    // The first directory fsync is the private parent of the instance
    // directory; only the snapshot directory sync (after the publication)
    // must fail.
    let dirSyncs = 0;
    const r = mod.qualifica({
      ...d.deps,
      fsync: (fd) => {
        if (origFstat(fd).isDirectory()) {
          dirSyncs += 1;
          if (dirSyncs > 1) { const e = new Error('EIO: dir'); e.code = 'EIO'; throw e; }
        }
        fs.fsyncSync(fd);
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
    const snap = mod.getCreationRegistry();
    const tmpEntry = snap.tempFiles[0];
    assert.ok(tmpEntry, 'the temporary entry must exist');
    assert.equal(tmpEntry.state, 'qualified-unsynced');
    assert.equal(tmpEntry.fileSynced, true);
    assert.equal(tmpEntry.durabilitySynced, false);
    assert.equal(tmpEntry.unlinked, true);
    assert.equal(tmpEntry.cleanupAllowed, false);
  }

  // B. File synced, publication refused before create, removal failed:
  //    the residual keeps qualified-unsynced and never durabilitySynced.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const origLink = fs.linkSync;
    fs.linkSync = () => { const e = new Error('EIO: link'); e.code = 'EIO'; throw e; };
    let r;
    try {
      r = mod.qualifica({
        ...d.deps,
        unlink: () => { const e = new Error('EIO: unlink'); e.code = 'EIO'; throw e; },
      });
    } finally {
      fs.linkSync = origLink;
    }
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
    const snap = mod.getCreationRegistry();
    const tmpEntry = snap.tempFiles[0];
    assert.ok(tmpEntry, 'the temporary entry must exist');
    assert.equal(tmpEntry.state, 'qualified-unsynced');
    assert.equal(tmpEntry.fileSynced, true);
    assert.equal(tmpEntry.durabilitySynced, false);
    assert.equal(tmpEntry.unlinked, false);
    assert.equal(tmpEntry.cleanupAllowed, true);
    const st = fs.lstatSync(tmpEntry.path);
    assert.equal(st.mode & 0o777, 0o500);
    assert.equal(tmpEntry.dev, st.dev);
    assert.equal(tmpEntry.ino, st.ino);
  }

  // C. Born 0400 under a restrictive umask, fchmod'ed to 0500: the recorded
  //    mode is the one read back from the same descriptor (0500, same inode),
  //    not the initial 0400 seen at creation.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const exec2 = path.join(d.root, 'bin', 'node-two');
    fs.copyFileSync(d.exec, exec2);
    fs.chmodSync(exec2, 0o755);
    const q1 = mod.qualifica(d.deps);
    assert.equal(q1.ok, true, JSON.stringify(q1));
    fs.rmSync(q1.path);
    const prevUmask = process.umask(0o177);
    let q2;
    try {
      q2 = mod.qualifica({
        ...d.deps,
        execPath: exec2,
        unlink: () => { const e = new Error('EIO: unlink'); e.code = 'EIO'; throw e; },
      });
    } finally {
      process.umask(prevUmask);
    }
    assert.equal(q2.ok, true, JSON.stringify(q2));
    const snap = mod.getCreationRegistry();
    const residuo = snap.tempFiles.find((e) => e.unlinked === false);
    assert.ok(residuo, 'the residual temporary entry must exist');
    const st = fs.lstatSync(residuo.path);
    assert.equal(st.mode & 0o777, 0o500, 'the file on disk must be 0500 after fchmod');
    assert.equal(residuo.mode, 0o500, 'the recorded mode must be the post-fchmod one');
    assert.equal(residuo.dev, st.dev, 'the residual must keep the created inode');
    assert.equal(residuo.ino, st.ino, 'the residual must keep the created inode');
    assert.equal(residuo.state, 'qualified-unsynced');
    assert.equal(residuo.fileSynced, true);
    assert.equal(residuo.durabilitySynced, false);
  }
});

// One-shot substitution seam: the first successful lstat of a content-named
// final inside scopeDir swaps the object for byte-identical content under a
// NEW inode (same uid, 0500). It fires between the publication and the
// registry reread, exactly where a same-uid actor can replace the name.
function seamSostituzione(scopeDir, bytes) {
  const origLstat = fs.lstatSync;
  const info = { fired: false, origin: null, substitute: null };
  const wrap = (deps) => ({
    ...deps,
    lstat: (p) => {
      const st = origLstat(p);
      if (!info.fired && typeof p === 'string' && p.startsWith(scopeDir + path.sep)
        && /^[0-9a-f]{64}$/.test(path.basename(p)) && st.isFile()) {
        info.fired = true;
        info.origin = { dev: st.dev, ino: st.ino };
        // Rename keeps the original inode alive (no inode-number recycling):
        // the substitute is a genuinely new object.
        fs.renameSync(p, `${p}.originale`);
        fs.writeFileSync(p, bytes, { mode: 0o500 });
        fs.chmodSync(p, 0o500);
        const dopo = origLstat(p);
        info.substitute = { dev: dopo.dev, ino: dopo.ino };
        return dopo;
      }
      return st;
    },
  });
  return { info, wrap };
}

// A byte-identical substitute placed between the publication and the reread
// must never be owned: the registry keeps the identity captured at creation
// and the operation fails closed, on both publication paths and both
// targets (snapshot and per-home final).
test('registry: a byte-identical substitute at the reread is never owned', (t) => {
  const CONTENUTO = '#!/bin/sh\nexit 0\n';

  const casi = [
    {
      nome: 'snapshot via link',
      wx: false,
      esegui: (mod, deps) => mod.qualifica(deps),
      entry: (snap) => snap.snapshots[0],
    },
    {
      nome: 'snapshot via exclusive create',
      wx: true,
      esegui: (mod, deps) => mod.qualifica(deps),
      entry: (snap) => snap.snapshots[0],
    },
    {
      nome: 'home-final via link',
      wx: false,
      esegui: (mod, deps, q) => mod.pubblica(q, deps.staging, deps.deps),
      entry: (snap) => snap.homeFinals[0],
    },
    {
      nome: 'home-final via exclusive create',
      wx: true,
      esegui: (mod, deps, q) => mod.pubblica(q, deps.staging, deps.deps),
      entry: (snap) => snap.homeFinals[0],
    },
  ];

  for (const caso of casi) {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t, { bin: CONTENUTO });
    let q = null;
    let scopeDir;
    let seamDeps;
    if (caso.nome.startsWith('snapshot')) {
      scopeDir = path.join(d.deps.tmpdir, `nc-vl-node-${process.getuid()}`);
      const { info, wrap } = seamSostituzione(scopeDir, CONTENUTO);
      seamDeps = wrap(d.deps);
      caso.info = info;
      caso.eseguiArgs = [mod, seamDeps];
    } else {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-subst-'));
      t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
      fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
      const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
      // Qualify cleanly first: the substitution targets the per-home final.
      q = mod.qualifica(d.deps);
      assert.equal(q.ok, true, JSON.stringify(q));
      const { info, wrap } = seamSostituzione(home, CONTENUTO);
      caso.info = info;
      caso.eseguiArgs = [mod, { staging, deps: wrap(d.deps) }, q];
    }
    const origLink = fs.linkSync;
    if (caso.wx) fs.linkSync = () => { const e = new Error('EACCES: link denied'); e.code = 'EACCES'; throw e; };
    let r;
    try {
      r = caso.esegui(...caso.eseguiArgs);
    } finally {
      if (caso.wx) fs.linkSync = origLink;
    }
    assert.equal(r.ok, false, `${caso.nome}: the substituted reread must refuse`);
    assert.equal(r.code, 'PIN_REREAD', caso.nome);
    assert.equal(caso.info.fired, true, `${caso.nome}: the substitute must be in place`);
    assert.notEqual(caso.info.origin.ino, caso.info.substitute.ino, `${caso.nome}: the substitute must be a different inode`);
    const snap = mod.getCreationRegistry();
    const entry = caso.entry(snap);
    assert.ok(entry, `${caso.nome}: the registry entry must exist`);
    assert.equal(entry.state, 'created-unqualified', caso.nome);
    assert.equal(entry.cause, 'reread-identity-mismatch', caso.nome);
    assert.equal(entry.dev, caso.info.origin.dev, `${caso.nome}: the trace keeps the created inode`);
    assert.equal(entry.ino, caso.info.origin.ino, `${caso.nome}: the trace keeps the created inode`);
    assert.notEqual(entry.ino, caso.info.substitute.ino, `${caso.nome}: the substitute must never be owned`);
    assert.equal(entry.qualified, false, caso.nome);
    assert.equal(entry.cleanupAllowed, false, caso.nome);
    const stFinale = fs.lstatSync(entry.path);
    assert.equal(stFinale.ino, caso.info.substitute.ino, `${caso.nome}: the substitute must still be on disk`);
    assert.equal(fs.readFileSync(entry.path, 'utf8'), CONTENUTO, caso.nome);
  }
});

// A name can be freed and re-created within the same incarnation: every
// PROVEN creation is censused as its own generation with its original
// identity, and the previous entry is never filled, reused or deleted. A
// later EEXIST on a foreign object verifies it but never owns it.
test('registry: a recreated name opens a new generation, the old entry is never rewritten', (t) => {
  const CONTENUTO = '#!/bin/sh\nexit 0\n';
  const negaLink = () => { const e = new Error('EACCES: link denied'); e.code = 'EACCES'; throw e; };

  // Recreated per-home final through the copy path (distinct inodes),
  // then a foreign EEXIST under the same name.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t, { bin: CONTENUTO });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-gen-'));
    t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
    const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
    const origLink = fs.linkSync;
    fs.linkSync = negaLink;
    let q;
    try {
      q = mod.qualifica(d.deps);
    } finally { fs.linkSync = origLink; }
    assert.equal(q.ok, true, JSON.stringify(q));
    let p1;
    fs.linkSync = negaLink;
    try { p1 = mod.pubblica(q, staging, d.deps); } finally { fs.linkSync = origLink; }
    assert.equal(p1.ok, true, JSON.stringify(p1));
    const snap1 = mod.getCreationRegistry();
    const gen1 = snap1.homeFinals[0];
    assert.ok(gen1, 'the first final must be censused');
    assert.equal(gen1.generation, 1);
    assert.equal(gen1.state, 'qualified-synced');
    const dest = gen1.path;
    const ino1 = fs.lstatSync(dest).ino;
    assert.equal(gen1.ino, ino1);

    // Keep the first generation's inode alive under a spare name, so the
    // new exclusive-create copy cannot recycle its inode number and the
    // generations stay distinguishable by identity.
    fs.linkSync(dest, `${dest}.tenuta`);
    fs.rmSync(dest);
    fs.linkSync = negaLink;
    let p2;
    try { p2 = mod.pubblica(q, staging, d.deps); } finally { fs.linkSync = origLink; }
    assert.equal(p2.ok, true, JSON.stringify(p2));
    const entries = mod.getCreationRegistry().homeFinals.filter((e) => e.path === dest);
    assert.equal(entries.length, 2, 'the recreated final must be censused as a new entry');
    const g1 = entries.find((e) => e.generation === 1);
    const g2 = entries.find((e) => e.generation === 2);
    assert.ok(g1 && g2, 'both generations must be present');
    assert.equal(g2.state, 'qualified-synced');
    assert.equal(g2.ino, fs.lstatSync(dest).ino, 'the current entry owns the new inode');
    assert.notEqual(g2.ino, ino1, 'the copy path must produce a new inode');
    assert.equal(g1.ino, ino1, 'the old generation keeps its original identity');
    assert.equal(g1.state, 'qualified-synced', 'the old generation is not rewritten');

    // Foreign, byte-identical object under the same name: verified, never
    // owned, no third entry. The second generation's inode is kept alive
    // aside, so the foreign file cannot recycle its number.
    fs.renameSync(dest, `${dest}.tenuta2`);
    fs.writeFileSync(dest, CONTENUTO, { mode: 0o500 });
    fs.chmodSync(dest, 0o500);
    const estraneoIno = fs.lstatSync(dest).ino;
    const p3 = mod.pubblica(q, staging, d.deps);
    assert.equal(p3.ok, true, JSON.stringify(p3));
    const entries3 = mod.getCreationRegistry().homeFinals.filter((e) => e.path === dest);
    assert.equal(entries3.length, 2, 'a foreign EEXIST must not open a new entry');
    const corrente = entries3.find((e) => e.generation === 2);
    assert.ok(corrente);
    assert.equal(corrente.ino, g2.ino, 'the registry must keep owning only its own creation');
    assert.notEqual(fs.lstatSync(dest).ino, corrente.ino, 'the foreign object must not be adopted');
    assert.equal(fs.lstatSync(dest).ino, estraneoIno, 'the foreign object must be untouched');
  }

  // Controlled reuse of a temporary name: the new temporary is censused as
  // its own generation, the removed old one never covers it.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t, { bin: CONTENUTO });
    const q1 = mod.qualifica(d.deps);
    assert.equal(q1.ok, true, JSON.stringify(q1));
    const tmp1 = mod.getCreationRegistry().tempFiles[0];
    assert.ok(tmp1, 'the first temporary must be censused');
    assert.equal(tmp1.generation, 1);
    assert.equal(tmp1.unlinked, true);
    const tmpPath = tmp1.path;
    const suffissoHex = tmpPath.split('.tmp-')[1];
    assert.ok(/^[0-9a-f]{12}$/.test(suffissoHex), `unexpected temporary suffix: ${suffissoHex}`);
    const exec2 = path.join(d.root, 'bin', 'node-two');
    fs.copyFileSync(d.exec, exec2);
    fs.chmodSync(exec2, 0o755);
    fs.rmSync(q1.path);
    const origRandom = crypto.randomBytes;
    crypto.randomBytes = (n) => (n === 6 ? Buffer.from(suffissoHex, 'hex') : origRandom(n));
    let q2;
    try {
      q2 = mod.qualifica({ ...d.deps, execPath: exec2 });
    } finally {
      crypto.randomBytes = origRandom;
    }
    assert.equal(q2.ok, true, JSON.stringify(q2));
    const vociTmp = mod.getCreationRegistry().tempFiles.filter((e) => e.path === tmpPath);
    assert.equal(vociTmp.length, 2, 'the reused temporary name must open a new generation');
    const t1 = vociTmp.find((e) => e.generation === 1);
    const t2 = vociTmp.find((e) => e.generation === 2);
    assert.ok(t1 && t2, 'both temporary generations must be present');
    assert.ok(Number.isSafeInteger(t2.dev) && Number.isSafeInteger(t2.ino),
      'the new temporary must be censused with its own identity');
    assert.equal(t2.unlinked, true, 'the new generation tracks its own removal');
    assert.equal(t2.state, 'qualified-unsynced');
    assert.equal(t2.fileSynced, true);
    assert.equal(t1.ino, tmp1.ino, 'the old generation is not rewritten');
    const snapEntries = mod.getCreationRegistry().snapshots.filter((e) => e.path === q2.path);
    assert.equal(snapEntries.length, 2, 'the recreated snapshot must be censused as a new entry');
  }

  // An old unknown identity stays unknown: a later successful creation on
  // the same name opens a new entry instead of filling the old one.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t, { bin: CONTENUTO });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-gen2-'));
    t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
    fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
    const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    const origLink = fs.linkSync;
    const origFstat = fs.fstatSync;
    let fallaFstat = true;
    fs.linkSync = negaLink;
    fs.fstatSync = (fd) => {
      const st = origFstat(fd);
      if (fallaFstat && st.isFile() && st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    };
    let p1;
    try {
      p1 = mod.pubblica(q, staging, d.deps);
    } finally {
      fs.linkSync = origLink;
      fs.fstatSync = origFstat;
    }
    assert.equal(p1.ok, false);
    assert.equal(p1.code, 'PIN_REREAD');
    const ignota = mod.getCreationRegistry().homeFinals[0];
    assert.ok(ignota, 'the unknown creation must be censused');
    assert.equal(ignota.state, 'created-identity-unknown');
    assert.equal(ignota.generation, 1);
    const dest = ignota.path;
    fs.rmSync(dest);
    let p2;
    fs.linkSync = negaLink;
    try { p2 = mod.pubblica(q, staging, d.deps); } finally { fs.linkSync = origLink; }
    assert.equal(p2.ok, true, JSON.stringify(p2));
    const entries = mod.getCreationRegistry().homeFinals.filter((e) => e.path === dest);
    assert.equal(entries.length, 2, 'the successful recreation must open a new entry');
    const vecchia = entries.find((e) => e.generation === 1);
    const nuova = entries.find((e) => e.generation === 2);
    assert.ok(vecchia && nuova);
    assert.equal(vecchia.state, 'created-identity-unknown', 'the old entry keeps its state');
    assert.equal(vecchia.dev, null, 'the old unknown identity must not be backfilled');
    assert.equal(vecchia.ino, null, 'the old unknown identity must not be backfilled');
    assert.equal(vecchia.uid, null);
    assert.equal(vecchia.mode, null);
    assert.equal(nuova.state, 'qualified-synced');
    assert.equal(nuova.ino, fs.lstatSync(dest).ino);
  }
});

// The live census is bounded: repeated failures fold into the registry only
// up to the cap, confirmed removals and not-created attempts compact into
// counters under pressure, present-but-unknown residuals are never evicted,
// and a saturated registry refuses the next creation BEFORE the effect.
test('registry: bounded census compacts what is provable and refuses before the effect when saturated', (t) => {
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  const sorgenti = [];
  for (let i = 0; i < 420; i += 1) {
    const p = path.join(d.root, 'bin', `node-${i}`);
    fs.copyFileSync(d.exec, p);
    fs.chmodSync(p, 0o755);
    sorgenti.push(p);
  }
  const origFstat = fs.fstatSync;
  const origOpen = fs.openSync;
  let tmpOpens = 0;
  const depsApertoFallito = (exec) => ({
    ...d.deps,
    execPath: exec,
    open: (p, flags, mode) => {
      if (typeof p === 'string' && p.includes('.tmp-')) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      return origOpen(p, flags, mode);
    },
  });
  const depsIdentitaSconosciuta = (exec) => ({
    ...d.deps,
    execPath: exec,
    open: (p, flags, mode) => {
      const fd = origOpen(p, flags, mode);
      if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
        tmpOpens += 1;
      }
      return fd;
    },
    fstat: (fd) => {
      const st = origFstat(fd);
      if (st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    },
  });

  // One clean success: instance dir, snapshot, one removed temporary.
  const q0 = mod.qualifica({ ...d.deps, execPath: sorgenti[0] });
  assert.equal(q0.ok, true, JSON.stringify(q0));
  fs.rmSync(q0.path);

  // Many repeated failed creations: distinct not-created entries.
  for (let i = 1; i <= 150; i += 1) {
    const r = mod.qualifica(depsApertoFallito(sorgenti[i]));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
  }
  let snap = mod.getCreationRegistry();
  assert.equal(snap.entries.length, 3 + 150);

  // Many present-but-unknown residuals: pressure compacts the not-created
  // entries and the confirmed removal into counters, never the unknowns.
  for (let i = 151; i <= 300; i += 1) {
    const r = mod.qualifica(depsIdentitaSconosciuta(sorgenti[i]));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
  }
  snap = mod.getCreationRegistry();
  assert.equal(snap.entries.length, 152, 'only non-compactable entries may remain');
  assert.equal(snap.compacted.notCreated, 150);
  assert.equal(snap.compacted.removed, 1);
  assert.equal(snap.entries.filter((e) => e.state === 'created-identity-unknown').length, 150);
  assert.equal(snap.entries.filter((e) => e.kind === 'instance-dir').length, 1);
  assert.equal(snap.entries.filter((e) => e.kind === 'snapshot-file').length, 1);

  // Saturation: once only non-compactable entries remain, the next creation
  // is refused before any effect, with a typed internal cause.
  let rifiutato = null;
  for (let i = 301; i < 420 && !rifiutato; i += 1) {
    const prima = mod.getCreationRegistry().entries.length;
    const opensPrima = tmpOpens;
    const r = mod.qualifica(depsIdentitaSconosciuta(sorgenti[i]));
    const opensDopo = tmpOpens;
    if (r.motivo === 'registry-saturated') {
      rifiutato = { r, prima, opensPrima, opensDopo };
    } else {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'PIN_STAGE');
    }
  }
  assert.ok(rifiutato, 'the saturated registry must refuse the new creation');
  assert.equal(rifiutato.r.ok, false);
  assert.equal(rifiutato.r.code, 'PIN_STAGE');
  assert.equal(rifiutato.r.motivo, 'registry-saturated');
  assert.equal(rifiutato.opensDopo - rifiutato.opensPrima, 0, 'the refused call must not create any object');
  assert.equal(rifiutato.prima, 256, 'the refusal must happen exactly at the live cap');
  snap = mod.getCreationRegistry();
  assert.equal(snap.entries.length, 256);
  assert.equal(snap.entries.filter((e) => e.state === 'created-identity-unknown').length, 254);
  for (const e of snap.entries) {
    if (e.state === 'created-identity-unknown') {
      assert.equal(e.cleanupAllowed, false, 'an unknown residual is never a candidate');
    }
  }
});

// Builds the saturation preconditions shared by the destination-refusal
// regressions below: one clean qualification (instance dir, removed
// temporary, published snapshot then unlinked by the test so the final name
// stays absent), followed by `unknowns` present-but-unknown temporaries that
// no compaction may ever fold. After this the live census holds
// 3 + unknowns entries, of which exactly one (the confirmed removal of the
// clean run) is compactable: folding it at the next capacity reservation is
// what admits the final temporary as the 256th, non-compactable entry.
function saturaRegistroConIgnoti(mod, d, unknowns) {
  const origFstat = fs.fstatSync;
  const q0 = mod.qualifica(d.deps);
  assert.equal(q0.ok, true, JSON.stringify(q0));
  fs.rmSync(q0.path);
  const execUnk = path.join(d.root, 'bin', 'node-unk');
  fs.copyFileSync(d.exec, execUnk);
  fs.chmodSync(execUnk, 0o755);
  const depsUnknown = {
    ...d.deps,
    execPath: execUnk,
    fstat: (fd) => {
      const st = origFstat(fd);
      if (st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    },
  };
  for (let i = 0; i < unknowns; i += 1) {
    const r = mod.qualifica(depsUnknown);
    assert.equal(r.ok, false, `unknown residual ${i} must refuse`);
    assert.equal(r.code, 'PIN_STAGE');
  }
  const snap = mod.getCreationRegistry();
  assert.equal(snap.entries.length, Math.min(3 + unknowns, 256), 'the fill must leave the expected census');
  return { q0 };
}

// The final publication is refused for registry saturation AFTER the
// temporary was created, descriptor-synced and closed: the refusal must not
// remove the temporary by pathname. Between the closed descriptor and the
// refusal the name may already point at a substitute, so unlinking there
// would delete exactly that substitute; the temporary stays a censused,
// non-removed residual instead.
test('registry: a saturated destination refusal never unlinks the synced temporary', (t) => {
  const origOpen = fs.openSync;
  const origClose = fs.closeSync;
  const origRename = fs.renameSync;
  const origWriteFileSync = fs.writeFileSync;
  const origUnlink = fs.unlinkSync;

  // A. Qualified temporary, name substituted with a sentinel at close,
  //    saturated destination: refusal without any unlink, sentinel preserved.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    saturaRegistroConIgnoti(mod, d, 253);
    const execFin = path.join(d.root, 'bin', 'node-fin-a');
    fs.copyFileSync(d.exec, execFin);
    fs.chmodSync(execFin, 0o755);
    let tmpFd = null;
    let tmpPath = null;
    let substituted = false;
    let unlinkCalls = 0;
    const deps = {
      ...d.deps,
      execPath: execFin,
      open: (p, flags, mode) => {
        const fd = origOpen(p, flags, mode);
        if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
          tmpFd = fd;
          tmpPath = p;
        }
        return fd;
      },
      close: (fd) => {
        if (fd === tmpFd && !substituted) {
          // The closed temporary's name starts pointing at a substitute: a
          // pathname removal in the refusal would delete exactly this file.
          substituted = true;
          origRename(tmpPath, `${tmpPath}.originale`);
          origWriteFileSync(tmpPath, 'sentinel', { mode: 0o400 });
        }
        return origClose(fd);
      },
      unlink: (p) => {
        if (p === tmpPath) unlinkCalls += 1;
        return origUnlink(p);
      },
    };
    const r = mod.qualifica(deps);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'PIN_STAGE');
    assert.equal(r.motivo, 'registry-saturated');
    assert.ok(tmpPath, 'the qualified temporary must have been created and closed');
    assert.equal(substituted, true, 'the substitute must be in place before the refusal could run');
    assert.equal(unlinkCalls, 0, 'the saturated-destination refusal must never unlink the temporary');
    assert.ok(fs.existsSync(tmpPath), 'the sentinel under the temporary name must be preserved');
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'sentinel', 'the sentinel must be byte-intact');
    assert.ok(fs.existsSync(`${tmpPath}.originale`), 'the original object renamed aside must stay alive');
    const snap = mod.getCreationRegistry();
    const entry = snap.tempFiles.find((e) => e.path === tmpPath);
    assert.ok(entry, 'the original temporary entry must still be censused');
    assert.equal(entry.state, 'qualified-unsynced');
    assert.equal(entry.fileSynced, true);
    assert.equal(entry.unlinked, false);
    assert.equal(snap.entries.length, 256, 'no census entry beyond the live cap');
  }

  // B. Positive variant without substitution: the known residual stays on
  //    disk with its proven identity and nothing exceeds the cap.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    saturaRegistroConIgnoti(mod, d, 253);
    const execFin = path.join(d.root, 'bin', 'node-fin-b');
    fs.copyFileSync(d.exec, execFin);
    fs.chmodSync(execFin, 0o755);
    let tmpPath = null;
    let unlinkCalls = 0;
    const deps = {
      ...d.deps,
      execPath: execFin,
      open: (p, flags, mode) => {
        const fd = origOpen(p, flags, mode);
        if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
          tmpPath = p;
        }
        return fd;
      },
      unlink: (p) => {
        if (p === tmpPath) unlinkCalls += 1;
        return origUnlink(p);
      },
    };
    const r = mod.qualifica(deps);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.code, 'PIN_STAGE');
    assert.equal(r.motivo, 'registry-saturated');
    assert.ok(tmpPath, 'the qualified temporary must have been created');
    assert.equal(unlinkCalls, 0, 'the saturated-destination refusal must never unlink the temporary');
    assert.ok(fs.existsSync(tmpPath), 'the known residual temporary must stay on disk');
    const stResiduo = fs.lstatSync(tmpPath);
    assert.equal(stResiduo.mode & 0o777, 0o500);
    const snap = mod.getCreationRegistry();
    const entry = snap.tempFiles.find((e) => e.path === tmpPath);
    assert.ok(entry, 'the residual temporary entry must be censused');
    assert.equal(entry.state, 'qualified-unsynced');
    assert.equal(entry.fileSynced, true);
    assert.equal(entry.unlinked, false);
    assert.equal(entry.dev, stResiduo.dev, 'the residual keeps the created identity');
    assert.equal(entry.ino, stResiduo.ino, 'the residual keeps the created identity');
    assert.equal(snap.entries.length, 256, 'no census entry beyond the live cap');
  }
});

// Not-created recordings that never cross a capacity reservation (a foreign
// preexisting namespace, a namespace lstat failure) used to grow the live
// census without any bound. Admitting them is now bounded by the same live
// cap: compaction runs first and, when only non-compactable entries remain,
// the attempt folds into the compacted counter and its path is not retained.
// Foreign objects stay byte-intact and no module effect ever happens.
test('registry: not-created admissions are bounded and never evict present or unknown entries', (t) => {
  const origLstat = fs.lstatSync;
  const origMkdirSync = fs.mkdirSync;
  const origLinkSync = fs.linkSync;
  const origUnlinkSync = fs.unlinkSync;
  const origOpenSync = fs.openSync;

  // Wraps the effect primitives to count any module-driven mkdir, link,
  // unlink or open under a test root: a not-created attempt must produce no
  // filesystem effect at all.
  function contaEffetti(root) {
    let effects = 0;
    const under = (p) => typeof p === 'string' && p.startsWith(root + path.sep);
    fs.mkdirSync = (target, opts) => { if (under(target)) effects += 1; return origMkdirSync(target, opts); };
    fs.linkSync = (src, dest) => { if (under(src) || under(dest)) effects += 1; return origLinkSync(src, dest); };
    fs.unlinkSync = (p) => { if (under(p)) effects += 1; return origUnlinkSync(p); };
    fs.openSync = (p, ...rest) => { const fd = origOpenSync(p, ...rest); if (under(p)) effects += 1; return fd; };
    return {
      count: () => effects,
      stop: () => {
        fs.mkdirSync = origMkdirSync;
        fs.linkSync = origLinkSync;
        fs.unlinkSync = origUnlinkSync;
        fs.openSync = origOpenSync;
      },
    };
  }

  // A. More than 256 distinct foreign namespaces: every publication refuses
  //    with PIN_DIR, the census never exceeds the cap and the folded
  //    attempts only grow the compacted counter.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    const nonce = mod.getCreationRegistry().nonce;
    const homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-cens-a-'));
    t.after(() => { try { fs.rmSync(homesRoot, { recursive: true, force: true }); } catch (_) {} });
    const stagings = [];
    for (let i = 0; i < 300; i += 1) {
      const staging = path.join(homesRoot, `h${i}`, '.nexuscrew', 'vl-claim-pin');
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(staging, `inst-${nonce}`), { mode: 0o700 });
      fs.writeFileSync(path.join(staging, `inst-${nonce}`, 'sentinel.txt'), `foreign-${i}`);
      stagings.push(staging);
    }
    const effetti = contaEffetti(homesRoot);
    try {
      for (const staging of stagings) {
        const r = mod.pubblica(q, staging, d.deps);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'PIN_DIR');
        const snap = mod.getCreationRegistry();
        assert.ok(snap.entries.length <= 256, `live census must stay bounded, got ${snap.entries.length}`);
      }
    } finally {
      effetti.stop();
    }
    assert.equal(effetti.count(), 0, 'a refused not-created attempt must not touch the filesystem');
    const snap = mod.getCreationRegistry();
    assert.ok(snap.entries.length <= 256);
    assert.ok(snap.compacted.notCreated >= 200, `not-created attempts must fold into counters, got ${snap.compacted.notCreated}`);
    for (const [i, staging] of stagings.entries()) {
      const foreign = path.join(staging, `inst-${nonce}`);
      assert.equal(fs.lstatSync(foreign).mode & 0o777, 0o700, `foreign dir ${i} must be untouched`);
      assert.equal(fs.readFileSync(path.join(foreign, 'sentinel.txt'), 'utf8'), `foreign-${i}`, `foreign object ${i} must be byte-intact`);
      assert.equal(fs.readdirSync(staging).length, 1, `staging ${i} must contain only the foreign namespace`);
    }
  }

  // B. Separately, lstat failures on distinct namespace keys: same bound,
  //    same counters, and no namespace is ever created.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const q = mod.qualifica(d.deps);
    assert.equal(q.ok, true, JSON.stringify(q));
    const nonce = mod.getCreationRegistry().nonce;
    const homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-cens-b-'));
    t.after(() => { try { fs.rmSync(homesRoot, { recursive: true, force: true }); } catch (_) {} });
    const stagings = [];
    for (let i = 0; i < 300; i += 1) {
      const staging = path.join(homesRoot, `h${i}`, '.nexuscrew', 'vl-claim-pin');
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      stagings.push(staging);
    }
    const deps = {
      ...d.deps,
      lstat: (target) => {
        if (typeof target === 'string' && target.startsWith(homesRoot + path.sep)
          && path.basename(target) === `inst-${nonce}`) {
          const e = new Error('EIO');
          e.code = 'EIO';
          throw e;
        }
        return origLstat(target);
      },
    };
    const effetti = contaEffetti(homesRoot);
    try {
      for (const staging of stagings) {
        const r = mod.pubblica(q, staging, deps);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'PIN_DIR');
        const snap = mod.getCreationRegistry();
        assert.ok(snap.entries.length <= 256, `live census must stay bounded, got ${snap.entries.length}`);
      }
    } finally {
      effetti.stop();
    }
    assert.equal(effetti.count(), 0, 'a refused not-created attempt must not touch the filesystem');
    const snap = mod.getCreationRegistry();
    assert.ok(snap.entries.length <= 256);
    assert.ok(snap.compacted.notCreated >= 200, `not-created attempts must fold into counters, got ${snap.compacted.notCreated}`);
    for (const [i, staging] of stagings.entries()) {
      assert.equal(fs.existsSync(path.join(staging, `inst-${nonce}`)), false, `no namespace may be created in staging ${i}`);
      assert.equal(fs.readdirSync(staging).length, 0, `staging ${i} must stay empty`);
    }
  }

  // C. All 256 positions held by owned, unknown residuals: the new
  //    not-created attempts fold into the counter, nothing is evicted and no
  //    non-owned path is ever retained past the cap.
  {
    const mod = copiaFrescaModulo();
    const d = mondoRuntime(t);
    const { q0 } = saturaRegistroConIgnoti(mod, d, 254);
    let snap = mod.getCreationRegistry();
    assert.equal(snap.entries.length, 256, 'the fill must saturate the cap');
    assert.equal(snap.compacted.removed, 1, 'only the confirmed removal may have been folded');
    assert.equal(snap.entries.filter((e) => e.state === 'not-created').length, 0);
    assert.equal(snap.entries.filter((e) => e.state === 'created-identity-unknown').length, 254);
    const nonce = snap.nonce;
    const homesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodert-cens-c-'));
    t.after(() => { try { fs.rmSync(homesRoot, { recursive: true, force: true }); } catch (_) {} });
    const stagings = [];
    for (let i = 0; i < 50; i += 1) {
      const staging = path.join(homesRoot, `h${i}`, '.nexuscrew', 'vl-claim-pin');
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(staging, `inst-${nonce}`), { mode: 0o700 });
      fs.writeFileSync(path.join(staging, `inst-${nonce}`, 'sentinel.txt'), `foreign-${i}`);
      stagings.push(staging);
    }
    const effetti = contaEffetti(homesRoot);
    try {
      for (const staging of stagings) {
        const r = mod.pubblica(q0, staging, d.deps);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'PIN_DIR');
        snap = mod.getCreationRegistry();
        assert.equal(snap.entries.length, 256, 'a folded not-created attempt must not evict anything');
        assert.equal(snap.entries.filter((e) => e.state === 'created-identity-unknown').length, 254,
          'no unknown residual may be evicted');
        assert.equal(snap.nonOwned.length, 0, 'no non-owned path may be retained past the cap');
      }
    } finally {
      effetti.stop();
    }
    assert.equal(effetti.count(), 0, 'a refused not-created attempt must not touch the filesystem');
    assert.equal(snap.compacted.notCreated, 50, 'every folded attempt must be counted');
    for (const [i, staging] of stagings.entries()) {
      assert.equal(fs.readFileSync(path.join(staging, `inst-${nonce}`, 'sentinel.txt'), 'utf8'), `foreign-${i}`,
        `foreign object ${i} must be byte-intact`);
    }
  }
});

// Compaction may retire the current generation of a name while an older,
// still-censused generation of the SAME name remains in the registry. A new
// proven creation on that name must never reuse the number of a live entry:
// its generation counts every still-censused generation of the same
// kind+path, and its incarnation serial (seq) is unique for the whole module
// lifetime, so no two live entries ever share (kind, path, generation) and
// the serial keeps creations distinguishable even across compaction.
test('registry: a third creation after compaction never reuses a live generation', (t) => {
  const origFstat = fs.fstatSync;
  const origOpen = fs.openSync;
  const origRandom = crypto.randomBytes;

  // 1. First attempt on the temporary name: identity unknown, generation 1.
  const mod = copiaFrescaModulo();
  const d = mondoRuntime(t);
  let failTmpFstat = true;
  const deps1 = {
    ...d.deps,
    fstat: (fd) => {
      const st = origFstat(fd);
      if (failTmpFstat && st.size === 0) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return st;
    },
  };
  const r1 = mod.qualifica(deps1);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'PIN_STAGE');
  let snap = mod.getCreationRegistry();
  const tmpPath = snap.tempFiles[0].path;
  const suffisso = tmpPath.split('.tmp-')[1];
  assert.ok(/^[0-9a-f]{12}$/.test(suffisso), `unexpected temporary suffix: ${suffisso}`);
  const ignota1 = snap.tempFiles[0];
  assert.equal(ignota1.generation, 1);
  assert.equal(ignota1.state, 'created-identity-unknown');
  const seq1 = ignota1.seq;
  assert.ok(Number.isSafeInteger(seq1), 'every record must carry an incarnation serial');

  // 2. Free the name and recreate it: a proven, fully successful creation
  //    that the module itself removes at the end (generation 2, unlinked).
  fs.rmSync(tmpPath);
  const exec2 = path.join(d.root, 'bin', 'node-two');
  fs.copyFileSync(d.exec, exec2);
  fs.chmodSync(exec2, 0o755);
  failTmpFstat = false;
  crypto.randomBytes = (n) => (n === 6 ? Buffer.from(suffisso, 'hex') : origRandom(n));
  let r2;
  try {
    r2 = mod.qualifica({ ...d.deps, execPath: exec2 });
  } finally {
    crypto.randomBytes = origRandom;
  }
  assert.equal(r2.ok, true, JSON.stringify(r2));
  snap = mod.getCreationRegistry();
  const vive2 = snap.tempFiles.filter((e) => e.path === tmpPath);
  assert.equal(vive2.length, 2, 'the recreated temporary must be a distinct entry');
  const gen2 = vive2.find((e) => e.generation === 2);
  assert.ok(gen2, 'the proven recreation must be generation 2');
  assert.equal(gen2.state, 'qualified-unsynced');
  assert.equal(gen2.fileSynced, true);
  assert.equal(gen2.unlinked, true, 'the module removed its own temporary');
  const seq2 = gen2.seq;
  assert.ok(seq2 > seq1, 'the serial must be monotonic across creations');
  // The published photograph of step 2 blocks the third temporary unless the
  // name is freed again.
  fs.rmSync(r2.path);

  // 3. Pressure: 252 failed openings fill the live census to the cap, so the
  //    next capacity reservation compacts the removed generation 2 away.
  const execFill = path.join(d.root, 'bin', 'node-fill');
  fs.copyFileSync(d.exec, execFill);
  fs.chmodSync(execFill, 0o755);
  const depsFill = {
    ...d.deps,
    execPath: execFill,
    open: (p, flags, mode) => {
      if (typeof p === 'string' && p.includes('.tmp-')) {
        const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
      }
      return origOpen(p, flags, mode);
    },
  };
  for (let i = 0; i < 252; i += 1) {
    const r = mod.qualifica(depsFill);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_STAGE');
  }
  snap = mod.getCreationRegistry();
  assert.equal(snap.entries.length, 256, 'the fill must reach the live cap');
  assert.ok(snap.tempFiles.some((e) => e.path === tmpPath && e.generation === 2 && e.unlinked === true),
    'generation 2 must still be censused before the compaction');

  // 4. Third creation on the same name: the reservation compacts the removed
  //    generation 2, and the new record must still not collide with the
  //    live unknown generation 1.
  const exec3 = path.join(d.root, 'bin', 'node-three');
  fs.copyFileSync(d.exec, exec3);
  fs.chmodSync(exec3, 0o755);
  crypto.randomBytes = (n) => (n === 6 ? Buffer.from(suffisso, 'hex') : origRandom(n));
  let r3;
  try {
    r3 = mod.qualifica({ ...d.deps, execPath: exec3 });
  } finally {
    crypto.randomBytes = origRandom;
  }
  assert.equal(r3.ok, true, JSON.stringify(r3));
  snap = mod.getCreationRegistry();
  const vive3 = snap.tempFiles.filter((e) => e.path === tmpPath);
  assert.equal(vive3.length, 2, 'only the live generations may remain after compaction');
  const vecchia = vive3.find((e) => e.generation === 1);
  const nuova = vive3.find((e) => e.generation === 2);
  assert.ok(vecchia && nuova, 'the unknown and the new generation must both be live');
  assert.equal(vecchia.state, 'created-identity-unknown', 'the old entry keeps its state');
  assert.equal(vecchia.dev, null, 'the old unknown identity must not be backfilled');
  assert.equal(vecchia.ino, null, 'the old unknown identity must not be backfilled');
  assert.equal(vecchia.unlinked, false);
  assert.equal(vecchia.seq, seq1, 'the old entry keeps its serial');
  assert.equal(nuova.generation, 2, 'the third creation must not reuse the live generation 1');
  assert.ok(Number.isSafeInteger(nuova.dev) && Number.isSafeInteger(nuova.ino),
    'the new entry carries its own identity');
  assert.notEqual(nuova.seq, vecchia.seq);
  assert.ok(nuova.seq > seq2, 'the new serial must not have been reused after compaction');
  assert.equal(nuova.unlinked, true, 'the module removed its own temporary again');
  assert.equal(snap.entries.filter((e) => e.seq === seq2).length, 0,
    'the compacted generation must not linger as metadata');
  assert.equal(snap.entries.length, 5, 'compaction must fold the failed attempts, not keep per-path tombstones');
  assert.equal(snap.compacted.notCreated, 252);
  assert.equal(snap.compacted.removed, 1);
  const chiaviGenerazione = new Set(snap.entries.map((e) => `${e.kind}|${e.path}|${e.generation}`));
  assert.equal(chiaviGenerazione.size, snap.entries.length, 'no live (kind, path, generation) duplicate');
  const seriali = new Set(snap.entries.map((e) => e.seq));
  assert.equal(seriali.size, snap.entries.length, 'every live entry must have a distinct serial');

  // 5. Positive complement: a retry that does not create anything opens no
  //    generation, it cannot even record a not-created over the live entry.
  fs.rmSync(r3.path);
  const exec4 = path.join(d.root, 'bin', 'node-four');
  fs.copyFileSync(d.exec, exec4);
  fs.chmodSync(exec4, 0o755);
  crypto.randomBytes = (n) => (n === 6 ? Buffer.from(suffisso, 'hex') : origRandom(n));
  let r4;
  try {
    r4 = mod.qualifica({
      ...d.deps,
      execPath: exec4,
      open: (p, flags, mode) => {
        if (typeof p === 'string' && p.includes('.tmp-')) {
          const e = new Error('EACCES'); e.code = 'EACCES'; throw e;
        }
        return origOpen(p, flags, mode);
      },
    });
  } finally {
    crypto.randomBytes = origRandom;
  }
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'PIN_STAGE');
  snap = mod.getCreationRegistry();
  assert.equal(snap.tempFiles.filter((e) => e.path === tmpPath).length, 2,
    'a failed retry must not open a new generation');
  assert.equal(snap.entries.filter((e) => e.path === tmpPath && e.state === 'not-created').length, 0,
    'a failed retry must not overwrite the live entry');
  assert.equal(snap.entries.length, 5);
});

// The historical best-effort removal of a created temporary is bound to the
// proven original identity: the unlink runs only when the registry still
// holds the current entry for the name with safe dev/ino and the lstat of
// the name (through the existing seam) still resolves to that same real
// file. A substitute placed while the descriptor was being closed, a failed
// lstat (EIO or ENOENT) or an entry without proven identity produce no
// unlink and no marking: the residue stays censused with unlinked=false and
// never folds into compacted.removed under pressure. A clean run instead
// unlinks its own object, marks the entry removed and compacts correctly.
// Both historical removal sites are exercised: the staging failure of the
// temporary (write/fchmod/fsync block) and the post-publication removal on
// both publication paths (link and exclusive create).
test('registry: the historical temporary unlink is bound to the proven original identity', (t) => {
  const origOpen = fs.openSync;
  const origClose = fs.closeSync;
  const origRename = fs.renameSync;
  const origWriteFile = fs.writeFileSync;
  const origUnlink = fs.unlinkSync;
  const origFstat = fs.fstatSync;
  const origLink = fs.linkSync;

  const SITI = [
    { nome: 'staging-failure', rompiTmp: true, negaLink: false },
    { nome: 'post-publication-link', rompiTmp: false, negaLink: false },
    { nome: 'post-publication-wx', rompiTmp: false, negaLink: true },
  ];
  const SCENARI = ['substitute', 'lstat-eio', 'lstat-enoent', 'positive'];

  for (const sito of SITI) {
    for (const scenario of SCENARI) {
      const etichetta = `${sito.nome}/${scenario}`;
      const mod = copiaFrescaModulo();
      const d = mondoRuntime(t);
      let tmpFd = null;
      let tmpPath = null;
      let closedTmp = false;
      let entryAtClose = null;
      let failLstatCode = null;
      let unlinkCalls = 0;
      const deps = {
        ...d.deps,
        open: (p, flags, mode) => {
          const fd = origOpen(p, flags, mode);
          if (typeof p === 'string' && p.includes('.tmp-') && typeof flags === 'string' && flags.includes('wx')) {
            tmpFd = fd;
            tmpPath = p;
          }
          return fd;
        },
        close: (fd) => {
          if (fd === tmpFd && !closedTmp) {
            closedTmp = true;
            entryAtClose = mod.getCreationRegistry().tempFiles.find((e) => e.path === tmpPath);
            if (scenario === 'substitute') {
              // The closed temporary's name starts pointing at a substitute
              // while the original object stays alive under a test name.
              origRename(tmpPath, `${tmpPath}.originale`);
              origWriteFile(tmpPath, 'sentinel', { mode: 0o500 });
            } else if (scenario === 'lstat-eio' || scenario === 'lstat-enoent') {
              failLstatCode = scenario === 'lstat-eio' ? 'EIO' : 'ENOENT';
            }
          }
          return origClose(fd);
        },
        lstat: (p) => {
          if (failLstatCode !== null && p === tmpPath) {
            const e = new Error(`${failLstatCode}: injected at the removal decision`);
            e.code = failLstatCode;
            throw e;
          }
          return fs.lstatSync(p);
        },
        unlink: (p) => {
          if (p === tmpPath) unlinkCalls += 1;
          return origUnlink(p);
        },
      };
      if (sito.rompiTmp) {
        deps.fsync = (fd) => {
          if (origFstat(fd).isFile()) { const e = new Error('EIO: tmp staging'); e.code = 'EIO'; throw e; }
          fs.fsyncSync(fd);
        };
      }
      if (sito.negaLink) fs.linkSync = () => { const e = new Error('EACCES: link denied'); e.code = 'EACCES'; throw e; };
      let r;
      try {
        r = mod.qualifica(deps);
      } finally {
        if (sito.negaLink) fs.linkSync = origLink;
      }
      if (sito.rompiTmp) {
        assert.equal(r.ok, false, `${etichetta}: the staging failure must refuse`);
        assert.equal(r.code, 'PIN_STAGE', etichetta);
      } else if (scenario === 'positive') {
        assert.equal(r.ok, true, `${etichetta}: the clean publication must qualify, got ${JSON.stringify(r)}`);
      }

      assert.ok(tmpPath, `${etichetta}: the temporary must have been created`);
      assert.ok(closedTmp, `${etichetta}: the temporary descriptor must have been closed`);
      assert.ok(entryAtClose, `${etichetta}: the temporary entry must exist at close`);
      assert.ok(Number.isSafeInteger(entryAtClose.seq), `${etichetta}: the entry must carry its serial`);
      const correnti = mod.getCreationRegistry().tempFiles.filter((e) => e.path === tmpPath);
      assert.equal(correnti.length, 1, `${etichetta}: the original entry must stay the only one`);
      const entryDopo = correnti[0];
      assert.equal(entryDopo.seq, entryAtClose.seq, `${etichetta}: the entry must keep its serial`);
      assert.equal(entryDopo.dev, entryAtClose.dev, `${etichetta}: the entry must keep the created identity`);
      assert.equal(entryDopo.ino, entryAtClose.ino, `${etichetta}: the entry must keep the created identity`);

      if (scenario === 'substitute') {
        assert.equal(unlinkCalls, 0, `${etichetta}: the substitute must never be unlinked`);
        assert.equal(entryDopo.unlinked, false, `${etichetta}: the residue must stay censused`);
        assert.equal(fs.readFileSync(tmpPath, 'utf8'), 'sentinel', `${etichetta}: the substitute must be preserved`);
        const tenuta = fs.lstatSync(`${tmpPath}.originale`);
        assert.equal(tenuta.dev, entryAtClose.dev, `${etichetta}: the original must stay alive under the test name`);
        assert.equal(tenuta.ino, entryAtClose.ino, `${etichetta}: the original must stay alive under the test name`);
        // The publication result is not asserted here: another ORIGIN guard
        // may legitimately detect the substitute and refuse. The properties
        // of the temporary entry above are the subject of this regression.
      } else if (scenario === 'lstat-eio' || scenario === 'lstat-enoent') {
        assert.equal(unlinkCalls, 0, `${etichetta}: a failed lstat must never reach the unlink`);
        assert.equal(entryDopo.unlinked, false, `${etichetta}: no marking without the identity comparison`);
        const residuo = fs.lstatSync(tmpPath);
        assert.equal(residuo.dev, entryAtClose.dev, `${etichetta}: the residue keeps the created identity`);
        assert.equal(residuo.ino, entryAtClose.ino, `${etichetta}: the residue keeps the created identity`);
      } else {
        assert.equal(unlinkCalls, 1, `${etichetta}: the clean removal must run exactly once`);
        assert.equal(entryDopo.unlinked, true, `${etichetta}: the successful removal marks the entry`);
        assert.equal(fs.existsSync(tmpPath), false, `${etichetta}: the temporary must be gone`);
      }

      // Pressure: fill the live census past the cap with failed openings so
      // compaction runs. A residue with unlinked=false is never folded into
      // compacted.removed; a confirmed removal is folded exactly once.
      const sorgenti = [];
      for (let i = 0; i < 260; i += 1) {
        const p = path.join(d.root, 'bin', `node-fill-${i}`);
        // Unique content per source (and never the scenario binary's own
        // bytes): each pressure run then targets its own absent destination
        // and really fails at the temporary opening.
        origWriteFile(p, `#!/bin/sh\nexit ${i}\n# ${etichetta}\n`);
        fs.chmodSync(p, 0o755);
        sorgenti.push(p);
      }
      const depsPressione = (exec) => ({
        ...d.deps,
        execPath: exec,
        open: (p, flags, mode) => {
          if (typeof p === 'string' && p.includes('.tmp-')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
          return origOpen(p, flags, mode);
        },
      });
      for (const exec of sorgenti) {
        const rp = mod.qualifica(depsPressione(exec));
        assert.equal(rp.ok, false, `${etichetta}: the pressure run must refuse`);
      }
      const snapDopo = mod.getCreationRegistry();
      if (scenario === 'positive') {
        assert.equal(snapDopo.tempFiles.filter((e) => e.path === tmpPath).length, 0,
          `${etichetta}: the confirmed removal must compact away`);
        assert.equal(snapDopo.compacted.removed, 1, `${etichetta}: exactly one confirmed removal may fold`);
      } else {
        const resistita = snapDopo.tempFiles.find((e) => e.path === tmpPath);
        assert.ok(resistita, `${etichetta}: the residue must survive the pressure`);
        assert.equal(resistita.seq, entryAtClose.seq, `${etichetta}: the residue must keep its serial`);
        assert.equal(resistita.dev, entryAtClose.dev, `${etichetta}: the residue must keep the created identity`);
        assert.equal(resistita.ino, entryAtClose.ino, `${etichetta}: the residue must keep the created identity`);
        assert.equal(resistita.unlinked, false, `${etichetta}: the residue must never be marked`);
        assert.equal(snapDopo.compacted.removed, 0,
          `${etichetta}: no compacted removal may be attributed to the residue`);
      }
    }
  }
});
