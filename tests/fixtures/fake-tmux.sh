#!/bin/sh
# fake-tmux — logga le chiamate e simula gli esiti che servono ai test route.
echo "$*" >> "${FAKE_TMUX_LOG:-/dev/null}"
case "$1" in
  new-session)  exit 0 ;;
  kill-session)
    case "$*" in *"=ghost"*) echo "can't find session ghost" >&2; exit 1 ;; esac
    exit 0 ;;
  has-session)
    case "$*" in *"=ghost"*) exit 1 ;; esac
    exit 0 ;;
  list-sessions) exit 0 ;;
  *) exit 0 ;;
esac
