#!/bin/sh
# fake-tmux — logga le chiamate e simula gli esiti che servono ai test route.
LOG="${FAKE_TMUX_LOG:-${XDG_STATE_HOME:+$XDG_STATE_HOME/tmux.log}}"
echo "$*" >> "${LOG:-/dev/null}"
# Canale di controllo: tmux -S <socket> -C. Le righe su stdin sono comandi,
# le risposte sono incorniciate. Lo stato (sessione gia' fermata) sta nella
# directory del socket, cosi' il processo del canale e i comandi rieseguiti
# vedono la stessa sessione senza env extra.
if [ "$1" = "-S" ] && [ "$3" = "-C" ]; then
  printf '%s\n' '%begin 1 0 1' 'nc-control-open' '%end 1 0 1'
  sock="$2"
  state=$(dirname "$sock")
  n=0
  errf="${TMPDIR:-/tmp}/ncfakecc.$$"
  while IFS= read -r riga; do
    n=$((n + 1))
    [ -z "$riga" ] && continue
    [ "$riga" = "display-message -p nc-control-open" ] && continue
    out=$("$0" -S "$sock" $riga 2>"$errf")
    rc=$?
    printf '%%begin 1 %s 1\n' "$n"
    [ -n "$out" ] && printf '%s\n' "$out"
    if [ "$rc" = "0" ]; then printf '%%end 1 %s 1\n' "$n"
    else cat "$errf" 2>/dev/null; printf '%%error 1 %s 1\n' "$n"; fi
  done
  rm -f "$errf"
  rm -rf "$state"
  exit 0
fi
state=""
if [ "$1" = "-S" ]; then
  state=$(dirname "$2")
  shift 2
fi
case "$1" in
  new-session)
    # il runtime passa -P -F '#{session_id}\t#{window_id}\t#{pane_id}': stampa i 3 ID
    if echo "$*" | grep -q ' -P '; then printf '%s\t%s\t%s\n' '$1' '@1' '%42'; fi
    exit 0 ;;
  display-message)
    # readiness (pane vivo di default): dead=0, pane=%42.
    # Il lancio chiede anche il socket del server: un path nuovo per chiamata,
    # cosi' due test non condividono lo stato del canale.
    case "$*" in
      *socket_path*)
        d=$(mktemp -d /tmp/nc-fake-tmux.XXXXXX) || exit 1
        printf '%s/socket\t4242\n' "$d"
        ;;
      *pane_dead*) printf '0\t\t%%42\n' ;;
    esac
    exit 0 ;;
  kill-session)
    case "$*" in *"=ghost"*) echo "can't find session ghost" >&2; exit 1 ;; esac
    if [ -n "$state" ]; then : > "$state/killed"; fi
    exit 0 ;;
  has-session)
    case "$*" in *"=ghost"*) exit 1 ;; esac
    if [ -n "$state" ] && [ -f "$state/killed" ]; then
      for a in "$@"; do
        if [ "$a" = '$1' ]; then exit 1; fi
      done
    fi
    exit 0 ;;
  list-sessions)
    if [ -n "${FAKE_TMUX_SESSIONS_STATE:-}" ]; then
      # Stato commutabile a runtime (test di coalescing/freschezza): la cella
      # si chiama come lo stato, cosi' il corpo della risposta lo porta.
      printf "cell-${FAKE_TMUX_SESSIONS_STATE}\t0\t1\t1718380800\t1751990000\tnode\t\t${FAKE_TMUX_SESSIONS_STATE}\n"
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
      printf 'pi-cell\t0\t1\t1718380800\t1751990000\tnode\t\tπ - project\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "quoted-working" ]; then
      printf 'claude-idle\t0\t1\t1718380800\t1751990000\tnode\t\tDev\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "dead-supervisor" ]; then
      # La sessione del supervisore ucciso: resta viva per remain-on-exit.
      printf 'claude-dead\t0\t1\t1718380800\t1751990000\tnode\t\tDev\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "unmarked" ]; then
      printf 'claude-unmarked\t0\t1\t1718380800\t1751990000\tnode\t\tDev\n'
    fi
    exit 0 ;;
  list-panes)
    # Il formato "fleet snapshot" (arg con session_created) porta in UNA riga
    # i campi del supervisore E quelli della sessione: 13 campi — sessione,
    # pane, pane_dead, marcatore, attached, windows, created, activity, cmd,
    # visibility, window_active, pane_active, titolo. `dead-supervisor` tiene
    # la forma misurata: pane marcato morto NON attivo + seconda finestra
    # attiva (la riga sessione deve venire da QUEST'ultima).
    case "$*" in
      *session_created*)
        if [ -n "${FAKE_TMUX_SESSIONS_STATE:-}" ]; then
          printf "cell-${FAKE_TMUX_SESSIONS_STATE}\t%%1\t0\t\t0\t1\t1718380800\t1751990000\tnode\t\t1\t1\t${FAKE_TMUX_SESSIONS_STATE}\n"
        elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "dead-supervisor" ]; then
          printf 'claude-dead\t%%1\t1\t1\t0\t1\t1718380800\t1751990000\tnode\t\t0\t0\tKilled supervisor\n'
          printf 'claude-dead\t%%2\t0\t\t0\t1\t1718380800\t1751990000\tnode\t\t1\t1\tDev\n'
        elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "unmarked" ]; then
          printf 'claude-unmarked\t%%1\t0\t\t0\t1\t1718380800\t1751990000\tnode\t\t1\t1\tDev\n'
        elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "quoted-working" ]; then
          printf 'claude-idle\t%%1\t0\t1\t0\t1\t1718380800\t1751990000\tnode\t\t1\t1\tDev\n'
        elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
          printf 'pi-cell\t%%1\t0\t\t0\t1\t1718380800\t1751990000\tnode\t\t1\t1\tπ - project\n'
        fi
        exit 0 ;;
    esac
    # UNA chiamata per giro. Quattro campi: sessione, pane, pane_dead, marcatore
    # del supervisore. `dead-supervisor` e' il caso misurato con tmux vero: il
    # pane del supervisore e' morto ma c'e' una SECONDA FINESTRA VIVA — se si
    # guardasse il pane attivo della sessione, la cella sembrerebbe viva.
    if [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "dead-supervisor" ]; then
      printf 'claude-dead\t%%1\t1\t1\nclaude-dead\t%%2\t0\t\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "unmarked" ]; then
      printf 'claude-unmarked\t%%1\t0\t\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "quoted-working" ]; then
      printf 'claude-idle\t%%1\t0\t1\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
      printf 'pi-cell\t%%1\t0\t\n'
    fi
    exit 0 ;;
  capture-pane)
    if [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
      printf '\n⠙ Working...\npi-model footer\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "quoted-working" ]; then
      printf '\n• Working (quoted in transcript)\nclaude-model footer\n'
    fi
    exit 0 ;;
  set-option|set-hook)
    # Il test del best-effort PWA usa una sessione esplicitamente dedicata:
    # i due comandi falliscono, ma new-session deve comunque restare riuscita.
    case "$*" in *web-best-effort*) echo "alternate-screen unavailable" >&2; exit 1 ;; esac
    exit 0 ;;
  *) exit 0 ;;
esac
