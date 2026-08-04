'use strict';
// tests/node-detail.test.js — il modello del FOGLIO di un nodo.
//
// La riga la vincola node-summary.test.js. Qui si vincola il livello sotto, e
// in particolare i punti dove il foglio potrebbe dire una cosa vera in un posto
// che la rende falsa: l'autorita' di un nodo che non e' accoppiato con noi, una
// concessione che sparisce dall'elenco perche' il nodo concesso non risponde,
// due bottoni opposti mostrati insieme.

const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/node-detail.js');

test('node-detail: un nodo in transito non ha autorita\' su questa macchina', async () => {
  const { nodeAuthority } = await mod();
  // E' accoppiato con l'hub che lo instrada, non con noi. Chiamarlo
  // "owner-equivalent" come un peer diretto sarebbe falso in eccesso, e falso
  // in eccesso su un pannello di sicurezza si paga.
  const routed = nodeAuthority({ kind: 'transitive', name: 'x' });
  assert.equal(routed.ownerEquivalent, false);
  const direct = nodeAuthority({ name: 'x', direction: 'inbound' });
  assert.equal(direct.ownerEquivalent, true);
  assert.notEqual(routed.key, direct.key);
});

test('node-detail: lo slot dei poteri resta vuoto finche\' i grant non esistono', async () => {
  const { nodeAuthority } = await mod();
  // Se un giorno questa lista si popola senza che esista NC-E, il foglio sta
  // promettendo poteri che nessuno ha concesso.
  for (const node of [{ name: 'a' }, { name: 'b', kind: 'transitive' }, { name: 'c', shared: true, visibility: 'network' }]) {
    const authority = nodeAuthority(node);
    assert.deepEqual(authority.grants, []);
    assert.equal(authority.model, 'none');
  }
});

test('node-detail: una concessione verso un nodo che non risponde resta nell\'elenco', async () => {
  const { selectionGrants } = await mod();
  const nodes = [{ name: 'vivo', nodeId: 'id-vivo', label: 'Portatile' }];
  const grants = selectionGrants({ name: 'peer', visibility: 'selected', selected: ['id-vivo', 'id-sparito'] }, nodes);
  assert.equal(grants.length, 2, 'la concessione e\' viva lato server anche se il nodo non si vede');
  assert.equal(grants[0].label, 'Portatile');
  assert.equal(grants[1].id, 'id-sparito');
  assert.equal(grants[1].known, false, 'va detto che non si sa a chi corrisponde, non nascosto');
});

test('node-detail: fuori da "selected" non ci sono concessioni da mostrare', async () => {
  const { selectionGrants } = await mod();
  // Il server conserva la lista quando si passa a `network`: mostrarla la
  // farebbe leggere come restrizione attiva mentre il nodo vede tutto.
  assert.deepEqual(selectionGrants({ visibility: 'network', selected: ['id-a'] }, []), []);
  assert.deepEqual(selectionGrants({ visibility: 'relay-only', selected: ['id-a'] }, []), []);
});

test('node-detail: il picker non offre se stesso, i gia\' concessi o chi non ha identita\'', async () => {
  const { selectionCandidates } = await mod();
  const node = { name: 'peer', visibility: 'selected', selected: ['id-concesso'] };
  const nodes = [
    { name: 'peer', nodeId: 'id-self', label: 'Io' },
    { name: 'gia', nodeId: 'id-concesso', label: 'Gia concesso' },
    { name: 'senza-id', label: 'Mai accoppiato' },
    { name: 'buono', nodeId: 'id-buono', label: 'Fisso' },
    { name: 'doppio', nodeId: 'id-buono', label: 'Fisso (duplicato)' },
  ];
  const out = selectionCandidates(node, nodes);
  assert.deepEqual(out.map((x) => x.id), ['id-buono'], 'uno solo, e senza duplicati per nodeId');
});

test('node-detail: il picker cerca su etichetta e nome, senza maiuscole', async () => {
  const { selectionCandidates } = await mod();
  const nodes = [
    { name: 'mac-air', nodeId: 'a', label: 'MacBook' },
    { name: 'pixel', nodeId: 'b', label: 'Telefono' },
  ];
  const node = { name: 'peer', visibility: 'selected', selected: [] };
  assert.deepEqual(selectionCandidates(node, nodes, 'macbook').map((x) => x.id), ['a']);
  assert.deepEqual(selectionCandidates(node, nodes, 'PIXEL').map((x) => x.id), ['b'], 'il nome vale quanto l\'etichetta');
  assert.deepEqual(selectionCandidates(node, nodes, 'niente'), []);
});

test('node-detail: connetti e disconnetti non compaiono mai insieme', async () => {
  const { nodeActions } = await mod();
  const actions = { connect: true, disconnect: true, restart: true };
  const su = nodeActions({ name: 'n', actions, tunnel: { status: 'up' } }).map((a) => a.action);
  const giu = nodeActions({ name: 'n', actions, tunnel: { status: 'down' } }).map((a) => a.action);
  assert.equal(su.includes('down'), true);
  assert.equal(su.includes('up'), false, 'un tunnel su non si accende');
  assert.equal(giu.includes('up'), true);
  assert.equal(giu.includes('down'), false);
});

test('node-detail: in sola lettura la prova resta viva, le mutazioni no', async () => {
  const { nodeActions } = await mod();
  // Un nodo che non risponde va diagnosticato anche da un pannello readonly:
  // e' l'unico momento in cui "prova" serve davvero.
  const out = nodeActions(
    { name: 'n', actions: { edit: true, test: true, remove: true, restart: true }, tunnel: { status: 'up' } },
    { readonly: true },
  );
  const by = Object.fromEntries(out.map((a) => [a.action, a]));
  assert.equal(by.test.disabled, false);
  assert.equal(by.edit.disabled, true);
  assert.equal(by.remove.disabled, true);
  assert.equal(by.remove.danger, true);
  assert.equal(by.restart.disabled, true);
});

test('node-detail: un\'operazione in corso blocca tutto, prova compresa', async () => {
  const { nodeActions } = await mod();
  const out = nodeActions({ name: 'n', actions: { test: true, edit: true }, tunnel: { status: 'up' } }, { busy: true });
  assert.equal(out.every((a) => a.disabled), true);
});

test('node-detail: il foglio porta il percorso di un nodo instradato e non porta segreti', async () => {
  const { nodeDetailModel } = await mod();
  const model = nodeDetailModel(
    { name: 'peer', label: 'Fisso', kind: 'transitive', route: ['hub', 'peer'], token: 'segreto', acceptToken: 'segreto2' },
    [],
  );
  assert.deepEqual(model.identity.route, ['hub', 'peer']);
  assert.equal(model.identity.ssh, null, 'un nodo in transito non ha un endpoint SSH nostro');
  const serial = JSON.stringify(model);
  assert.equal(serial.includes('segreto'), false);
});

test('node-detail: la visibilita\' si modifica solo dove il server la espone e il nodo e\' condiviso', async () => {
  const { nodeDetailModel } = await mod();
  const base = { name: 'peer', direction: 'inbound' };
  assert.equal(nodeDetailModel({ ...base, shared: true, actions: { visibility: true } }, []).canEditVisibility, true);
  assert.equal(nodeDetailModel({ ...base, shared: false, actions: { visibility: true } }, []).canEditVisibility, false);
  assert.equal(nodeDetailModel({ ...base, shared: true, actions: {} }, []).canEditVisibility, false);
  assert.equal(nodeDetailModel({ label: 'senza nome' }, []), null);
});
