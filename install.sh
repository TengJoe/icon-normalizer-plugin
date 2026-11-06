#!/usr/bin/env bash
# Icon Normalizer — backend installer.
#
# The extension itself installs the standard GNOME way (extensions.gnome.org or
# "gnome-extensions install"). This script installs the companion backend and
# the systemd user units, and brings the extension to the same release.
#
# Local mode:  run from a checkout or an extracted release tarball.
# Remote mode: run anywhere; downloads the latest release, verifies the
#              published SHA-256 and installs from a temporary directory.
#
# Nothing runs as root: the backend, the extension and the systemd user units
# all live under your home directory.
#
# Usage:
#   ./install.sh                 install or upgrade the latest release
#   ./install.sh v1.2.0          install a specific release
#   ./install.sh --check         verify prerequisites only
#   ./install.sh --uninstall     remove the extension and the backend
#   ./install.sh --help

set -euo pipefail

REPO="TengJoe/icon-normalizer-plugin"
FALLBACK_VERSION="1.2.0"
API="https://api.github.com/repos/${REPO}/releases/latest"
DL="https://github.com/${REPO}/releases/download"

info() { printf "  %s\n" "$*"; }
fail() { printf "\n  error: %s\n" "$*" >&2; exit 1; }

usage() {
    if [ -r "$0" ] && [ -f "$0" ]; then
        sed -n "2,20p" "$0" | sed "s/^# \{0,1\}//"
    else
        # Piped through curl: $0 is the interpreter, not this file.
        printf '%s\n' \
            "Icon Normalizer — backend installer." \
            "" \
            "  ./install.sh                 install or upgrade the latest release" \
            "  ./install.sh v1.2.0          install a specific release" \
            "  ./install.sh --check         verify prerequisites only" \
            "  ./install.sh --uninstall     remove the extension and the backend" \
            "" \
            "Nothing runs as root."
    fi
    exit 0
}

case "${1:-}" in
    -h|--help) usage ;;
esac

# ------------------------------------------------------------- prerequisites
missing=()
command -v python3 >/dev/null 2>&1 || missing+=("python3")

if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' || missing+=("python3-pil / python3-numpy / python3-gi / gir1.2-gtk-3.0")
import importlib, sys
for mod in ("PIL", "numpy"):
    try:
        importlib.import_module(mod)
    except Exception:
        sys.exit(1)
try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk  # noqa: F401
except Exception:
    sys.exit(1)
PY
fi

command -v gtk-update-icon-cache >/dev/null 2>&1 || missing+=("gtk-update-icon-cache (libgtk-3-bin)")
command -v systemctl >/dev/null 2>&1 || missing+=("systemd")

if [ "${#missing[@]}" -gt 0 ]; then
    printf "\n  Missing prerequisites:\n"
    for item in "${missing[@]}"; do printf "    - %s\n" "$item"; done
    printf "\n  On Debian/Ubuntu:\n"
    printf "    sudo apt install python3-pil python3-numpy python3-gi gir1.2-gtk-3.0 libgtk-3-bin\n\n"
    exit 1
fi
info "prerequisites: ok"

if [ "${1:-}" = "--check" ]; then
    info "check only; nothing was installed"
    exit 0
fi

# ------------------------------------------------------------------ local mode
if [ -f "tools/install.py" ] && [ -d "backend" ] && [ -d "extension" ]; then
    info "local checkout detected; running tools/install.py"
    exec python3 tools/install.py "$@"
fi

# ----------------------------------------------------------------- remote mode
command -v curl >/dev/null 2>&1 || fail "curl is required to download the release"

# A version-looking argument selects the release; everything else is forwarded
# to tools/install.py (--uninstall, --keep-backend, --assume-yes).
tag=""
passthrough=()
for arg in "$@"; do
    if [ -z "$tag" ] && printf "%s" "$arg" | grep -qE "^v?[0-9]+\.[0-9]+\.[0-9]+$"; then
        tag="$arg"
    else
        passthrough+=("$arg")
    fi
done

if [ -z "$tag" ]; then
    info "looking up the latest release"
    tag=$(curl -fsSL --max-time 20 "$API" 2>/dev/null \
        | python3 -c "import json,sys;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || true)
    [ -n "$tag" ] || tag="v${FALLBACK_VERSION}"
fi
version="${tag#v}"
info "release: $tag"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

tarball="icon-normalizer-plugin-${version}.tar.gz"
info "downloading $tarball"
# GitHub occasionally drops a connection mid-transfer; retry before giving up.
curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --max-time 300 \
    -o "$workdir/$tarball" "$DL/$tag/$tarball" \
    || fail "download failed: $DL/$tag/$tarball"
curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --max-time 60 \
    -o "$workdir/SHA256SUMS" "$DL/$tag/SHA256SUMS" \
    || fail "could not download SHA256SUMS"

info "verifying checksum"
( cd "$workdir" && grep " $tarball\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1 ) \
    || fail "checksum mismatch for $tarball; refusing to install"

info "extracting"
tar -xzf "$workdir/$tarball" -C "$workdir"
cd "$workdir/icon-normalizer-plugin"

info "installing"
if [ "${#passthrough[@]}" -gt 0 ]; then
    python3 tools/install.py "${passthrough[@]}"
else
    python3 tools/install.py
fi