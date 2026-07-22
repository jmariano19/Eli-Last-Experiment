#!/bin/bash
# Double-click to launch the Eli editor on macOS.

# Finder-launched scripts receive a limited PATH. Include the standard Node
# locations used by Intel and Apple Silicon Macs before starting the editor.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo
  echo "The editor needs Node.js, but Node.js was not found on this Mac."
  echo "Install Node.js, then double-click Start Editor.command again."
  echo
  read -r -p "Press Return to close..."
  exit 1
fi

exec npm start
