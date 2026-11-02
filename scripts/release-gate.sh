#!/usr/bin/env bash
# Release gate for the fleet-VL candidate.
#
# Purpose: an exit 0 from the plain suite glob says nothing, because every
# real-binary test silently skips when the binaries are not declared. This
# gate refuses to start without the exact real binaries, verifies their full
# SHA256 before any test runs, refuses a binary without the profile selector
# capability, runs the whole fleet suite under a memory/tasks cap with a
# private HOME/XDG/TMPDIR, and then checks the result BY NAME: the mandatory
# real-binary tests must have run and passed, and the only tolerated skips
# are the ones listed below with a reason.
#
# Required environment (all five, checked before Node starts):
#   NC_VL_REAL_BIN          the qualified VL binary (peer/stop capable)
#   NC_VL_REAL_BIN_SHA256   its full SHA256 (64 hex chars)
#   NC_VL_OLD_REAL_BIN      an older real VL binary, used as the negative
#   NC_VL_STATUS_BIN        the VL binary the status contract is proven on
#   NEXUSCREW_VL_REAL_BIN   the VL client binary (composition, profiles, TUI)
# Optional:
#   NC_VL_OLD_REAL_BIN_SHA256  expected hash of the old binary; when unset a
#                              sidecar "<old>.sha256" next to it is required
#   NEXUSCREW_GATE_LOG_DIR     keep the gate artifacts somewhere specific
#   NEXUSCREW_TEST_CONCURRENCY suite concurrency (default 2, measured on the
#                              reference machine; higher is not more truth)
#
# Exit codes: 0 candidate viable · 2 missing variable · 3 bad binary path or
# unusable/wrong node interpreter · 4 hash mismatch or undeclared ·
# 5 missing profile-selector capability · 6 suite run failed ·
# 7 mandatory test missing/skipped/failed · 8 unexpected skip (or a tolerated
# name skipped for a reason that does not carry its marker) ·
# 9 leftover processes after the run.

set -uo pipefail
IFS=$'\n\t'
cd "$(dirname "$0")/.."

die() { printf 'release-gate: REFUSED (%s): %s\n' "$1" "$2" >&2; exit "$3"; }
note() { printf 'release-gate: %s\n' "$1" >&2; }

# --- 1. declared world, checked before anything else starts -----------------

for var in NC_VL_REAL_BIN NC_VL_REAL_BIN_SHA256 NC_VL_OLD_REAL_BIN \
           NC_VL_STATUS_BIN NEXUSCREW_VL_REAL_BIN; do
  val="${!var:-}"
  [ -n "$val" ] || die 'missing-variable' "\$${var} is not set: the gate refuses to run a suite whose real-binary tests would silently skip" 2
done

NEW_BIN=$NC_VL_REAL_BIN
OLD_BIN=$NC_VL_OLD_REAL_BIN
STATUS_BIN=$NC_VL_STATUS_BIN
CLIENT_BIN=$NEXUSCREW_VL_REAL_BIN

command -v sha256sum >/dev/null 2>&1 || die 'environment' 'sha256sum is required' 3
command -v systemd-run >/dev/null 2>&1 || die 'environment' 'systemd-run --user is required to enforce the memory/tasks cap' 3

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# The interpreter that runs the suite is part of the qualification. It may be
# pinned with NEXUSCREW_GATE_NODE; whatever its source it must be a real,
# executable file, and at least major 22: measured on the reference machine,
# the default interpreter (24.10.0) silently refused the vl root claim on ~96
# tests that are green under the qualified 24.21.0 — same tree, same env. A
# wrong interpreter turns the gate into a wall of environmental reds, so it is
# refused here, before anything is started. The version floor alone does not
# identify a build, so the interpreter is also bound by full SHA256 to the
# node pinned in lib/fleet/vl-claim-pin-manifest.json — the same pin the fleet
# runtime enforces when it claims a vl root — and the comparison happens
# before the interpreter is executed at all: the refusal names both hashes so
# the operator can see which side moved.
GATE_NODE=${NEXUSCREW_GATE_NODE:-$(command -v node)}
[ -n "$GATE_NODE" ] || die 'node-interpreter' 'no node interpreter on PATH and NEXUSCREW_GATE_NODE is not set' 3
if [ -n "${NEXUSCREW_GATE_NODE:-}" ]; then
  [ -f "$GATE_NODE" ] || die 'node-interpreter' "NEXUSCREW_GATE_NODE is not a regular file: $GATE_NODE" 3
  [ -x "$GATE_NODE" ] || die 'node-interpreter' "NEXUSCREW_GATE_NODE is not executable: $GATE_NODE" 3
fi
PIN_MANIFEST=lib/fleet/vl-claim-pin-manifest.json
[ -f "$PIN_MANIFEST" ] || die 'node-interpreter' "claim pin manifest not found: $PIN_MANIFEST (the interpreter cannot be qualified)" 3
PIN_NODE_SHA=$(awk '/"node"[[:space:]]*:/ { in_node = 1; next } in_node && /"sha256"[[:space:]]*:/ { sub(/.*"sha256"[[:space:]]*:[[:space:]]*"/, ""); sub(/"[[:space:]]*,?[[:space:]]*$/, ""); print; exit }' "$PIN_MANIFEST" | tr 'A-F' 'a-f')
printf '%s' "$PIN_NODE_SHA" | grep -Eq '^[0-9a-f]{64}$' || die 'node-interpreter' "the pin manifest does not carry a full 64-hex node sha256: $PIN_MANIFEST" 3
GATE_NODE_SHA=$(sha_of "$GATE_NODE")
[ "$GATE_NODE_SHA" = "$PIN_NODE_SHA" ] || die 'node-interpreter' "node interpreter hash mismatch: pinned $PIN_NODE_SHA ($PIN_MANIFEST), actual $GATE_NODE_SHA ($GATE_NODE): a node that is not the pinned build silently refuses vl root claims and turns the gate into environmental reds" 3
NODE_VERSION=$("$GATE_NODE" --version 2>/dev/null) || die 'node-interpreter' "cannot execute $GATE_NODE --version" 3
NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%[!0-9]*}
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die 'node-version' "unparseable version reported by $GATE_NODE: ${NODE_VERSION:-<empty>}" 3 ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || die 'node-version' "node major $NODE_MAJOR is below the gate floor of 22: $GATE_NODE ($NODE_VERSION)" 3

# Regular, executable files. A directory or a dangling symlink must stop the
# gate here, not inside a test.
for bin in "$NEW_BIN" "$OLD_BIN" "$STATUS_BIN" "$CLIENT_BIN"; do
  [ -f "$bin" ] || die 'binary-path' "not a regular file: $bin" 3
  [ -x "$bin" ] || die 'binary-path' "not executable: $bin" 3
done

# --- 2. full SHA256 for the new and the old binary --------------------------

NEW_SHA=$(sha_of "$NEW_BIN")
NEW_WANT=$(printf '%s' "$NC_VL_REAL_BIN_SHA256" | tr 'A-F' 'a-f' | tr -d '[:space:]')
[ "${#NEW_WANT}" -eq 64 ] || die 'hash' 'NC_VL_REAL_BIN_SHA256 is not a full 64-hex SHA256' 4
[ "$NEW_SHA" = "$NEW_WANT" ] || die 'hash' "new binary hash mismatch: declared $NEW_WANT, actual $NEW_SHA" 4

OLD_SHA=$(sha_of "$OLD_BIN")
OLD_WANT=$(printf '%s' "${NC_VL_OLD_REAL_BIN_SHA256:-}" | tr 'A-F' 'a-f' | tr -d '[:space:]')
if [ -z "$OLD_WANT" ] && [ -f "${OLD_BIN}.sha256" ]; then
  OLD_WANT=$(awk 'NR==1 {print $1}' "${OLD_BIN}.sha256" | tr 'A-F' 'a-f')
fi
[ -n "$OLD_WANT" ] || die 'hash' "no expected SHA256 for the old binary: set NC_VL_OLD_REAL_BIN_SHA256 or provide ${OLD_BIN}.sha256" 4
[ "${#OLD_WANT}" -eq 64 ] || die 'hash' 'the old binary expectation is not a full 64-hex SHA256' 4
[ "$OLD_SHA" = "$OLD_WANT" ] || die 'hash' "old binary hash mismatch: declared $OLD_WANT, actual $OLD_SHA" 4

STATUS_SHA=$(sha_of "$STATUS_BIN")
CLIENT_SHA=$(sha_of "$CLIENT_BIN")
# The status-contract and client binaries may legitimately be the same
# qualified artifact as the new one; if a path is the same file, its recorded
# hash must agree with the verified one.
[ "$STATUS_BIN" != "$NEW_BIN" ] || [ "$STATUS_SHA" = "$NEW_SHA" ] || die 'hash' 'status binary is the new binary path with a different hash' 4
[ "$CLIENT_BIN" != "$NEW_BIN" ] || [ "$CLIENT_SHA" = "$NEW_SHA" ] || die 'hash' 'client binary is the new binary path with a different hash' 4

# --- 3. capability preflight: no skip is an answer here ----------------------

PROBE=$(mktemp -d /tmp/ncgate-probe-XXXXXX)
mkdir -p "$PROBE/home/.config" "$PROBE/home/.state" "$PROBE/home/.data" "$PROBE/home/.run" "$PROBE/tmp"
probe_env() {
  env -i PATH=/usr/bin:/bin HOME="$PROBE/home" \
    XDG_CONFIG_HOME="$PROBE/home/.config" XDG_STATE_HOME="$PROBE/home/.state" \
    XDG_DATA_HOME="$PROBE/home/.data" XDG_RUNTIME_DIR="$PROBE/home/.run" \
    TMPDIR="$PROBE/tmp" "$@"
}
CLIENT_STATUS=$(probe_env "$CLIENT_BIN" status 2>/dev/null || true)
printf '%s\n' "$CLIENT_STATUS" | grep -Eq '"model_selector"[[:space:]]*:[[:space:]]*"profile"' \
  || die 'capability' "$CLIENT_BIN does not declare capabilities.model_selector = \"profile\": the profile inventory tests would skip, and a skip is not a pass" 5
rm -rf "$PROBE"

# --- 4. provenance manifest ---------------------------------------------------

LOG=${NEXUSCREW_GATE_LOG_DIR:-}
if [ -z "$LOG" ]; then LOG=$(mktemp -d /tmp/ncgate-XXXXXX); KEEP_LOG_DIR=0; else KEEP_LOG_DIR=1; mkdir -p "$LOG"; fi
# The run root lives only as long as the suite does; a refusal path must not
# leave one behind (the log dir, instead, is evidence and stays).
ROOT=""
TMPD=""
TMUXD=""
cleanup_root() { [ -n "$ROOT" ] && rm -rf "$ROOT"; [ -n "$TMPD" ] && rm -rf "$TMPD"; [ -n "$TMUXD" ] && rm -rf "$TMUXD"; return 0; }
trap cleanup_root EXIT

# GATE_NODE and NODE_VERSION were validated in section 1 (regular executable
# file, major >= 22, SHA256 bound to the claim pin manifest) before anything
# started; the manifest records them so a run is always attributable to its
# interpreter.
NC_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
NC_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
NC_DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

bin_version() { probe_dir=$(mktemp -d /tmp/ncgate-ver-XXXX); mkdir -p "$probe_dir"; timeout 10 env -i PATH=/usr/bin:/bin HOME="$probe_dir" TMPDIR="$probe_dir" "$1" --version 2>/dev/null | head -n 1; rm -rf "$probe_dir"; }

{
  printf 'gate started: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'gate command line: %s\n' "$0 $*"
  printf 'client capability document:\n%s\n' "$CLIENT_STATUS"
  printf 'nexuscrew commit: %s (%s, %s uncommitted path(s))\n' "$NC_COMMIT" "$NC_BRANCH" "$NC_DIRTY"
  printf 'node: %s (%s)\n  sha256: %s\n  pinned sha256: %s (%s)\n' "$GATE_NODE" "$NODE_VERSION" "$GATE_NODE_SHA" "$PIN_NODE_SHA" "$PIN_MANIFEST"
  printf 'cap: systemd-run --user --scope MemoryMax=2G MemorySwapMax=0 TasksMax=300\n'
  for pair in "new:$NEW_BIN:$NEW_SHA" "old:$OLD_BIN:$OLD_SHA" "status:$STATUS_BIN:$STATUS_SHA" "client:$CLIENT_BIN:$CLIENT_SHA"; do
    role=${pair%%:*}; rest=${pair#*:}; p=${rest%%:*}; s=${rest#*:}
    printf '%s binary: %s\n  sha256: %s\n  realpath: %s\n  version: %s\n' "$role" "$p" "$s" "$(readlink -f "$p")" "$(bin_version "$p")"
  done
} > "$LOG/manifest.txt"

# --- 5. the suite, capped and isolated ----------------------------------------

MANDATORY=$(mktemp)
ALLOWED_SKIP=$(mktemp)
cat > "$MANDATORY" <<'EOF'
VL vero: il binario e quello dichiarato e conosce lo stop
VL vero: status → internal host-stop → status none, con la sessione intatta
VL vero: la capacita non autorizza, senza isolamento l'host vivo non si tocca
VL vero: il binario è quello dichiarato e dichiara le capacità peer/stop
VL vero vecchio senza capacità peer/stop — up RIFIUTATO prima dello spawn, zero effetti
VL vero: il diagnostico punta a un ALTRO processo vivo — tuple del vero host, decoy mai toccato
VL vero: host SOSTITUITO prima della prima qualifica — si registra B, non A
VL vero: host SOSTITUITO fra osservazione e stop — il CLI rifiuta peer_mismatch, zero stop su B
VL vero: PID riusato o nascita diversa — expected con starttime diverso, il CLI rifiuta e l'host vive
VL vero: positivo up/down/up — una consegna del prompt per up, respawn zero, seconda tuple registrata
contratto: lo status reale espone i campi che la qualifica legge (host assente)
the real inventory is accepted: A and P apart, keys by state, the odd model counted out
the preflight decides on the real inventory: id, unique model, ambiguity, unknown, preset
a config that declares no profile: the real fallback lists only presets, so nothing is offered and no preset is accepted
binario reale: presente e probe --version risponde (altrimenti skip)
real probe: resolve con vlBinary reale usa il REALPATH per probe E spawn; nessun seam
real gate prompt: la versione REALE decide -> VL_SYSTEM_APPEND_FILE composta e file scritto
real profile: catalogo copiato 0600, -p <nome>, provider/base/model neutralizzati
real isolation: due celle stesso engine -> trii XDG, prompt e cataloghi distinti
real effort gate: il verdetto segue la versione REALE del binario
real same-binary: probe e spawn puntano lo stesso realpath (nessun ripiego PATH)
due celle, stesso engine e stessa HOME: due host reali distinti, preferenze distinte, transcript che riprende, nuova sessione che non tocca B
EOF
# The only skips this gate tolerates: a name AND the marker its reason must
# carry. A skipped test is tolerated only when both match: a tolerated name
# skipped for any other reason (a broken environment, a changed message) is an
# unexpected skip and fails the gate. The third column is the human rationale
# for the manifest.
cat > "$ALLOWED_SKIP" <<'EOF'
D10: ogni modello usato da una cella o da un default engine e' dichiarato per il suo engine	nessuna configurazione live	live configuration check: the gate runs against an empty private home and deliberately imports no real fleet configuration
il profilo generato e accettato dal client codex-vl vero (errore atteso: auth, non parse)	binario codex-vl non presente sul nodo	local codex-vl client binary is not a fact of the product: the node has none under the gate home, and the gate must not install one to turn a skip green
D2 end-to-end: Pi custom — Pi VERO carica l'estensione e il modello supera il consumo reale (read.js)	Pi (@earendil-works/pi-coding-agent) non installato	local Pi client is not a fact of the product: the test itself declares this skip legitimate and motivated when Pi is not installed, and a missing local client is never a red of the candidate
EOF

shopt -s nullglob
FILES=(tests/fleet-*.test.js)
[ "${#FILES[@]}" -gt 0 ] || die 'environment' 'no tests/fleet-*.test.js found' 3
CONCURRENCY=${NEXUSCREW_TEST_CONCURRENCY:-2}

# Re-check mode: NEXUSCREW_GATE_VERIFY_ONLY=<tap> replays the name verdict on
# an existing TAP file. It exists to make the refusal modes demonstrable
# without a full suite run, and it can NEVER produce the exit 0 of a real
# gate: a verdict with no problems still exits 6 with an explicit note.
VERIFY_TAP=${NEXUSCREW_GATE_VERIFY_ONLY:-}

if [ -n "$VERIFY_TAP" ]; then
  [ -f "$VERIFY_TAP" ] || die 'verify-only' "no such TAP file: $VERIFY_TAP" 6
  RUN_RC=0
  note "verify-only: replaying the name verdict on $VERIFY_TAP (this mode never passes the gate)"
else
RUN_RC_LABEL=recorded-below
ROOT=$(mktemp -d /tmp/ncgate-run-XXXXXX)
mkdir -p "$ROOT/home/.config" "$ROOT/home/.state" "$ROOT/home/.data" "$ROOT/home/.run"
# TMPDIR and TMUX_TMPDIR stay private but SHORT and top-level: many suite
# worlds mkdtemp under os.tmpdir() and end in a unix socket path, where the
# kernel caps the whole pathname at SUN_PATH_MAX. Nesting the private TMPDIR
# under the run root added enough characters to refuse vl roots for a hundred
# tests that are green with a flat /tmp base. A short top-level directory
# keeps the isolation without inheriting the depth.
TMPD=$(mktemp -d /tmp/ncg-t-XXXXXX)
TMUXD=$(mktemp -d /tmp/ncg-m-XXXXXX)
NODE_CMD=$(printf '%q ' systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 -p TasksMax=300 \
  env -i PATH=/usr/bin:/bin HOME="$ROOT/home" \
  XDG_CONFIG_HOME="$ROOT/home/.config" XDG_STATE_HOME="$ROOT/home/.state" \
  XDG_DATA_HOME="$ROOT/home/.data" XDG_RUNTIME_DIR="$ROOT/home/.run" \
  TMPDIR="$TMPD" TMUX_TMPDIR="$TMUXD" NEXUSCREW_AUTO_UPDATE=0 \
  NC_VL_REAL_BIN="$NEW_BIN" NC_VL_REAL_BIN_SHA256="$NEW_SHA" NC_VL_OLD_REAL_BIN="$OLD_BIN" \
  NC_VL_STATUS_BIN="$STATUS_BIN" NEXUSCREW_VL_REAL_BIN="$CLIENT_BIN" \
  "$GATE_NODE" --test "--test-concurrency=$CONCURRENCY" \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap "--test-reporter-destination=$LOG/gate.tap" "${FILES[@]}")
printf 'suite command line: %s\n' "$NODE_CMD" >> "$LOG/manifest.txt"
printf 'suite files: %s\n' "${#FILES[@]}" >> "$LOG/manifest.txt"

note "running ${#FILES[@]} fleet files under the cap (artifacts in $LOG)"
# The launcher itself needs the real user bus to reach systemd --user; the
# suite environment inside the scope is the private one above.
XDG_RUNTIME_DIR="/run/user/$(id -u)" systemd-run --user --scope -q \
  -p MemoryMax=2G -p MemorySwapMax=0 -p TasksMax=300 \
  env -i PATH=/usr/bin:/bin HOME="$ROOT/home" \
  XDG_CONFIG_HOME="$ROOT/home/.config" XDG_STATE_HOME="$ROOT/home/.state" \
  XDG_DATA_HOME="$ROOT/home/.data" XDG_RUNTIME_DIR="$ROOT/home/.run" \
  TMPDIR="$TMPD" TMUX_TMPDIR="$TMUXD" NEXUSCREW_AUTO_UPDATE=0 \
  NC_VL_REAL_BIN="$NEW_BIN" NC_VL_REAL_BIN_SHA256="$NEW_SHA" NC_VL_OLD_REAL_BIN="$OLD_BIN" \
  NC_VL_STATUS_BIN="$STATUS_BIN" NEXUSCREW_VL_REAL_BIN="$CLIENT_BIN" \
  "$GATE_NODE" --test "--test-concurrency=$CONCURRENCY" \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap "--test-reporter-destination=$LOG/gate.tap" \
  "${FILES[@]}" > "$LOG/stdout.log" 2>&1
RUN_RC=$?
printf 'suite exit: %s\n' "$RUN_RC" >> "$LOG/manifest.txt"

# --- 6. leftovers: nothing of this run may outlive it -------------------------

LEFTOVER=$(mktemp)
for proc in /proc/[0-9]*; do
  pid=${proc#/proc/}
  [ "$pid" != "$$" ] || continue
  cwd=$(readlink "$proc/cwd" 2>/dev/null || true)
  case "$cwd" in
    "$ROOT"|"$ROOT"/*|"$TMPD"|"$TMPD"/*|"$TMUXD"|"$TMUXD"/*) printf '%s cwd %s\n' "$pid" "$cwd" >> "$LEFTOVER"; continue ;;
  esac
  { env_match=$(tr '\0' '\n' < "$proc/environ" 2>/dev/null | grep -E "^(HOME|TMUX_TMPDIR|XDG_RUNTIME_DIR)=($ROOT|$TMPD|$TMUXD)" | head -n 1); } 2>/dev/null
  [ -z "${env_match:-}" ] || printf '%s environ %s\n' "$pid" "$env_match" >> "$LEFTOVER"
done 2>/dev/null
if [ -s "$LEFTOVER" ]; then
  note "processes from this gate run are still alive; terminating by exact pid:"
  while IFS=' ' read -r pid kind what; do
    printf '  pid %s (%s %s)\n' "$pid" "$kind" "$what" >&2
    kill -TERM "$pid" 2>/dev/null || true
  done < "$LEFTOVER"
  sleep 2
  while IFS=' ' read -r pid kind what; do
    kill -KILL "$pid" 2>/dev/null || true
  done < "$LEFTOVER"
  die 'leftovers' 'the suite left processes behind (see above); a candidate cannot ship with orphans' 9
fi
fi

# --- 7. verdict, by name --------------------------------------------------------

TAP_SOURCE=${VERIFY_TAP:-$LOG/gate.tap}
[ -f "$TAP_SOURCE" ] || die 'suite' "no TAP output at $TAP_SOURCE (suite exit ${RUN_RC:-none})" 6
[ "${VERIFY_TAP:-}" != "" ] || [ "$RUN_RC" -eq 0 ] || note "suite runner exited $RUN_RC; the name check below still reports what ran"

# Top-level result lines only: nested subtests are indented. Name is the text
# after " - " up to a " # " directive. A skipped test is an "ok" line with a
# SKIP directive; a "not ok" line is a failure whatever directive it carries,
# because a cancelled or todo test is not a pass either.
awk '
  /^(not )?ok[[:space:]]+[0-9]+[[:space:]]+-/ {
    line = $0
    sub(/^(not )?ok[[:space:]]+[0-9]+[[:space:]]+-/, "", line)
    sub(/^[[:space:]]+/, "", line)
    status = ($0 ~ /^ok/) ? "pass" : "fail"
    directive = ""
    if (match(line, /[[:space:]]#[[:space:]].*$/)) {
      directive = substr(line, RSTART + 3)
      line = substr(line, 1, RSTART - 1)
      if (status == "pass" && directive ~ /^(SKIP|skip|TODO|todo)/) status = "skip"
    }
    printf "%s\t%s\t%s\n", status, line, directive
  }
' "$TAP_SOURCE" > "$LOG/results.tsv"

FAILED=0
MISSING=0
SKIPPED=0
while IFS= read -r want; do
  [ -n "$want" ] || continue
  verdict=$(awk -F'\t' -v n="$want" '$2 == n { print $1; exit }' "$LOG/results.tsv")
  case "$verdict" in
    pass) ;;
    fail) printf 'release-gate: mandatory test FAILED: %s\n' "$want" >&2; FAILED=1 ;;
    skip) printf 'release-gate: mandatory test SKIPPED (a skip is not a pass): %s\n' "$want" >&2; SKIPPED=1 ;;
    *)    printf 'release-gate: mandatory test NOT EXECUTED (deleted or renamed?): %s\n' "$want" >&2; MISSING=1 ;;
  esac
done < "$MANDATORY"

UNEXPECTED=0
awk -F'\t' '$1 == "skip" { print $2 "\t" $3 }' "$LOG/results.tsv" | while IFS=$'\t' read -r skipped reason; do
  [ -n "$skipped" ] || continue
  if awk -F'\t' -v n="$skipped" -v r="$reason" '$1 == n && index(r, $2) > 0 { found = 1; exit } END { exit !found }' "$ALLOWED_SKIP"; then
    continue
  fi
  if awk -F'\t' -v n="$skipped" '$1 == n { found = 1; exit } END { exit !found }' "$ALLOWED_SKIP"; then
    printf 'release-gate: UNEXPECTED skip reason: %s\n  tolerated name, but the reason does not carry its marker: %s\n' "$skipped" "${reason:-<none>}" >&2
  else
    printf 'release-gate: UNEXPECTED skip: %s\n' "$skipped" >&2
  fi
  touch "$LOG/unexpected-skip.flag"
done
[ -e "$LOG/unexpected-skip.flag" ] && UNEXPECTED=1

TOTAL=$(wc -l < "$LOG/results.tsv" | tr -d ' ')
PASS_N=$(awk -F'\t' '$1 == "pass"' "$LOG/results.tsv" | wc -l | tr -d ' ')
FAIL_N=$(awk -F'\t' '$1 == "fail"' "$LOG/results.tsv" | wc -l | tr -d ' ')
SKIP_N=$(awk -F'\t' '$1 == "skip"' "$LOG/results.tsv" | wc -l | tr -d ' ')

# The manifest is written BEFORE the fatal exits on purpose (a red run must
# still leave its evidence), but the mandatory-list line reports the verdict
# it has actually computed — never a static "all passed" label on a red run.
MANDATORY_N=$(grep -c . "$MANDATORY" | tr -d ' ')
MANDATORY_OK=1
[ "$FAILED" -eq 0 ] && [ "$SKIPPED" -eq 0 ] && [ "$MISSING" -eq 0 ] || MANDATORY_OK=0
{
  printf 'suite results: %s total, %s pass, %s fail, %s skip\n' "$TOTAL" "$PASS_N" "$FAIL_N" "$SKIP_N"
  if [ "$MANDATORY_OK" = 1 ]; then
    printf 'mandatory list: %s names, all executed and passed\n' "$MANDATORY_N"
  else
    printf 'mandatory list: %s names, NOT all executed and passed (failed=%s skipped=%s missing=%s)\n' "$MANDATORY_N" "$FAILED" "$SKIPPED" "$MISSING"
  fi
  printf 'tolerated skips (by name, with the reason marker each must carry):\n'
  awk -F'\t' '{ printf "  - %s\n    marker: %s\n    %s\n", $1, $2, $3 }' "$ALLOWED_SKIP"
  printf 'gate finished: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} >> "$LOG/manifest.txt"

[ "$FAIL_N" -eq 0 ] && [ "${VERIFY_TAP:-}" != "" -o "$RUN_RC" -eq 0 ] || die 'suite' "the suite itself is not green (exit ${RUN_RC:-none}, $FAIL_N failing test(s))" 6
[ "$FAILED" -eq 0 ] || die 'mandatory' 'a mandatory real-binary test failed' 7
[ "$SKIPPED" -eq 0 ] || die 'mandatory' 'a mandatory real-binary test skipped' 7
[ "$MISSING" -eq 0 ] || die 'mandatory' 'a mandatory real-binary test is missing from the run' 7
[ "$UNEXPECTED" -eq 0 ] || die 'skips' 'the suite skipped a test that is not on the tolerated list' 8
[ -z "${VERIFY_TAP:-}" ] || die 'verify-only' 'verify-only replays the name verdict and never certifies a gate run' 6

rm -f "$MANDATORY" "$ALLOWED_SKIP" "$LEFTOVER"
ROOT=""
trap - EXIT
[ "$KEEP_LOG_DIR" = "1" ] || note "artifacts kept in $LOG"
printf 'release-gate: PASS — %s tests, %s pass, mandatory list complete, tolerated skips only (%s)\n' "$TOTAL" "$PASS_N" "$SKIP_N"
exit 0
