#!/bin/sh
# fake-tmux — logga le chiamate e simula gli esiti che servono ai test route.
echo "$*" >> "${FAKE_TMUX_LOG:-/dev/null}"
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
    fi
    exit 0 ;;
  capture-pane)
    if [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "pi-working" ]; then
      printf '\n⠙ Working...\npi-model footer\n'
    elif [ "${FAKE_TMUX_ACTIVITY_MODE:-}" = "quoted-working" ]; then
      printf '\n• Working (quoted in transcript)\nclaude-model footer\n'
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
