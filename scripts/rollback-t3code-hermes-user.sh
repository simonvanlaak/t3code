#!/bin/sh
set -eu

opt_dir="${T3CODE_HERMES_INSTALL_DIR:-$HOME/.local/opt/t3code-hermes}"
bin_dir="${T3CODE_HERMES_BIN_DIR:-$HOME/.local/bin}"
prefix="${XDG_DATA_HOME:-$HOME/.local/share}"

rm -rf "$opt_dir" "${opt_dir}.new"
if [ -e "${opt_dir}.previous" ]; then
  mv "${opt_dir}.previous" "$opt_dir"
  printf 'Restored previous T3 Code Hermes installation at %s\n' "$opt_dir"
else
  rm -f "$bin_dir/t3code-hermes" "$prefix/applications/t3code-hermes.desktop"
  for icon in "$prefix"/icons/hicolor/*/apps/t3code-hermes.png; do
    [ -e "$icon" ] && rm -f "$icon"
  done
  printf 'Removed T3 Code Hermes. Isolated state was retained at %s\n' \
    "${T3CODE_HERMES_HOME:-$HOME/.t3-hermes}"
fi
