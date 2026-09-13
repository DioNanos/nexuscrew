# Identity verify channel — v1

Contratto del canale di **verifica online** di un identity proof presso
l'authority NexusCrew, per il daemon app-server (processo VL) lanciato dal
supervisore di cella. Riferimenti: contratto identita' BC
(clausole su chiave, replay e revoca),
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

## 2. Emissione `nexuscrew/identity/challengeProof` (v1)

La risposta del metodo già esistente sul canale fd3/fd4 è il proof raw
authority-owned che il client presenta al daemon dopo `initialized`:

```json
{"jsonrpc":"2.0","id":7,"result":{"proof":{
  "kind":"identity-proof","ownerInstanceId":"…","cellId":"…",
  "audience":"daemon/…","incarnationId":"…","launchEpoch":"…",
  "daemonBootId":"…","connectionId":"…","challenge":"<64hex>",
  "nonce":"<64hex>","parentJti":"<64hex>","jti":"<64hex>",
  "issuedAt":1700000000000,"expiresAt":1700000005000,
  "authorityGeneration":"<64hex>","generation":0,
  "tmuxSession":"cloud-…","bindingId":"<64hex>",
  "scopes":["thread/start"],"proof":"<64hex hmac>"
}}}
```

`authorityGeneration` identifica l'incarnazione dell'authority e resta distinto
da `generation`, che è la generazione numerica del supervisore/lease. I campi
`tmuxSession` (derivato dal `cellId` canonico), `bindingId` (il `jti` authority
generato) e `scopes` (policy authority) sono emessi e firmati dall'authority;
non sono accettati dal body della richiesta challenge-proof. Il proof contiene
solo dati del record di lease/subject autenticato e della generation verificata
dal lease server.

La forma è additiva nello stesso v1. Un consumer deve rifiutare il bind se uno
dei claim richiesti dal proprio envelope non è presente o non è coerente; non
può completarli con env, sessione tmux, MCP o placeholder locali.

## 3. Richiesta `nexuscrew/identity/verify` (v1)

```json
{"jsonrpc":"2.0","id":7,"method":"nexuscrew/identity/verify",
 "params":{"v":1,"generation":3,
           "proof":{"kind":"identity-proof","ownerInstanceId":"…","cellId":"…",
                    "audience":"nexuscrew-lease","incarnationId":"…",
                    "launchEpoch":"…","daemonBootId":"…","connectionId":"…",
                    "challenge":"<64hex>","nonce":"<64hex>","parentJti":"<64hex>",
                    "jti":"<64hex>","issuedAt":1700000000000,
                    "expiresAt":1700000005000,"authorityGeneration":"<64hex>",
                    "generation":3,"tmuxSession":"cloud-…",
                    "bindingId":"<64hex>","scopes":["thread/start"],
                    "proof":"<64hex hmac>"}}}
```

Vincoli: `v === 1`; `generation` = generazione corrente del supervisore;
`proof` = oggetto con tutti i `PROOF_FIELDS` e `proof` hex-64. Campi extra →
rifiuto `invalid-request` (lo schema e' chiuso).

## 4. Risposta (JSON-RPC result, v1)

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

## 5. Errori (result `ok:false` lato lease / error JSON-RPC lato fd)

`reason` (enum chiusa, origine):

| reason | origine | significato |
|---|---|---|
| `invalid-request` | fd gate | richiestа non conforme allo schema |
| `identity-unverified` | fd gate/relay | canale non registrato o request malformata |
| `verify-unsupported` | lease server | server senza metodo verify — fail-closed |
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

## 6. Semantica

- **Timeout**: 4000 ms per_attempt lato lease-client (`IDENTITY_TIMEOUT_MS`),
  invariato; il supervisore non ritenta (single-shot per `requestId`).
- **Replay**: il primo `verify` consuma il proof (`reserveReplay(nonce)`):
  ogni verifica successiva dello stesso proof → `replay`. Il bind e' one-shot.
- **Revoca**: `authority.revoke(jti, horizon)` invalida `jti` e `parentJti`
  (orizzonte default = CHALLENGE_TTL + GRANT_TTL). Nessuna lista offline.
- **Restart authority**: la `authorityGeneration` dell'authority cambia → tutti i proof
  pre-restart falliscono con `generation` (fail-closed, gia' implementato).
- **Compatibilita'**: standalone (Fleet OFF): nessuna challenge, `bind()` non
  raggiungibile, verify mai invocato. Fleet ON: authority irraggiungibile o
  assente → `ok:false` → fail-closed (rifiuto del bind). Celle vive al restart
  del server NC: il canale di lease chiude, il supervisore riannuncia; i verify in
  volo rispondono `revoked`/`timeout` e i bind in corso falliscono (fail-closed).

## 7. Mappatura implementativa lato NC

| passaggio | file |
|---|---|
| verifica authority | `lib/fleet/identity-authority.js` `verifyChallengeProof` (riusa `verify` :68-94 + replay/revoke :113-147) — nessuna modifica alla crypto |
| metodo sul lease UDS | `lib/fleet/cell-lease-server.js` `handleVerify` + dispatch `type:'verify'` |
| client lease | `lib/fleet/lease-client.js` `verifyProof({requestId, generation, proof})` (timeout 4000 ms) |
| relay fd3/fd4 | `lib/fleet/cell-exec.js` metodo `nexuscrew/identity/verify` in `createIdentityChannel` |
| handle al processo | env `NEXUSCREW_IDENTITY_FD=3:4` (cell-exec.js:455, gia' presente) |

## 8. Estensione v1.1 (post-audit) — claims completi e verifica legata alla challenge

Il v1 escludeva `nonce` dai claims (restava server-side): il v1.1 lo
RESTITUISCE dal record dell'authority perche' il lato VL lo confronta con
`prepared.challenge` al commit senza fallback ai claim esterni.

Estensione **additiva** del v1 (motivazione: un client v1 esistente deve
continuare a funzionare senza modifiche; i campi nuovi sono opzionali nella
richiesta e ignorabili — con serde di default — nella risposta). Nessun
breaking: il daemon VL che implementa il v1.1 chiude i due bypass del binding
riprodotti dall'audit finale; il daemon v1 (46ccf38) resta operativo e la sua
finestra cross-challenge si chiude quando aggiornera' la richiesta.

### 8.1 Richiesta verify v1.1 (fd3/fd4)

```json
{"jsonrpc":"2.0","id":7,"method":"nexuscrew/identity/verify",
 "params":{"v":1,"generation":3,
           "proof":{"...":"PROOF_FIELDS + proof hex-64, invariato"},
           "expected":{"nonce":"<64hex>","connectionId":"…",
                       "daemonBootId":"…","audience":"…"}}}
```

- `expected` e' **opzionale** in v1.1 (retro-compat) ma, se presente, ha
  **schema chiuso**: esattamente 4 chiavi, `nonce` hex-64, gli altri tre
  stringhe non vuote (max 200 char). Forma malformata → rifiuto
  (`invalid request` lato fd, `identity-unverified` lato lease), senza relay.
- La tupla e' quella attesa dal daemon per la PROPRIA connessione: proviene
  dalla challenge ricevuta in `initialize`, mai da input del client.

### 8.2 Risposta v1.1: claims completi (v1.1 superset del v1)

```json
{"jsonrpc":"2.0","id":7,
 "result":{"ok":true,"v":1,
   "claims":{"ownerInstanceId":"…","issuerOwner":"…","cellId":"…",
             "audience":"…","incarnationId":"…","launchEpoch":"…",
             "daemonBootId":"…","connectionId":"…","nonce":"<64hex>",
             "issuedAt":1700000000000,"notBefore":1700000000000,
             "expiresAt":1700000005000,"generation":3,
             "tmuxSession":"cloud-…","bindingId":"<64hex>",
             "scopes":["thread/start"],"origin":"local_tui"}}}
```

Tutti i campi che entrano nel binding VL sono **authority-normalizzati**:
nessun campo del binding puo' arrivare dai claim esterni del client.

| campo | sorgente |
|---|---|
| `ownerInstanceId`, `cellId`, `audience`, `incarnationId`, `launchEpoch`, `daemonBootId`, `connectionId`, `issuedAt`, `expiresAt`, `generation` | proof firmato ri-verificato (invariato v1) |
| `nonce` | RECORD dell'authority: il nonce della challenge per cui il proof e' stato emesso (coincide con `proof.challenge`); mai un valore di input |
| `tmuxSession`, `bindingId`, `scopes` | proof firmato (emessi dall'authority, § 2) |
| `issuerOwner` | = `ownerInstanceId` (mappatura legacy `remote.rs:384`) |
| `notBefore` | = `issuedAt` (stessa finestra del proof) |
| `origin` | `'local_tui'`: contesto del canale lease locale |

`threadId`/`cwd`/`liveHost` non sono restituiti: opzionali lato VL e non
richiesti da `IdentityClaims::validate()` per `origin = local_tui`.

### 8.3 Nuovo reason `challenge_mismatch`

Con la tupla `expected` presente, l'authority rifiuta con
`ok:false, reason:'challenge_mismatch'` quando:

1. `expected.nonce` non e' una challenge **emessa** da questa authority
   (registro challenge, scadute escluse), oppure
2. la tupla non coincide con i campi dell'emissione (`audience`,
   `daemonBootId`, `connectionId` del record), oppure
3. il proof non corrisponde alla tupla (qualsiasi campo divergente);
4. la challenge di emissione non e' piu' nel registro dell'authority
   (scaduta/sweep): il nonce dei claims non puo' essere confermato dal
   record, quindi fail-closed anche per un proof HMAC valido.

`challenge_mismatch` entra nell'enum chiusa dei reason (§ 5); lato fd il
reason mappa su `AUDIENCE_MISMATCH` (come il mismatch challenge-side del
`prepare()` VL). Semantica: **fail-closed** — il daemon rifiuta il bind; un
proof valido firmato per un'altra challenge non e' trasferibile.

### 8.4 Obblighi lato VL (v1.1)

- `VerifiedIdentityClaims` esteso con `tmuxSession`, `bindingId`, `scopes`,
  `issuerOwner`, `notBefore`, `origin`: il binding si costruisce **solo** dai
  claims verificati, nessun merge con i claim esterni del client.
- La richiesta verify porta `expected` = tupla della challenge corrente.
- `challenge_mismatch` → `AudienceMismatch` (rifiuto bind, fail-closed).

## 9. Provisioning (authority mode)

The authority mode is opt-in and must be provisioned on the host that runs the
NexusCrew service. Nothing ships with credentials: the launcher only exports
`CODEX_APP_SERVER_IDENTITY_REQUIRED=1` when the mode is `authority` AND the
authority is constructible (both credential files present, 0600, distinct).

### 9.1 Provision

```bash
nexuscrew identity provision             # writes credentials + activates authority mode
nexuscrew identity provision --no-write-config   # prints the keys, writes nothing to config
nexuscrew identity provision --force     # regenerate both credentials (old ones invalidated)
```

What it does:

1. Creates `~/.nexuscrew/identity-authority/` with mode `0700` (override the
   directory with `--dir` or `identityAuthorityDir` in config).
2. Writes two distinct random credentials (32 bytes, hex) as
   `daemon.credential` and `launcher.credential`, both mode `0600`. Existing
   files are never overwritten without `--force`.
3. Sets `fleet.identity.mode = "authority"` in the NexusCrew config
   (`config.json`), unless `--no-write-config` is passed.

`loadConfig` picks the credentials up automatically from the two files: they
are never logged, echoed, or included in any API/federation payload.

**Enforced at load.** The distinctness and the permissions are not conventions:
at load time, identical credentials, credential files that are not mode `0600`,
or an authority directory that is not mode `0700` are refused — the authority
is not constructed, the launcher exports `CODEX_APP_SERVER_IDENTITY_REQUIRED=0`
with a structured log naming the reason, and `nexuscrew doctor` reports the
fault (`credentials distinct: no`, permission problems) without exposing any
value. `nexuscrew identity provision` also refuses to ever write identical
credentials, even with `--force`.

### 9.2 Activate

Restart the NexusCrew service after provisioning. At launch, the fleet runtime
builds the authority, starts emitting launch subjects, and the cell launcher
exports `CODEX_APP_SERVER_IDENTITY_REQUIRED=1` for codex-vl cells. Run
`nexuscrew doctor` to confirm: the `Fleet identity authority mode` check shows
the mode and whether the authority is constructible.

### 9.3 Rollback

Set `fleet.identity.mode = "legacy"` in the config (or remove the key) and
restart the service. Cells keep working with the legacy identity variables
(`TMUX` / `TMUX_PANE` / `NEXUSCREW_MCP_SESSION`); the launcher exports
`CODEX_APP_SERVER_IDENTITY_REQUIRED=0`. The credential files can stay in place
(deleted with `--force` regeneration or manually if you want the mode fully
off).
