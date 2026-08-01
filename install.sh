#!/usr/bin/env bash
# paper-dive installer.
#
#   curl -fsSL https://raw.githubusercontent.com/pierrelux/paper-dive/main/install.sh | bash
#
# Clones (or updates) the app under ~/.local/share/paper-dive, installs its
# dependencies into a virtualenv, builds paper-dive.app into ~/Applications,
# and opens it. Ask for the API key happens inside the app on first run.
#
#   --uninstall   remove the app and the checkout

set -euo pipefail

REPO_URL="${PAPER_DIVE_REPO:-https://github.com/pierrelux/paper-dive.git}"
SRC="${PAPER_DIVE_HOME:-$HOME/.local/share/paper-dive}"
APP="$HOME/Applications/paper-dive.app"

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$APP" "$SRC" "$HOME/Library/Logs/paper-dive.log"
  say "Removed the app and $SRC."
  say "Your API key lived in $SRC/.env and went with it."
  exit 0
fi

[ "$(uname -s)" = "Darwin" ] || die "This installer builds a macOS app. On Linux or Windows,
clone the repo and run:  uv venv && uv pip install -e . && python -m server.app"

command -v git >/dev/null 2>&1 || die "git is required. Install it with: xcode-select --install"

if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (the Python package manager)"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || die "uv installed but is not on PATH. Open a new shell and retry."

if [ -d "$SRC/.git" ]; then
  say "Updating $SRC"
  git -C "$SRC" fetch --quiet origin
  git -C "$SRC" reset --hard --quiet origin/main
else
  say "Downloading paper-dive to $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --quiet --depth 1 "$REPO_URL" "$SRC"
fi

cd "$SRC"

say "Installing dependencies (this can take a minute the first time)"
uv venv --quiet
uv pip install --quiet -e ".[desktop]"

say "Building paper-dive.app"
./scripts/make_app.sh >/dev/null

say "Installed. Opening it now — it will ask for an Anthropic API key."
echo
echo "  Keep it around:  right-click the Dock icon > Options > Keep in Dock"
echo "  Update:          re-run this installer"
echo "  Remove:          $SRC/install.sh --uninstall"
echo

open "$APP"
