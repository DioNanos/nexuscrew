'use strict';
// Fixture condivisa del binario vl «attestato» per i test runtime del fleet.
// La registrazione all'up interroga il binario PINNATO con `host status`:
// perché il lancio sia dichiarato riuscito lo status deve portare un host
// LIVE con `peer_identity` verified (i sette fatti kernel del peer, schema
// 1) e le tre capacità peer/stop. Un finto che risponde `none` fisso fallisce
// l'up con VL_PEER_UNATTESTED: non è un difetto, è il gate. L'owner della
// tuple è l'instanceId hex32 del nodo (identityOwnerInstanceId): con owner
// `local` la tuple non è valida e l'up è rifiutato per contratto.

// hex32: la forma che validaHostIdentity richiede come instanceId.
const OWNER_INSTANCE_ID = 'ab'.repeat(16);

const BOOT_ID = '12345678-1234-1234-1234-123456789abc';

// `vl host status --json` di un host VIVO col peer attestato: le capacità
// peer/stop dichiarate in ogni stato (il preflight le chiede allo stesso
// binario, con lo stesso argv) e il blocco `peer_identity` verified.
const STATO_HOST_ATTESTATO = JSON.stringify({
  state: 'live',
  declared_pid: 4242,
  pid_number_in_use: true,
  capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
  peer_identity_support: 'supported',
  peer_identity: {
    schema_version: 1,
    state: 'verified',
    pid: 4242,
    uid: 1000,
    starttime: 1234,
    boot_id: BOOT_ID,
    pidns: 4026531836,
    pgid: 4242,
    sid: 4242,
  },
});

// La stessa tuple nella forma hostIdentity del contesto del launchId: i
// decimali kernel diventano stringhe e l'instanceId è l'owner del nodo.
const IDENTITA_ATTESTATA = {
  state: 'live',
  source: 'kernel-peer-v1',
  instanceId: OWNER_INSTANCE_ID,
  pid: 4242,
  uid: 1000,
  bootId: BOOT_ID,
  pidNamespaceInode: '4026531836',
  startTicks: '1234',
  pgid: 4242,
  sid: 4242,
};

module.exports = {
  OWNER_INSTANCE_ID,
  BOOT_ID,
  STATO_HOST_ATTESTATO,
  IDENTITA_ATTESTATA,
};
