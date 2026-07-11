'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/settings-model.js');

test('settings-model: isValidNodeName mirror ^[a-z0-9-]{1,32}$', async () => {
  const m = await mod();
  for (const ok of ['vps', 'a', 'phone-1', 'x'.repeat(32), '0']) {
    assert.equal(m.isValidNodeName(ok), true, `valido: ${ok}`);
  }
  for (const bad of ['VPS', 'a_b', 'a.b', 'x'.repeat(33), '', 'a/b', '../x', null, 7]) {
    assert.equal(m.isValidNodeName(bad), false, `invalido: ${JSON.stringify(bad)}`);
  }
});

test('settings-model: isValidSsh mirror parseSsh strict', async () => {
  const m = await mod();
  for (const ok of ['user@host', 'user@10.0.0.1', 'u.x-y@host.example.com']) {
    assert.equal(m.isValidSsh(ok), true, `valido: ${ok}`);
  }
  for (const bad of ['@host', 'user@', 'user', 'a@b@c', 'user @host', 'user@-flag',
    'user@host\n', '', null, 'u\0x@host', `user@${'h'.repeat(300)}${'x'.repeat(30)}`]) {
    assert.equal(m.isValidSsh(bad), false, `invalido: ${JSON.stringify(bad)}`);
  }
});

test('settings-model: parsePort — assente null, valida numero, garbage undefined', async () => {
  const m = await mod();
  assert.equal(m.parsePort(''), null);
  assert.equal(m.parsePort(null), null);
  assert.equal(m.parsePort(undefined), null);
  assert.equal(m.parsePort('41820'), 41820);
  assert.equal(m.parsePort(22), 22);
  assert.equal(m.parsePort('1'), 1);
  assert.equal(m.parsePort('65535'), 65535);
  for (const bad of ['0', '65536', '-1', 'abc', '1.5', '1e3', '999999', {}]) {
    assert.equal(m.parsePort(bad), undefined, `invalida: ${JSON.stringify(bad)}`);
  }
});

test('settings-model: validateNodeForm — separa porta SSH e porta NexusCrew', async () => {
  const m = await mod();
  const ok = m.validateNodeForm({ name: ' host ', ssh: ' user@host ', sshPort: '41822', remotePort: '41777' });
  assert.deepEqual(ok, { ok: true, value: { name: 'host', ssh: 'user@host', sshPort: 41822, remotePort: 41777 } });
  const noPort = m.validateNodeForm({ name: 'host', ssh: 'user@host', sshPort: '', remotePort: '' });
  assert.deepEqual(noPort, { ok: true, value: { name: 'host', ssh: 'user@host' } });
  assert.deepEqual(m.validateNodeForm({ name: 'HOST', ssh: 'user@host' }), { ok: false, error: 'err-node-name' });
  assert.deepEqual(m.validateNodeForm({ name: 'vps', ssh: 'nope' }), { ok: false, error: 'err-ssh' });
  assert.deepEqual(m.validateNodeForm({ name: 'host', ssh: 'user@host', sshPort: '0' }), { ok: false, error: 'err-ssh-port' });
  assert.deepEqual(m.validateNodeForm({ name: 'host', ssh: 'user@host', remotePort: '0' }), { ok: false, error: 'err-node-port' });
  assert.deepEqual(m.validateNodeForm({}), { ok: false, error: 'err-node-name' });
});

test('settings-model: validateRendezvousForm — richiesto se non stored, riuso se stored', async () => {
  const m = await mod();
  assert.deepEqual(m.validateRendezvousForm({ ssh: 'user@host' }),
    { ok: true, value: { rendezvousSsh: 'user@host' } });
  assert.deepEqual(m.validateRendezvousForm({ ssh: 'user@host', publishedPort: '42000' }),
    { ok: true, value: { rendezvousSsh: 'user@host', publishedPort: 42000 } });
  assert.deepEqual(m.validateRendezvousForm({ ssh: '' }, false),
    { ok: false, error: 'err-rendezvous-required' });
  assert.deepEqual(m.validateRendezvousForm({ ssh: '' }, true), { ok: true, value: {} });
  assert.deepEqual(m.validateRendezvousForm({ ssh: '', publishedPort: '42000' }, true),
    { ok: true, value: { publishedPort: 42000 } });
  assert.deepEqual(m.validateRendezvousForm({ ssh: 'bad ssh' }, true), { ok: false, error: 'err-ssh' });
  assert.deepEqual(m.validateRendezvousForm({ ssh: 'user@host', publishedPort: 'x' }), { ok: false, error: 'err-port' });
});

test('wizard: sequenza step dipende dal ruolo node', async () => {
  const m = await mod();
  assert.deepEqual(m.wizardSteps({ client: true, node: false }), ['roles', 'node', 'done']);
  assert.deepEqual(m.wizardSteps({ client: true, node: true }), ['roles', 'node', 'rendezvous', 'done']);
  assert.deepEqual(m.wizardSteps(null), ['roles', 'node', 'done'], 'roles assenti = niente rendezvous');
});

test('wizard: nextStep/prevStep — transizioni, clamp agli estremi, step ignoto', async () => {
  const m = await mod();
  const noNode = { client: true, node: false };
  const withNode = { client: false, node: true };
  assert.equal(m.nextStep('roles', noNode), 'node');
  assert.equal(m.nextStep('node', noNode), 'done', 'senza ruolo node salta il rendezvous');
  assert.equal(m.nextStep('node', withNode), 'rendezvous');
  assert.equal(m.nextStep('rendezvous', withNode), 'done');
  assert.equal(m.nextStep('done', withNode), 'done', 'clamp in fondo');
  assert.equal(m.prevStep('roles', noNode), 'roles', 'clamp in cima');
  assert.equal(m.prevStep('done', noNode), 'node');
  assert.equal(m.prevStep('done', withNode), 'rendezvous');
  assert.equal(m.nextStep('garbage', noNode), 'roles', 'step ignoto riparte da roles');
});

test('wizard: initialWizard — client on, node off, step roles', async () => {
  const m = await mod();
  assert.deepEqual(m.initialWizard(), { step: 'roles', roles: { client: true, node: false } });
});

test('tunnelInfo: up con since relativo, down senza, garbage = down', async () => {
  const m = await mod();
  const now = 1_000_000_000_000;
  assert.deepEqual(m.tunnelInfo({ status: 'up', pid: 1, since: now - 3 * 60_000 }, now),
    { up: true, label: 'tunnel-up', since: '3m' });
  assert.deepEqual(m.tunnelInfo({ status: 'up', pid: 1, since: null }, now),
    { up: true, label: 'tunnel-up', since: null });
  assert.deepEqual(m.tunnelInfo({ status: 'down' }, now),
    { up: false, label: 'tunnel-down', since: null });
  assert.deepEqual(m.tunnelInfo(null, now), { up: false, label: 'tunnel-down', since: null });
  assert.equal(m.relCompact(now - 30_000, now), 'ora');
  assert.equal(m.relCompact(now - 2 * 3600_000, now), '2h');
  assert.equal(m.relCompact(now - 3 * 86400_000, now), '3g');
  assert.equal(m.relCompact(now + 5000, now), null, 'futuro = null');
});
