#!/usr/bin/env bash
#
# GNOME Essentials installer
#
# - When run from a local source checkout, installs as a development symlink.
# - When run through curl | bash, clones or updates from GitHub.
#
set -e

UUID="gnome-essentials@ritesh"
REPO_URL="https://github.com/ritesh-777/gnome-essentials.git"
TARGET_PARENT="$HOME/.local/share/gnome-shell/extensions"
TARGET_DIR="$TARGET_PARENT/$UUID"

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" 2>/dev/null && pwd || pwd)"

has_local_checkout() {
    [ -f "$SCRIPT_DIR/metadata.json" ] &&
        [ -f "$SCRIPT_DIR/extension.js" ] &&
        [ -d "$SCRIPT_DIR/schemas" ]
}

compile_schemas() {
    local dir="$1"
    if [ -d "$dir/schemas" ]; then
        echo "Compiling settings schemas..."
        glib-compile-schemas "$dir/schemas/"
    fi
}

backup_existing_target() {
    if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
        local backup_dir="${TARGET_DIR}.backup.$(date +%Y%m%d%H%M%S)"
        echo "Existing extension directory found. Moving it to:"
        echo "  $backup_dir"
        mv "$TARGET_DIR" "$backup_dir"
    fi
}

install_from_checkout() {
    local local_dir="$SCRIPT_DIR"

    echo "=========================================="
    echo "Installing GNOME Essentials (Development Link)..."
    echo "=========================================="

    compile_schemas "$local_dir"
    mkdir -p "$TARGET_PARENT"

    local resolved_local
    local resolved_target=""
    resolved_local="$(readlink -f "$local_dir")"
    if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
        resolved_target="$(readlink -f "$TARGET_DIR" || true)"
    fi

    if [ -L "$TARGET_DIR" ]; then
        if [ "$resolved_local" = "$resolved_target" ]; then
            echo "Development symlink already points to this checkout."
            return
        fi
        echo "Removing existing development symlink..."
        rm "$TARGET_DIR"
    elif [ -e "$TARGET_DIR" ]; then
        if [ "$resolved_local" = "$resolved_target" ]; then
            echo "This checkout is already installed in the GNOME extensions folder."
            return
        fi
        backup_existing_target
    fi

    echo "Linking $local_dir to target..."
    ln -s "$local_dir" "$TARGET_DIR"

    echo "=========================================="
    echo "Success! GNOME Essentials is linked for development."
    echo "=========================================="
}

install_from_github() {
    echo "=========================================="
    echo "Installing GNOME Essentials from GitHub..."
    echo "=========================================="

    if ! command -v git >/dev/null 2>&1; then
        echo "Error: git is required for one-line installation." >&2
        exit 1
    fi

    mkdir -p "$TARGET_PARENT"

    if [ -L "$TARGET_DIR" ]; then
        local link_target
        link_target="$(readlink -f "$TARGET_DIR" || true)"
        if [ -n "$link_target" ] && [ -d "$link_target/.git" ]; then
            echo "Updating existing development symlink target..."
            git -C "$link_target" pull
            compile_schemas "$link_target"
        else
            echo "Replacing existing broken or non-git symlink..."
            rm "$TARGET_DIR"
            git clone "$REPO_URL" "$TARGET_DIR"
            compile_schemas "$TARGET_DIR"
        fi
    elif [ -d "$TARGET_DIR/.git" ]; then
        echo "Updating existing GitHub installation..."
        git -C "$TARGET_DIR" pull
        compile_schemas "$TARGET_DIR"
    elif [ -e "$TARGET_DIR" ]; then
        backup_existing_target
        echo "Cloning repository to local extensions folder..."
        git clone "$REPO_URL" "$TARGET_DIR"
        compile_schemas "$TARGET_DIR"
    else
        echo "Cloning repository to local extensions folder..."
        git clone "$REPO_URL" "$TARGET_DIR"
        compile_schemas "$TARGET_DIR"
    fi

    echo "=========================================="
    echo "Success! GNOME Essentials is installed."
    echo "=========================================="
}

if has_local_checkout; then
    install_from_checkout
else
    install_from_github
fi

echo ""
echo "Next steps:"
echo "1. Restart GNOME Shell."
echo "   - X11: press Alt+F2, type r, and press Enter."
echo "   - Wayland: log out and log back in."
echo "2. Enable the extension:"
echo "   gnome-extensions enable $UUID"
echo "   Or use the graphical Extensions manager app."
echo ""
