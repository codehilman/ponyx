#!/usr/bin/env bash
# Links the extension into the user's GNOME Shell extensions folder and compiles its settings schema.
set -euo pipefail

UUID="ponyx@codehilman"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "$DEST exists and is not a symlink; move it aside first." >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"

echo "Installed $UUID."
echo "On Wayland, log out and back in once so GNOME Shell sees the new extension, then run:"
echo "  gnome-extensions enable $UUID"
