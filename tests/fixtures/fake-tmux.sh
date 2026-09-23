#!/bin/sh
# fake-tmux — logga le chiamate e simula gli esiti che servono ai test route.
LOG="${FAKE_TMUX_LOG:-${XDG_STATE_HOME:+$XDG_STATE_HOME/tmux.log}}"
echo "$*" >> "${LOG:-/dev/null}"
case "$1" in
  new-session)
    # il runtime passa -P -F '#{session_id}\t#{window_id}\t#{pane_id}': stampa i 3 ID
    if echo "$*" | grep -q ' -P '; then printf '%s\t%s\t%s\n' '$1' '@1' '%42'; fi
    exit 0 ;;
  display-message)
    # readiness (pane vivo di default): dead=0, pane=%42
    case "$*" in *pane_dead*) printf '0\t\t%%42\n' ;; esac
    exit 0 ;;
  kill-session)
    case "$*" in *"=ghost"*) echo "can't find session ghost" >&2; exit 1 ;; esac
    exit 0 ;;
  has-session)
    case "$*" in *"=ghost"*) exit 1 ;; esac
    exit 0 ;;
  list-sessions)
    if [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
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
