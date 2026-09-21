#!/bin/sh
set -eu

source_root=${T3CODE_HERMES_HELPER_SOURCE:-/usr/lib/t3code/resources}
target=x86_64-unknown-linux-gnu

copy_helper() {
  source=$1
  destination=$2
  [ -x "$source" ] || {
    echo "missing executable helper: $source" >&2
    exit 1
  }
  mkdir -p "$(dirname "$destination")"
  cp "$source" "$destination"
  chmod 0755 "$destination"
}

copy_helper \
  "$source_root/resource-monitor/t3-resource-monitor" \
  "native/resource-monitor/target/$target/release/t3-resource-monitor"
copy_helper \
  "$source_root/hyprland-capture/t3-hyprland-snap-shot" \
  "native/hyprland-snap-shot/target/$target/release/t3-hyprland-snap-shot"
copy_helper \
  "$source_root/kde-capture/t3-kde-snap-shot" \
  "native/kde-snap-shot/target/$target/release/t3-kde-snap-shot"

printf 'Seeded Linux helper binaries from %s\n' "$source_root"
