#!/usr/bin/env bash
# Start the minicom monitoring service in the background.
#
#   ./start_server.sh                             port 8006
#   ./start_server.sh --port 8007
#   ./start_server.sh --capture /tmp/cobo.cap     follow a capture file
#   ./start_server.sh --port-device /dev/ttyUSB1  read the port directly
#
# Any option is passed straight through to backend/run.py.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidfile="$here/.minicom_monitoring.pid"
logfile="$here/minicom_monitoring.server.log"

if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "Already running as PID $(cat "$pidfile"). Stop it with ./stop_server.sh first." >&2
  exit 1
fi

if [[ ! -d "$here/frontend/dist" ]]; then
  echo "The UI is not built. Run: cd frontend && npm install && npm run build" >&2
  exit 1
fi

cd "$here/backend"
nohup python3 run.py "$@" >>"$logfile" 2>&1 &
echo $! >"$pidfile"

# run.py prints the URL to open as soon as it has worked out which addresses
# this host answers on; give it a moment so the operator sees it here.
sleep 2
tail -n 12 "$logfile"
echo
echo "PID $(cat "$pidfile") · log: $logfile"
