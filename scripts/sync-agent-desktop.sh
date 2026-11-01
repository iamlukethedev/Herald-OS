#!/usr/bin/env bash
# Re-sync desktop control's vendored copy of agent-desktop (third_party/agent-desktop) to another
# upstream revision: fetch it, copy the Linux parts, re-apply the manifest patches, let Cargo trim
# the lock to the trimmed workspace, regenerate patches/, re-vendor the crates and prove the build
# works offline with an empty CARGO_HOME. Needs curl, git, cargo and the network (the build it ends
# with does not use the network).
#
#   bash scripts/sync-agent-desktop.sh <sha>
#
# Then read the diff, bring PATCHES.md up to date, and commit the source and vendor/ separately.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/third_party/agent-desktop"
LOCK="$DEST/UPSTREAM.lock"
# What is carried from upstream (PATCHES.md, "Carried unchanged"), and the files the patches change.
CARRIED=(crates/core crates/linux src skills tests/fixtures LICENSE rust-toolchain.toml Cargo.toml Cargo.lock)
MANIFEST_PATCHES=(0001-workspace-linux-members:Cargo.toml 0002-cli-linux-dependencies:src/Cargo.toml)
LOCK_PATCH=0003-lock-without-other-platforms

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <sha>   (the full 40-character upstream commit)" >&2
  exit 2
fi
repo="$(sed -n 's/^repo=//p' "$LOCK" | tr -d '[:space:]')"
old_sha="$(sed -n 's/^sha=//p' "$LOCK" | tr -d '[:space:]')"
[[ "$repo" == https://github.com/* ]] || { echo "sync-agent-desktop: UPSTREAM.lock must name a GitHub repo=" >&2; exit 1; }
for tool in curl git cargo; do
  command -v "$tool" >/dev/null || { echo "sync-agent-desktop: needs $tool" >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
upstream="$tmp/upstream"
stage="$tmp/stage"
mkdir -p "$upstream" "$stage"

echo "sync-agent-desktop: fetching $repo@$sha"
curl -fsSL --retry 6 --retry-delay 20 --retry-all-errors "$repo/archive/$sha.tar.gz" -o "$tmp/upstream.tar.gz"
tar -xzf "$tmp/upstream.tar.gz" -C "$upstream" --strip-components=1

for path in "${CARRIED[@]}"; do
  [[ -e "$upstream/$path" ]] || { echo "sync-agent-desktop: upstream has no $path any more; update CARRIED and PATCHES.md" >&2; exit 1; }
  (cd "$upstream" && cp -R --parents "$path" "$stage/")
done

echo "sync-agent-desktop: re-applying the manifest patches"
for entry in "${MANIFEST_PATCHES[@]}"; do
  if ! (cd "$stage" && git apply "$DEST/patches/${entry%%:*}.patch") 2>"$tmp/apply.log"; then
    cat "$tmp/apply.log" >&2
    echo "sync-agent-desktop: patches/${entry%%:*}.patch no longer applies to ${entry##*:}; trim it by hand in $DEST, then re-run" >&2
    exit 1
  fi
done

echo "sync-agent-desktop: trimming Cargo.lock to the Linux workspace"
# Cargo drops what only the removed members used and keeps every other version as upstream pinned it.
# From inside the tree, so rustup picks the toolchain its rust-toolchain.toml names.
(cd "$stage" && CARGO_HOME="$tmp/cargo-home" cargo metadata --format-version 1 >/dev/null)

echo "sync-agent-desktop: regenerating patches/"
patch_for() {
  local name="$1" file="$2"
  (cd "$tmp" && git diff --no-index --no-color --no-ext-diff --abbrev=8 --src-prefix=a/ --dst-prefix=b/ "upstream/$file" "stage/$file") \
    | sed -e "s#a/upstream/#a/#g" -e "s#b/stage/#b/#g" >"$DEST/patches/$name.patch" || true
}
for entry in "${MANIFEST_PATCHES[@]}"; do
  patch_for "${entry%%:*}" "${entry##*:}"
done
patch_for "$LOCK_PATCH" Cargo.lock

for path in "${CARRIED[@]}"; do
  rm -rf "${DEST:?}/$path"
  (cd "$stage" && cp -R --parents "$path" "$DEST/")
done
sed -i "s/^sha=.*/sha=$sha/" "$LOCK"
if [[ "$old_sha" != "$sha" ]]; then
  sed -i "s/$old_sha/$sha/g" "$DEST/NOTICE" "$DEST/PATCHES.md"
fi
lock_sum="$(sha256sum "$DEST/Cargo.lock" | cut -d' ' -f1)"
sed -i -E "s/sha256 \`[0-9a-f]{64}\`/sha256 \`$lock_sum\`/" "$DEST/PATCHES.md"

echo "sync-agent-desktop: re-vendoring"
rm -rf "$DEST/vendor"
(cd "$DEST" && CARGO_HOME="$tmp/cargo-home" cargo vendor --quiet --locked vendor >/dev/null)
large="$(find "$DEST/vendor" -type f -size +100M)"
[[ -z "$large" ]] || { echo "sync-agent-desktop: files over 100 MB in vendor/:" >&2; echo "$large" >&2; exit 1; }

echo "sync-agent-desktop: building offline with an empty CARGO_HOME"
mkdir -p "$tmp/empty-cargo-home"
(cd "$DEST" && CARGO_HOME="$tmp/empty-cargo-home" cargo build --release --frozen --offline --target-dir "$tmp/target")

tree_sum="$(cd "$DEST/vendor" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)"
echo "sync-agent-desktop: done -> $DEST at $sha"
echo "  Cargo.lock sha256: $lock_sum"
echo "  vendor/ tree (LC_ALL=C sort): $tree_sum ($(find "$DEST/vendor" -mindepth 1 -maxdepth 1 -type d | wc -l) crates)"
echo "  Next: read the diff, update PATCHES.md, run cargo test, and commit the source and vendor/ separately."
