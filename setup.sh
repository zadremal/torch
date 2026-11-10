#!/bin/sh
# torch installation (decision 9): dependencies, UI build, the `torch` command, `torch setup`.
# Package S1.
set -eu
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "torch: Bun is required — https://bun.sh" >&2
  exit 1
fi

bun install
bun run build

# `bun link` puts the `torch` command into Bun's global command directory.
bun link
bin="${BUN_INSTALL:-$HOME/.bun}/bin"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "torch: the command is in $bin — add this directory to PATH" >&2 ;;
esac

exec bun src/cli.ts setup
