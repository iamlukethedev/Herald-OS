#!/usr/bin/env bash
# Turn bootc-image-builder's output folder into the files a release carries, in <dist>:
#
#   anaconda-iso (x86_64)  herald-os-<v>-x86_64.iso         the installer
#   qcow2 (both)           herald-os-<v>-<arch>.qcow2.zst   QEMU, virt-manager, GNOME Boxes, try.sh
#   qcow2 (x86_64)         herald-os-<v>-x86_64.vhdx.zip    Hyper-V on Windows
#   qcow2 (aarch64)        herald-os-<v>-aarch64.utm.zip    UTM on an Apple Silicon Mac
#
# Each gets a .sha256 of the whole file. GitHub refuses release files of 2 GiB or more, so a bigger
# one goes up in parts: the ISO and the qcow2.zst as .part0, .part1, … (what try.sh joins with cat),
# the zips as .001, .002, … which 7-Zip on Windows and Keka on macOS open as one archive. A split
# file also gets a .sha256sums with one line per part, so `sha256sum -c` checks the parts before
# they are joined. The builder's disk.qcow2 is deleted once converted, to leave the runner room.
# Runs on the image workflow's Linux runners (GNU coreutils, zip, zstd, qemu-img).
#
#   bash linux/vm/package-disk.sh output amd64 0.1.0 dist
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPLIT_AT="${SPLIT_AT:-2147483648}"
PART_SIZE="${PART_SIZE:-1900M}"

[[ $# -eq 4 ]] || { echo "usage: $0 <builder-output> <amd64|arm64> <version> <dist>" >&2; exit 2; }
out="$1" arch="$2" version="$3"
case "$arch" in
  amd64) name=x86_64 ;;
  arm64) name=aarch64 ;;
  *) echo "package-disk: unknown architecture $arch" >&2; exit 2 ;;
esac
# The version goes into file names, globs and checksum lines, so it stays one plain word.
if [[ ! "$version" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "package-disk: version '$version' may only use letters, digits, '.', '_' and '-'" >&2
  exit 2
fi
mkdir -p "$4"
dist="$(cd "$4" && pwd)"
base="herald-os-$version-$name"

# finish <file> <part|numbered>: checksum, report and, when too big for one release file, split.
finish() {
  local file="$1" size
  (cd "$dist" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
  size="$(stat -c %s "$file")"
  echo "$(basename "$file"): $((size / 1024 / 1024)) MiB"
  if (( size >= SPLIT_AT )); then
    if [[ "$2" == part ]]; then
      split -b "$PART_SIZE" -d -a 1 "$file" "$file.part"
    else
      split -b "$PART_SIZE" -d -a 3 --numeric-suffixes=1 "$file" "$file."
    fi
    rm "$file"
    local parts=()
    mapfile -t parts < <(cd "$dist" && find . -maxdepth 1 -name "$(basename "$file").*" \
      ! -name '*.sha256' ! -name '*.sha256sums' -printf '%f\n' | LC_ALL=C sort)
    (cd "$dist" && sha256sum "${parts[@]}" >"$(basename "$file").sha256sums")
  fi
}

if [[ -f "$out/bootiso/install.iso" ]]; then
  [[ "$name" == x86_64 ]] || { echo "package-disk: the installer ISO is x86_64 only" >&2; exit 1; }
  mv "$out/bootiso/install.iso" "$dist/$base.iso"
  finish "$dist/$base.iso" part
elif [[ -f "$out/qcow2/disk.qcow2" ]]; then
  disk="$out/qcow2/disk.qcow2"
  zstd -T0 -19 -q "$disk" -o "$dist/$base.qcow2.zst"
  finish "$dist/$base.qcow2.zst" part

  work="$(mktemp -d "$dist/.work.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  if [[ "$name" == x86_64 ]]; then
    # Hyper-V's generation 2 machines (UEFI) take VHDX only; dynamic keeps the unused space out.
    qemu-img convert -O vhdx -o subformat=dynamic "$disk" "$work/$base.vhdx"
    rm "$disk"
    zip -q -j "$dist/$base.vhdx.zip" "$work/$base.vhdx"
    rm "$work/$base.vhdx"
    finish "$dist/$base.vhdx.zip" numbered
  else
    # qcow2's own compression keeps the bundle small, so the zip only stores it.
    qemu-img convert -c -O qcow2 "$disk" "$work/herald-os.qcow2"
    rm "$disk"
    python3 "$HERE/make-utm.py" --version "$version" --move "$work/herald-os.qcow2" "$work" >/dev/null
    (cd "$work" && zip -q -0 -r "$dist/$base.utm.zip" "Herald OS.utm")
    rm -r "$work/Herald OS.utm"
    finish "$dist/$base.utm.zip" numbered
  fi
else
  echo "package-disk: no installer ISO or qcow2 in $out" >&2
  exit 1
fi
ls -l "$dist"
