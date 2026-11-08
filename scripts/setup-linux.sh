#!/usr/bin/env bash
# setup-linux.sh — (Re-)install the system packages Helix needs on Linux.
#
# Hatch containers are replaced regularly and apt packages do NOT survive a
# replacement, so re-run this script on a fresh container before building:
#   bash ~/workspace/helix/scripts/setup-linux.sh
#
# Rust (rustup, ~/.cargo/bin) and Node live outside apt and survive; only the
# system libraries below need reinstalling. After this script:
#   npm ci            # (only needed if node_modules is gone)
#   npm run build:linux
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "setup-linux.sh needs root (apt). Re-run as root or via sudo." >&2
  exit 1
fi

# apt-get update is very slow on the Hatch egress proxy mirrors; existing
# package lists are usually usable, so only refresh if explicitly asked.
if [ "${APT_UPDATE:-0}" = "1" ]; then
  apt-get update
fi

# libzstd-dev (pulled in by librsvg2-dev's chain) can conflict with the
# Hatch-pinned libzstd1 (+hatch1). Downgrade it first if present.
if dpkg -l libzstd1 2>/dev/null | grep -q 'hatch1'; then
  apt-get install -y --allow-downgrades 'libzstd1=1.5.5+dfsg2-2build1.1' || true
fi

apt-get install -y \
  build-essential pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  zenity \
  xvfb ffmpeg xdg-utils xdotool x11-utils \
  openbox dbus-x11 \
  xdg-desktop-portal xdg-desktop-portal-gtk

echo "setup-linux.sh: done. Verify with: dpkg -l libwebkit2gtk-4.1-dev libgtk-3-dev | grep ^ii"
