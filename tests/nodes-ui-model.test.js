'use strict';
// B2-NODES-UI — modelli puri: tile {session, node?} nel grid-model, path WS
// per-nodo (ws-client), aggregazione gruppi per-nodo (nodes-model).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const grid = () => import('../frontend/src/lib/grid-model.js');
const wsc = () => import('../frontend/src/lib/ws-client.js');
const nodes = () => import('../frontend/src/lib/nodes-model.js');

// --- grid-model: refKey/parseRef -------------------------------------------

test('parseRef/refKey: locale, remoto, oggetto, garbage fail-closed', async () => {
  const m = await grid();
  assert.deepEqual(m.parseRef('work'), { session: 'work' });
  assert.deepEqual(m.parseRef('phone:work'), { session: 'work', node: 'phone' });
  assert.deepEqual(m.parseRef('relay/phone:work'), { session: 'work', node: 'relay/phone' });
  assert.deepEqual(m.parseRef({ session: 'work', node: 'phone' }), { session: 'work', node: 'phone' });
  assert.deepEqual(m.parseRef({ session: 'work' }), { session: 'work' });
  assert.equal(m.parseRef(''), null);
  assert.equal(m.parseRef(null), null);
  assert.equal(m.parseRef({ session: 'x', node: '../evil' }), null, 'node fuori regex -> null');
  assert.equal(m.parseRef('NODO:x'), null, 'node maiuscolo -> null (strict come il proxy)');
  assert.equal(m.parseRef('phone:'), null, 'sessione vuota -> null');
  assert.equal(m.refKey('phone:work'), 'phone:work');
  assert.equal(m.refKey({ session: 'work' }), 'work');
  assert.equal(m.refKey({ session: 'work', node: 'phone' }), 'phone:work');
  assert.equal(m.refKey({ session: 'work', node: 'relay/phone' }), 'relay/phone:work');
  assert.equal(m.parseRef({ session: 'work', node: 'a/b/c/d/e' }), null, 'maximum four route segments');
  assert.equal(m.parseRef({ session: 'work', node: 'a/b/a' }), null, 'repeated route segment is rejected');
});

test('addTile con node: stessa sessione su nodi diversi coesiste, dedup per refKey', async () => {
  const m = await grid();
  let l = m.emptyLayout();
  l = m.addTile(l, 'work', 'end');                      // locale
  l = m.addTile(l, 'phone:work', 'end');                // remota, stesso nome
  l = m.addTile(l, 'relay/phone:work', 'end');
  assert.deepEqual(m.sessions(l), ['work', 'phone:work', 'relay/phone:work']);
  assert.equal(m.addTile(l, { session: 'work', node: 'phone' }, 'end'), l, 'dedup per refKey');
  const tiles = l.columns.flatMap((c) => c.tiles);
  assert.equal(tiles[0].node, undefined, 'tile locale senza campo node');
  assert.equal(tiles[1].node, 'phone');
});

test('moveTile/removeTile per refKey preservano node e fontSize', async () => {
  const m = await grid();
  let l = m.emptyLayout();
  l = m.addTile(l, 'phone:work', 'end');
  l = m.addTile(l, 'work', 'end');
  l = m.zoomTile(l, 0, 0, +3);
  const fs = l.columns[0].tiles[0].fontSize;
  l = m.moveTile(l, 'phone:work', { col: 1, row: 1 });
  const moved = l.columns.flatMap((c) => c.tiles).find((t) => m.refKey(t) === 'phone:work');
  assert.equal(moved.node, 'phone', 'node sopravvive al move');
  assert.equal(moved.fontSize, fs, 'fontSize sopravvive al move');
  l = m.removeTile(l, 'phone:work');
  assert.deepEqual(m.sessions(l), ['work'], 'remove per refKey non tocca la locale omonima');
});

test('preset toGrid2x2/toColumns preservano node', async () => {
  const m = await grid();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end');
  l = m.addTile(l, 'phone:b', 'end');
  for (const out of [m.toGrid2x2(l), m.toColumns(l)]) {
    const tb = out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'b');
    assert.equal(tb.node, 'phone');
  }
});

test('normalize: node assente -> locale (layout pre-B2), valido -> tenuto, garbage -> tile scartato', async () => {
  const m = await grid();
  const raw = {
    columns: [{
      width: 1,
      tiles: [
        { session: 'a', height: 1 },                       // pre-B2, locale
        { session: 'b', height: 1, node: 'phone' },        // remoto valido
        { session: 'c', height: 1, node: '../evil' },      // garbage -> scartato
        { session: 'd', height: 1, node: 42 },             // garbage -> scartato
      ],
    }],
  };
  const l = m.normalize(raw);
  assert.deepEqual(m.sessions(l), ['a', 'phone:b']);
  const tiles = l.columns.flatMap((c) => c.tiles);
  assert.equal(tiles[0].node, undefined);
  assert.equal(tiles[1].node, 'phone');
});

test('normalize: dedup per refKey (locale e remota omonime NON collassano)', async () => {
  const m = await grid();
  const raw = {
    columns: [
      { width: 1, tiles: [{ session: 'w', height: 1 }, { session: 'w', height: 1, node: 'vps' }] },
      { width: 1, tiles: [{ session: 'w', height: 1, node: 'vps' }] },   // duplicato remoto
    ],
  };
  const l = m.normalize(raw);
  assert.deepEqual(m.sessions(l), ['w', 'vps:w']);
});

// --- ws-client: path building ------------------------------------------------

test('wsTarget: locale /ws; remoto usa federation route', async () => {
  const m = await wsc();
  assert.equal(m.wsTarget(undefined, 'sekret'), '/ws', 'locale: mai token in URL');
  assert.equal(m.wsTarget(null, 'sekret'), '/ws');
  assert.equal(m.wsTarget('vps/phone', 'sek ret'), '/api/route/vps/phone/_/ws?token=sek%20ret');
  assert.equal(m.wsTarget('phone', ''), '/api/route/phone/_/ws?token=');
});

// --- nodes-model: aggregazione gruppi ----------------------------------------

test('buildNodeGroups: up con sessioni, down degradato, unreachable su errore fetch', async () => {
  const m = await nodes();
  const list = [
    { name: 'vps', tunnel: { status: 'up', pid: 1 } },
    { name: 'phone', tunnel: { status: 'down' } },
    { name: 'mac', tunnel: { status: 'up', pid: 2 } },
  ];
  const remote = {
    vps: { sessions: [{ name: 's1', attached: true }, { name: 's2' }] },
    mac: { error: 'node non raggiungibile' },
  };
  const g = m.buildNodeGroups({ nodes: list, remote, down: { phone: 111 } });
  assert.deepEqual(g.map((x) => [x.name, x.status]), [['mac', 'unreachable'], ['phone', 'down'], ['vps', 'up']]);
  const vps = g.find((x) => x.name === 'vps');
  assert.deepEqual(vps.sessions.map((s) => s.key), ['vps:s1', 'vps:s2']);
  assert.equal(vps.sessions[0].node, 'vps');
  assert.equal(g.find((x) => x.name === 'phone').downSince, 111);
  assert.deepEqual(g.find((x) => x.name === 'mac').sessions, [], 'degradato: niente spinner, lista vuota');
});

test('buildNodeGroups: zero nodi -> [] (UI identica a oggi); garbage filtrato', async () => {
  const m = await nodes();
  assert.deepEqual(m.buildNodeGroups({ nodes: [], remote: {}, down: {} }), []);
  assert.deepEqual(m.buildNodeGroups({}), []);
  const g = m.buildNodeGroups({ nodes: [{ name: '../evil', tunnel: { status: 'up' } }, null], remote: {} });
  assert.deepEqual(g, [], 'nomi fuori regex scartati');
});

test('buildNodeGroups: peer inbound privato resta nei settings ma non viene pubblicato nella sidebar', async () => {
  const m = await nodes();
  const g = m.buildNodeGroups({
    nodes: [
      { name: 'private-phone', direction: 'inbound', shared: false, tunnel: { status: 'up' } },
      { name: 'shared-mac', direction: 'inbound', shared: true, tunnel: { status: 'up' } },
      { name: 'hub', direction: 'outbound', shared: false, tunnel: { status: 'up' } },
    ],
    remote: { 'shared-mac': { sessions: [] }, hub: { sessions: [] } },
  });
  assert.deepEqual(g.map((x) => x.name), ['hub', 'shared-mac']);
});

test('buildNodeGroups: tunnel up ma sessions malformate -> unreachable (fail-closed)', async () => {
  const m = await nodes();
  const g = m.buildNodeGroups({
    nodes: [{ name: 'vps', tunnel: { status: 'up' } }],
    remote: { vps: { sessions: 'garbage' } },
  });
  assert.equal(g[0].status, 'unreachable');
});

test('buildNodeGroups: topology transitiva resta visibile offline con last-seen e torna live', async () => {
  const m = await nodes();
  const stale = m.buildNodeGroups({
    nodes: [{ name: 'relay', nodeId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tunnel: { status: 'up' } }],
    topology: [{ instanceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'phone', route: ['relay', 'phone'], stale: true, lastSeen: 123 }],
    remote: { relay: { sessions: [] } }, down: {},
  });
  const phone = stale.find((g) => g.name === 'phone');
  assert.equal(phone.status, 'offline');
  assert.equal(phone.lastSeen, 123);
  assert.deepEqual(phone.route, ['relay', 'phone']);

  const live = m.buildNodeGroups({
    topology: [{ instanceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'phone', route: ['relay', 'phone'], stale: false, lastSeen: 456 }],
    remote: { 'relay/phone': { sessions: [{ name: 'work' }] } }, down: {},
  });
  assert.equal(live[0].status, 'up');
  assert.equal(live[0].sessions[0].key, 'relay/phone:work');
});

test('buildNodeGroups: omissione autorevole rimuove owner invece di renderlo offline', async () => {
  const m = await nodes();
  const base = {
    nodes: [{ name: 'relay', nodeId: 'a'.repeat(32), tunnel: { status: 'up' } }],
    remote: { relay: { sessions: [] }, 'relay/pixel': { sessions: [] } },
    down: {},
  };
  const visible = m.buildNodeGroups({
    ...base,
    topology: [{ instanceId: 'b'.repeat(32), name: 'pixel', route: ['relay', 'pixel'], stale: false }],
  });
  assert.ok(visible.some((group) => group.name === 'pixel'));
  const withdrawn = m.buildNodeGroups({ ...base, topology: [] });
  assert.equal(withdrawn.some((group) => group.name === 'pixel'), false);
  assert.deepEqual(withdrawn.map((group) => group.name), ['relay']);
});

test('buildNodeGroups: alias viewer-local si applica solo al routed instanceId e non cambia route', async () => {
  const m = await nodes();
  const directId = 'a'.repeat(32);
  const routedId = 'b'.repeat(32);
  const groups = m.buildNodeGroups({
    nodes: [{ name: 'hub', label: 'Hub owner', nodeId: directId, tunnel: { status: 'down' } }],
    topology: [{ instanceId: routedId, name: 'samsung', route: ['hub', 'samsung'], stale: true, lastSeen: 123 }],
    aliases: { [directId]: 'Must not override owner label', [routedId]: 'Remote Workstation' },
  });
  const direct = groups.find((g) => g.direct);
  const routed = groups.find((g) => !g.direct);
  assert.equal(direct.label, 'Hub owner');
  assert.equal(direct.alias, null);
  assert.equal(routed.label, 'Remote Workstation');
  assert.equal(routed.alias, 'Remote Workstation');
  assert.equal(routed.originalLabel, 'hub › samsung');
  assert.deepEqual(routed.route, ['hub', 'samsung']);
  assert.equal(routed.instanceId, routedId);
});

test('trackDown: prima osservazione ricordata, up ripulisce, nodo rimosso sparisce', async () => {
  const m = await nodes();
  let d = m.trackDown({}, [{ name: 'a', tunnel: { status: 'down' } }, { name: 'b', tunnel: { status: 'up' } }], 100);
  assert.deepEqual(d, { a: 100 });
  d = m.trackDown(d, [{ name: 'a', tunnel: { status: 'down' } }, { name: 'b', tunnel: { status: 'down' } }], 200);
  assert.deepEqual(d, { a: 100, b: 200 }, 'a conserva la prima osservazione');
  d = m.trackDown(d, [{ name: 'a', tunnel: { status: 'up' } }], 300);
  assert.deepEqual(d, {}, 'a tornato su, b rimosso dalla config');
});

test('nodeBase: prefisso proxy per nodo, vuoto per locale', async () => {
  const m = await nodes();
  assert.equal(m.nodeBase(), '/api');
  assert.equal(m.nodeBase('vps/phone'), '/api/route/vps/phone/_');
});

test('all Sidebar remote group variants use the canonical full-route React key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'Sidebar.jsx'), 'utf8');
  assert.equal(src.includes('key={`nodo-${g.name}`}'), false);
  assert.equal((src.match(/key=\{`nodo-\$\{\(g\.route \|\| \[g\.name\]\)\.join\('\/'\)\}`\}/g) || []).length, 2);
});
