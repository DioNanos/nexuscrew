#!/bin/sh
# fake-fleet — simulatore per i test NexusCrew. Modalità via FAKE_FLEET_MODE:
#   ok (default) | invalid-json | wrong-kind | future-schema | slow | fail
case "${FAKE_FLEET_MODE:-ok}" in
  invalid-json)  echo 'not json at all'; exit 0 ;;
  wrong-kind)    echo '{"schemaVersion":1,"kind":"other","cells":[]}'; exit 0 ;;
  future-schema) echo '{"schemaVersion":99,"kind":"ai-fleet","cells":[]}'; exit 0 ;;
  missing-fields) echo '{"schemaVersion":1,"kind":"ai-fleet","cells":[{"cell":"Dev","tmuxSession":"cloud-Dev","engine":"glm","active":true,"boot":true,"tmux":true,"rc":"","key":"A"},{"cell":"Broken"}]}'; exit 0 ;;
  slow)          sleep 5; echo '{}'; exit 0 ;;
  fail)          echo 'boom: cella non valida' >&2; exit 2 ;;
esac
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
{"schemaVersion":1,"kind":"ai-fleet","cells":[
 {"cell":"Dev","tmuxSession":"cloud-Dev","engine":"glm","active":true,"boot":true,"tmux":true,"rc":"","key":"A"},
 {"cell":"Trading","tmuxSession":"cloud-Trading","engine":"native","active":false,"boot":false,"tmux":false,"rc":"RC_Trading","key":""},
 {"cell":"SysAdmin","tmuxSession":"cloud-SysAdmin","engine":"native","active":true,"boot":true,"tmux":false,"rc":"RC_SysAdmin","key":""}
]}
EOF
  exit 0
fi
# up/down/engine/boot: echo degli argomenti (i test verificano il passthrough)
echo "fake-fleet:$*"
