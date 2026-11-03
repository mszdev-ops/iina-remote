#!/bin/zsh
# IINA Remote launcher – double-click it in Finder to start the server.
# Runs in a Terminal window; stop it with Ctrl+C or by closing the window.

cd "$(dirname "$0")" || exit 1

# Find Node: PATH first, then the usual Homebrew locations.
NODE="$(command -v node)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -z "$NODE" && -x "$candidate" ]] && NODE="$candidate"
done
if [[ -z "$NODE" ]]; then
  echo "Node.js not found. Install it with: brew install node"
  read -k 1 "?Press any key to close…"
  exit 1
fi

# Optional settings (PORT, TOKEN, SOCKET_PATH, …) from config.env.
if [[ -f config.env ]]; then
  set -a
  source ./config.env
  set +a
fi

PORT="${PORT:-8080}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use – the server is probably running already (e.g. via launchd)."
  echo "To stop it: launchctl bootout gui/\$(id -u)/local.iina-remote"
  read -k 1 "?Press any key to close…"
  exit 1
fi

echo "Starting IINA Remote ($("$NODE" --version))…  Stop with Ctrl+C"
echo
"$NODE" server.js
exit_code=$?

echo
echo "The server stopped (exit code: $exit_code)."
read -k 1 "?Press any key to close…"
