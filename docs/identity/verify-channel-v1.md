# Identity verify channel — v1 (D-199)

Contratto del canale di **verifica online** di un identity proof presso
l'authority NexusCrew, per il daemon app-server (processo VL) lanciato dal
supervisore di cella. Riferimenti: contratto identita' BC
(`2026-09-05_D174_CONTRATTO_IDENTITA_BC.md`, clausole C2/C7/C7-bis/C8-bis),
`lib/fleet/identity-authority.js` (`verify`/`verifyChallengeProof`, replay e
revoke store), `lib/fleet/cell-lease-server.js` (canale lease UDS),
`lib/fleet/cell-exec.js` (canale identita' fd3/fd4, JSON-RPC 2.0).

Principi non negoziabili:

1. **La chiave HMAC non lascia mai l'authority** (C2): il daemon non verifica
   da solo; interroga online.
2. **Il subject e' il record autenticato del lancio** (C7-bis): mai un campo
   del messaggio. L'authority confronta i claims del proof con il record
   della cella (`ownerInstanceId`, `cellId`, `incarnationId`, `launchEpoch`).
3. **Fail-closed**: authority assente/giu'/timeout → il verify fallisce; il
   daemon rifiuta il bind (`IdentityUnverified`).

## 1. Canali (invariati, riutilizzati)

```
daemon (VL) --fd3/fd4 (JSON-RPC 2.0, line JSON)--> supervisore cella
   supervisore --UDS lease (JSON line, un msg per riga)--> bridge/authority NC
```

- **Handle**: il supervisore passa `NEXUSCREW_IDENTITY_FD=3:4` nell'env del
  processo (cell-exec.js:455, meccanismo gia' esistente). Nessun nuovo canale:
  il verify e' un metodo in piu' sugli stessi fd/socket.
- **Frame identita'** (fd3/fd4): JSON-RPC 2.0, una riga per messaggio, metodi:
  - `nexuscrew/identity/challengeProof` (esistente)
  - `nexuscrew/identity/verify` (nuovo, v1)
- **Frame lease UDS** (line-oriented, tipo `type`):
  - `{"type":"verify","requestId":<int>,"generation":<int>,"v":1,"proof":{...}}`
  - `{"type":"verifyResult","requestId":<int>,"ok":true|false,"reason"?:string,"claims"?:{...},"v":1}`

## 2. Richiesta `nexuscrew/identity/verify` (v1)

```json
{"jsonrpc":"2.0","id":7,"method":"nexuscrew/identity/verify",
 "params":{"v":1,"generation":3,
           "proof":{"kind":"identity-proof","ownerInstanceId":"…","cellId":"…",
                    "audience":"nexuscrew-lease","incarnationId":"…",
                    "launchEpoch":"…","daemonBootId":"…","connectionId":"…",
                    "challenge":"<64hex>","nonce":"<64hex>","parentJti":"<64hex>",
                    "jti":"<64hex>","issuedAt":1700000000000,
                    "expiresAt":1700000005000,"generation":3,
                    "proof":"<64hex hmac>"}}}
```

Vincoli: `v === 1`; `generation` = generazione corrente del supervisore;
`proof` = oggetto con tutti i `PROOF_FIELDS` e `proof` hex-64. Campi extra →
rifiuto `invalid-request` (lo schema e' chiuso).

## 3. Risposta (JSON-RPC result, v1)

```json
{"jsonrpc":"2.0","id":7,
 "result":{"ok":true,"v":1,
   "claims":{"ownerInstanceId":"…","cellId":"…","audience":"nexuscrew-lease",
             "incarnationId":"…","launchEpoch":"…","daemonBootId":"…",
             "connectionId":"…","issuedAt":1700000000000,
             "expiresAt":1700000005000,"generation":3}}}
```

`claims` sono i campi NORMALIZZATI ri-verificati dall'authority (senza
`proof/nonce/parentJti/jti/challenge`, che restano server-side). Il daemon
confronta `claims` con la challenge attesa prima del bind.

## 4. Errori (result `ok:false` lato lease / error JSON-RPC lato fd)

`reason` (enum chiusa, origine):

| reason | origine | significato |
|---|---|---|
| `invalid-request` | fd gate | richiestа non conforme allo schema |
| `identity-unverified` | fd gate/relay | canale non registrato o request malformata |
| `verify-unsupported` | lease server | server senza metodo verify (pre-D-199) — fail-closed |
| `revoked` | lease guard | lease non live, generazione/diversita' socket/cella |
| `authority-unavailable` | lease guard | authority non configurata sul server |
| `malformed` | authority | proof assente/malformato |
| `expired` | authority | `expiresAt <= now` |
| `bad-proof` | authority | HMAC non corrisponde |
| `replay` | authority | `nonce` gia' consumato (single-use) |
| `revoked` | authority | `jti`/`parentJti` in revoke store |
| `generation` | authority | proof di un'authority precedente (restart) |
| `ownerInstanceId`/`cellId`/`incarnationId`/`launchEpoch` | authority | claim non coerente col subject autenticato |
| `timeout` | fd/lease client | 4000 ms (IDENTITY_TIMEOUT_MS, gia' esistente) |

Il `reason` di mismatch su un campo atteso usa il NOME DEL CAMPO (comportamento
gia' esistente di `verify()`), mai dettagli del valore.

## 5. Semantica

- **Timeout**: 4000 ms per_attempt lato lease-client (`IDENTITY_TIMEOUT_MS`),
  invariato; il supervisore non ritenta (single-shot per `requestId`).
- **Replay**: il primo `verify` consuma il proof (`reserveReplay(nonce)`):
  ogni verifica successiva dello stesso proof → `replay`. Il bind e' one-shot.
- **Revoca**: `authority.revoke(jti, horizon)` invalida `jti` e `parentJti`
  (orizzonte default = CHALLENGE_TTL + GRANT_TTL). Nessuna lista offline.
- **Restart authority**: la `generation` dell'authority cambia → tutti i proof
  pre-restart falliscono con `generation` (fail-closed, gia' implementato).
- **Compatibilita'**: standalone (Fleet OFF): nessuna challenge, `bind()` non
  raggiungibile, verify mai invocato. Fleet ON: authority irraggiungibile o
  assente → `ok:false` → fail-closed (rifiuto del bind). Celle vive al restart
  del server NC: il canale D-183 chiude, il supervisore riannuncia; i verify in
  volo rispondono `revoked`/`timeout` e i bind in corso falliscono (fail-closed).

## 6. Mappatura implementativa lato NC

| passaggio | file |
|---|---|
| verifica authority | `lib/fleet/identity-authority.js` `verifyChallengeProof` (riusa `verify` :68-94 + replay/revoke :113-147) — nessuna modifica alla crypto |
| metodo sul lease UDS | `lib/fleet/cell-lease-server.js` `handleVerify` + dispatch `type:'verify'` |
| client lease | `lib/fleet/lease-client.js` `verifyProof({requestId, generation, proof})` (timeout 4000 ms) |
| relay fd3/fd4 | `lib/fleet/cell-exec.js` metodo `nexuscrew/identity/verify` in `createIdentityChannel` |
| handle al processo | env `NEXUSCREW_IDENTITY_FD=3:4` (cell-exec.js:455, gia' presente) |
