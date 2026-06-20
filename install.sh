#!/bin/sh
set -e
# Installer for signal-k-tack-and-gybe
REPO="https://github.com/theseal666/signal-k-tack-and-gybe.git"
TMPDIR="/tmp/signal-k-tack-and-gybe-tmp"
TARGET_USER="node"
TARGET_HOME=$(eval echo "~$TARGET_USER")
TARGET_DIR="$TARGET_HOME/.signalk/node_modules/signal-k-tack-and-gybe"

if [ "$1" = "--yes" ] || [ "$1" = "-y" ]; then
  NONINTERACTIVE=1
else
  NONINTERACTIVE=0
fi

echo "This script will clone the repo, install dependencies, copy the plugin to:"
echo "  $TARGET_DIR"
echo "You will need: git, node and npm installed, and restart rights for Signal K."
echo "Installer will set ownership to user: $TARGET_USER"

echo "Note: this installer will run 'npm install --production' in the temporary clone and again in the installed target folder as the Signal K user to ensure dependencies (eg. axios) are available with correct ownership."

if [ "$NONINTERACTIVE" -ne 1 ]; then
  read -p "Continue? [y/N] " yn
  case "$yn" in
    [Yy]* ) ;;
    * ) echo "Aborted."; exit 1;;
  esac
fi

# Clone fresh into /tmp
rm -rf "$TMPDIR"
if ! git clone "$REPO" "$TMPDIR"; then
  echo "Failed to clone repo. Check network and git."; exit 2
fi

# Install deps in the temp folder (best-effort)
cd "$TMPDIR"
if ! npm install --production; then
  echo "npm install in temp folder failed. Will continue and try installing in target. Check node/npm versions and network.";
fi

# Ensure target dir exists
mkdir -p "$(dirname "$TARGET_DIR")"

# Remove any existing plugin folder and copy plugin into Signal K user folder
rm -rf "$TARGET_DIR"
cp -r "$TMPDIR" "$TARGET_DIR"

# Fix ownership to the Signal K user before attempting target install
if id "$TARGET_USER" >/dev/null 2>&1; then
  chown -R "$TARGET_USER":"$TARGET_USER" "$TARGET_DIR" 2>/dev/null || true
else
  echo "Warning: user $TARGET_USER does not exist on this system; ownership not changed."
fi

# Run npm install in the target folder as the Signal K user to ensure dependencies (axios) are installed with correct ownership
if id "$TARGET_USER" >/dev/null 2>&1; then
  echo "Running npm install in $TARGET_DIR as $TARGET_USER..."
  if ! sudo -u "$TARGET_USER" bash -lc "cd '$TARGET_DIR' && npm install --production"; then
    echo "npm install in target failed. Please inspect $TARGET_DIR and run 'npm install --production' as $TARGET_USER manually.";
  fi
fi

# Ensure final ownership
if id "$TARGET_USER" >/dev/null 2>&1; then
  chown -R "$TARGET_USER":"$TARGET_USER" "$TARGET_DIR" 2>/dev/null || true
fi

echo "Plugin copied to $TARGET_DIR"

# Try to restart Signal K (best-effort)
if command -v systemctl >/dev/null 2>&1; then
  echo "Restarting Signal K via systemctl..."
  sudo systemctl restart signalk || echo "systemctl restart failed — please restart Signal K manually"
else
  echo "systemctl not found — please restart Signal K manually (e.g., sudo service signalk restart)"
fi

echo "Install complete. Open Signal K admin UI and enable the plugin."
