#!/bin/sh
# Simula capture-pane con output che cambia a ogni chiamata (contatore su file).
case "$*" in *"__fail__"*) echo "can't find pane" >&2; exit 1 ;; esac
C="/tmp/nc-fake-capture-count.$PPID"
n=$(cat "$C" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$C"
printf '\n\nline-%s\n' "$n"
