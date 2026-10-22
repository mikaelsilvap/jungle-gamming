#!/usr/bin/env bash
set -euo pipefail

required_bun_version="1.4.3"

install_dir="${BUN_INSTALL:-${HOME}/.bun}"
if [[ -x "$install_dir/bin/bun" ]]; then
  bun_path="$install_dir/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  bun_path="$(command -v bun)"
else
  mkdir -p "$install_dir/bin"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$install_dir" bash -s "bun-v${required_bun_version}"
  bun_path="$install_dir/bin/bun"
  export PATH="$install_dir/bin:$PATH"
fi

actual_bun_version="$("$bun_path" --version)"
if [[ "$actual_bun_version" != "$required_bun_version" ]]; then
  printf 'Bun %s is required; found %s at %s\n' \
    "$required_bun_version" "$actual_bun_version" "$bun_path" >&2
  exit 1
fi

"$bun_path" install --frozen-lockfile
"$bun_path" run typecheck
"$bun_path" run build
