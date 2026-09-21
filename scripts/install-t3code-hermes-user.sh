#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/T3-Code-*.AppImage" >&2
  exit 2
fi

appimage=$(realpath "$1")
[ -x "$appimage" ] || chmod +x "$appimage"

prefix="${XDG_DATA_HOME:-$HOME/.local/share}"
opt_dir="${T3CODE_HERMES_INSTALL_DIR:-$HOME/.local/opt/t3code-hermes}"
bin_dir="${T3CODE_HERMES_BIN_DIR:-$HOME/.local/bin}"
applications_dir="$prefix/applications"
icons_dir="$prefix/icons/hicolor"
staging=$(mktemp -d "${TMPDIR:-$HOME/.cache}/t3code-hermes-install-XXXXXX")
trap 'rm -rf "$staging"' EXIT

(
  cd "$staging"
  "$appimage" --appimage-extract >/dev/null
)
[ -x "$staging/squashfs-root/AppRun" ]
[ -f "$staging/squashfs-root/chrome-sandbox" ]

next="${opt_dir}.new"
rm -rf "$next"
mkdir -p "$(dirname "$opt_dir")"
cp -a "$staging/squashfs-root" "$next"
chmod 4755 "$next/chrome-sandbox" 2>/dev/null || chmod 0755 "$next/chrome-sandbox"
if [ -e "$opt_dir" ]; then
  rm -rf "${opt_dir}.previous"
  mv "$opt_dir" "${opt_dir}.previous"
fi
mv "$next" "$opt_dir"

mkdir -p "$bin_dir" "$applications_dir"
cat >"$bin_dir/t3code-hermes" <<EOF
#!/bin/sh
export T3CODE_HOME="\${T3CODE_HERMES_HOME:-\$HOME/.t3-hermes}"
export T3CODE_PORT="\${T3CODE_HERMES_PORT:-3774}"
export T3CODE_DISABLE_AUTO_UPDATE=true
export XDG_CONFIG_HOME="\${T3CODE_HERMES_CONFIG_HOME:-\$HOME/.config/t3code-hermes}"
unset APPIMAGE APPDIR
exec "$opt_dir/AppRun" "\$@"
EOF
chmod 0755 "$bin_dir/t3code-hermes"

cat >"$applications_dir/t3code-hermes.desktop" <<EOF
[Desktop Entry]
Name=T3 Code Hermes
Comment=Private Hermes-enabled T3 Code distribution
Exec=$bin_dir/t3code-hermes %U
TryExec=$bin_dir/t3code-hermes
Terminal=false
Type=Application
Icon=t3code-hermes
StartupWMClass=t3code
MimeType=x-scheme-handler/t3code;
Categories=Development;
EOF

for icon in "$opt_dir"/usr/share/icons/hicolor/*/apps/t3code.png; do
  [ -e "$icon" ] || continue
  size=${icon%/apps/t3code.png}
  size=${size##*/}
  mkdir -p "$icons_dir/$size/apps"
  cp "$icon" "$icons_dir/$size/apps/t3code-hermes.png"
done

printf 'Installed T3 Code Hermes to %s\n' "$opt_dir"
printf 'Launcher: %s/t3code-hermes\n' "$bin_dir"
printf 'State: %s\n' "${T3CODE_HERMES_HOME:-$HOME/.t3-hermes}"
printf 'Port: %s\n' "${T3CODE_HERMES_PORT:-3774}"
