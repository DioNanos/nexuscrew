#!/usr/bin/env bash
# fleet — gestore UNICO della flotta AI VPS3 (modello per-cella, 2026-07-07).
#
# Ogni cella = una sessione Claude Code indipendente e persistente, via unit
# templata systemd `cloud-cell@<Cella>.service` (tmux cloud-<Cella>).
# UN comando decide: cella + engine + persistenza al boot.
#
#   fleet up <Cell> [--engine native|glm|glm-a|glm-p|ollama|ollama-cloud|codex-vl] [--boot]
#                      avvia ora la cella (+ setta engine); --boot = persistente al reboot
#                      (cella Codex: engine default codex-vl = Senior Auditor)
#   fleet down <Cell> [--boot]
#                      ferma ora la cella; --boot = toglie anche la persistenza al boot
#   fleet boot <Cell>          rende persistente al boot (enable, senza avviare)
#   fleet noboot <Cell>        toglie la persistenza al boot (disable, lascia viva la sessione)
#   fleet engine <Cell> <eng>  cambia engine (riavvia la cella se attiva)
#   fleet status               tabella: cella | engine | active | boot | tmux | remote-control
#   fleet default              boot-set canonico: SysAdmin + Personal, native, persistenti
#
# Vincolo: --remote-control funziona SOLO con engine=native (gated per glm/ollama).
# Naming RC per cella: da ai-fleet-lib.sh cell_rc() (Cloud_Personal, Cloud_Sys_Admin,
# Cloud_Dev_Senior, Cloud_Trading, Cloud_Fork_Manager).  Key Z.AI: A=SysAdmin/Dev/Fork, P=Personal/Trading.
set -u

BIN="${AIFLEET_BIN_DIR:-$HOME/.local/bin}"
. "$BIN/ai-fleet-lib.sh"
aifleet_init
mkdir -p "$AIFLEET_CELLS_STATE_DIR" 2>/dev/null || true

unit_of() { echo "cloud-cell@$1.service"; }
sess_of() { echo "cloud-$1"; }

valid_engine() {
  case "$1" in native|glm|glm-a|glm-p|ollama|ollama-cloud|codex-vl) return 0 ;; *) return 1 ;; esac
}

warn_rc() {
  # $1=cella $2=engine — avvisa se l'engine non supporta remote-control
  [ "$2" = native ] || echo "  ⚠ engine=$2: NIENTE remote-control (gated). Pilota via: tmux attach -t $(sess_of "$1")"
}

resolve_cell() {
  local c; c="$(cell_norm "$1")"
  cell_valid "$c" || { echo "fleet: cella non valida '$1' (usa: $AIFLEET_CELLS)" >&2; return 2; }
  echo "$c"
}

cmd_up() {
  local cell engine="" boot=0
  cell="$(resolve_cell "$1")" || exit 2; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --engine) engine="$2"; shift 2 ;;
      --engine=*) engine="${1#*=}"; shift ;;
      --boot) boot=1; shift ;;
      *) echo "fleet up: argomento sconosciuto '$1'" >&2; exit 2 ;;
    esac
  done
  # engine: esplicito, oppure quello già salvato, oppure native
  [ -z "$engine" ] && engine="$(cell_engine "$cell")"
  valid_engine "$engine" || { echo "fleet: engine non valido '$engine'" >&2; exit 2; }
  cell_engine_set "$cell" "$engine"

  if [ "$boot" -eq 1 ]; then
    systemctl --user enable "$(unit_of "$cell")" >/dev/null 2>&1
    echo "[fleet] $cell: persistenza al boot ABILITATA"
  fi
  # restart = down-before-up (ExecStop kill-session + ExecStart new-session): evita
  # collisione RC e sessioni tmux duplicate, idempotente anche se non attiva.
  systemctl --user restart "$(unit_of "$cell")" \
    && echo "[fleet] $cell: UP (engine=$engine, tmux=$(sess_of "$cell"), rc=$(cell_rc "$cell"))" \
    || { echo "[fleet] $cell: UP FALLITO" >&2; exit 1; }
  warn_rc "$cell" "$engine"
}

cmd_down() {
  local cell boot=0
  cell="$(resolve_cell "$1")" || exit 2; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --boot) boot=1; shift ;;
      *) echo "fleet down: argomento sconosciuto '$1'" >&2; exit 2 ;;
    esac
  done
  systemctl --user stop "$(unit_of "$cell")" >/dev/null 2>&1
  echo "[fleet] $cell: DOWN (sessione fermata)"
  if [ "$boot" -eq 1 ]; then
    systemctl --user disable "$(unit_of "$cell")" >/dev/null 2>&1
    echo "[fleet] $cell: persistenza al boot RIMOSSA"
  fi
}

cmd_boot()   { local c; c="$(resolve_cell "$1")" || exit 2; systemctl --user enable "$(unit_of "$c")" >/dev/null 2>&1 && echo "[fleet] $c: boot ABILITATO (non avviata ora)"; }
cmd_noboot() { local c; c="$(resolve_cell "$1")" || exit 2; systemctl --user disable "$(unit_of "$c")" >/dev/null 2>&1 && echo "[fleet] $c: boot DISABILITATO (sessione lasciata com'è)"; }

cmd_engine() {
  local cell engine
  cell="$(resolve_cell "$1")" || exit 2
  engine="${2:?uso: fleet engine <Cell> <native|glm|glm-a|glm-p|ollama|ollama-cloud|codex-vl>}"
  valid_engine "$engine" || { echo "fleet: engine non valido '$engine'" >&2; exit 2; }
  cell_engine_set "$cell" "$engine"
  echo "[fleet] $cell: engine = $engine"
  if [ "$(systemctl --user is-active "$(unit_of "$cell")" 2>/dev/null)" = active ]; then
    systemctl --user restart "$(unit_of "$cell")" && echo "[fleet] $cell: riavviata con engine=$engine"
  else
    echo "         (vale al prossimo up)"
  fi
  warn_rc "$cell" "$engine"
}

cmd_status() {
  printf '%-10s %-8s %-9s %-8s %-7s %-18s %s\n' CELLA ENGINE ACTIVE BOOT TMUX REMOTE-CONTROL KEY
  printf '%-10s %-8s %-9s %-8s %-7s %-18s %s\n' ------ ------ ------ ---- ---- -------------- ---
  for cell in $AIFLEET_CELLS; do
    local u eng ac en tm rc key
    u="$(unit_of "$cell")"
    eng="$(cell_engine "$cell")"
    ac="$(systemctl --user is-active "$u" 2>/dev/null)"; ac="${ac:-inactive}"
    en="$(systemctl --user is-enabled "$u" 2>/dev/null)"; en="${en:-disabled}"
    if /usr/bin/tmux has-session -t "$(sess_of "$cell")" 2>/dev/null; then tm=alive; else tm="-"; fi
    if [ "$eng" = native ]; then rc="$(cell_rc "$cell")"; else rc="(no RC)"; fi
    # KEY veritiera: vale solo per engine GLM (altrimenti '-')
    case "$eng" in
      glm)   key="$(cell_glm_key "$cell")" ;;
      glm-a) key=A ;;
      glm-p) key=P ;;
      *)     key="-" ;;
    esac
    printf '%-10s %-8s %-9s %-8s %-7s %-18s %s\n' "$cell" "$eng" "$ac" "$en" "$tm" "$rc" "$key"
  done
  echo
  echo "Sessioni tmux cloud-*:"
  /usr/bin/tmux ls 2>/dev/null | grep '^cloud-' | sed 's/^/  /' || echo "  (nessuna)"
}

cmd_status_json() {
  # Output machine-readable per NexusCrew (contratto v1: kind ai-fleet).
  printf '{"schemaVersion":1,"kind":"ai-fleet","cells":['
  local first=1 cell u eng ac en tm ab eb rc key
  for cell in $AIFLEET_CELLS; do
    u="$(unit_of "$cell")"; eng="$(cell_engine "$cell")"
    ac="$(systemctl --user is-active "$u" 2>/dev/null)"
    en="$(systemctl --user is-enabled "$u" 2>/dev/null)"
    if /usr/bin/tmux has-session -t "=$(sess_of "$cell")" 2>/dev/null; then tm=true; else tm=false; fi
    [ "$ac" = active ] && ab=true || ab=false
    [ "$en" = enabled ] && eb=true || eb=false
    if [ "$eng" = native ]; then rc="$(cell_rc "$cell")"; else rc=""; fi
    case "$eng" in
      glm)   key="$(cell_glm_key "$cell")" ;;
      glm-a) key=A ;;
      glm-p) key=P ;;
      *)     key="" ;;
    esac
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"cell":"%s","tmuxSession":"%s","engine":"%s","active":%s,"boot":%s,"tmux":%s,"rc":"%s","key":"%s"}' \
      "$cell" "$(sess_of "$cell")" "$eng" "$ab" "$eb" "$tm" "$rc" "$key"
  done
  printf ']}\n'
}

cmd_default() {
  echo "[fleet] Boot-set canonico: SysAdmin + Personal, native, persistenti al boot."
  cmd_up SysAdmin --engine native --boot
  cmd_up Personal --engine native --boot
}

usage() { sed -n '2,26p' "$0"; }

case "${1:-status}" in
  up)      shift; cmd_up "$@" ;;
  down)    shift; cmd_down "$@" ;;
  boot)    shift; cmd_boot "$@" ;;
  noboot)  shift; cmd_noboot "$@" ;;
  engine)  shift; cmd_engine "$@" ;;
  status)
    case "${2:-}" in
      --json) cmd_status_json ;;
      "")     cmd_status ;;
      *) echo "fleet status: argomento sconosciuto '$2'" >&2; exit 2 ;;
    esac ;;
  default) cmd_default ;;
  -h|--help|help) usage ;;
  *) echo "fleet: comando sconosciuto '$1'" >&2; usage; exit 1 ;;
esac
