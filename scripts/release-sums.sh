#!/usr/bin/env bash
# Write a release's SHA256SUMS from the .sha256 files beside its downloads, and sign it with the
# release key when this run has it (docs/RELEASE-SIGNING.md).
#
#   bash scripts/release-sums.sh <folder of .sha256 files> <out>
#
# <out> gets SHA256SUMS, one line per download (a split file under its joined name); signed, also
# SHA256SUMS.sig, a detached OpenPGP signature, and herald-os-release-key.asc, the public keys.
#
#   RELEASE_SIGNING_KEY         the signing subkey, armored (gpg --export-secret-subkeys); unset, nothing
#                               is signed and that is not an error
#   RELEASE_SIGNING_PASSPHRASE  its passphrase
#   RELEASE_KEYS                the public keys installs check with (linux/keys/herald-os-release.asc)
#   RELEASE_FORK                true in a fork, where a missing key only warns
#
# Once RELEASE_KEYS is committed, tarball installs refuse unsigned releases, so a release without the
# key fails here rather than reaching them; the key must also be one of RELEASE_KEYS. GITHUB_OUTPUT, when
# set, gets signed=true or signed=false.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS="${RELEASE_KEYS:-$ROOT/linux/keys/herald-os-release.asc}"

[[ $# -eq 2 && -d "$1" ]] || { echo "usage: $0 <folder of .sha256 files> <out>" >&2; exit 2; }
sums_dir="$1" out="$2"
mkdir -p "$out"
rm -f "$out/SHA256SUMS" "$out/SHA256SUMS.sig" "$out/herald-os-release-key.asc"

output() { [[ -z "${GITHUB_OUTPUT:-}" ]] || echo "$1" >>"$GITHUB_OUTPUT"; }

# Each .sha256 is one sha256sum line for the file it is named after; anything else is refused, so a
# stray or edited file cannot slip a line in under another name.
lines=()
shopt -s nullglob
for file in "$sums_dir"/*.sha256; do
  name="$(basename "$file" .sha256)"
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "::error::release-sums: $(basename "$file") is not named after a release file"
    exit 1
  fi
  content="$(<"$file")"
  if [[ ! "$content" =~ ^([0-9a-f]{64})\ [\ *]([^[:space:]]+)$ || "${BASH_REMATCH[2]}" != "$name" ]]; then
    echo "::error::release-sums: $(basename "$file") is not one sha256sum line for $name"
    exit 1
  fi
  lines+=("${BASH_REMATCH[1]}  $name")
done
(( ${#lines[@]} )) || { echo "::error::release-sums: no .sha256 files in $sums_dir"; exit 1; }
printf '%s\n' "${lines[@]}" | LC_ALL=C sort -k 2 >"$out/SHA256SUMS"
echo "SHA256SUMS lists ${#lines[@]} files:"
cat "$out/SHA256SUMS"

if [[ -z "${RELEASE_SIGNING_KEY:-}" ]]; then
  output signed=false
  if [[ -f "$KEYS" && "${RELEASE_FORK:-false}" != true ]]; then
    echo "::error::RELEASE_SIGNING_KEY is not set, but $(basename "$KEYS") is committed: tarball installs would refuse this release. Set the secret (docs/RELEASE-SIGNING.md) and run the job again."
    exit 1
  fi
  if [[ -f "$KEYS" ]]; then
    echo "::warning::RELEASE_SIGNING_KEY is not set in this fork: SHA256SUMS is not signed, and installs with the release key will refuse this release."
  else
    echo "::notice::RELEASE_SIGNING_KEY is not set: SHA256SUMS is not signed. docs/RELEASE-SIGNING.md says how to turn signing on."
  fi
  exit 0
fi

# Under /tmp, not $TMPDIR: gpg-agent's socket path must stay short, and macOS's $TMPDIR is long.
work="$(mktemp -d /tmp/release-sums.XXXXXX)"
trap 'gpgconf --homedir "$work/sign" --kill all >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -m 700 "$work/sign" "$work/check"
gpg_sign() { gpg --batch --no-options --homedir "$work/sign" "$@"; }
gpg_check() { gpg --batch --no-options --no-autostart --homedir "$work/check" "$@"; }
primaries() { awk -F: '$1 == "pub" || $1 == "sec" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }'; }

gpg_sign --import <<<"$RELEASE_SIGNING_KEY" 2>/dev/null || { echo "::error::RELEASE_SIGNING_KEY is not an OpenPGP secret key"; exit 1; }
# Read in loops, not with mapfile, which bash 3.2 (macOS's) lacks.
signer=()
while IFS= read -r line; do
  signer+=("$line")
done < <(gpg_sign --with-colons --fixed-list-mode --list-secret-keys | primaries)
if (( ${#signer[@]} != 1 )); then
  echo "::error::RELEASE_SIGNING_KEY holds ${#signer[@]} keys; it must hold one release key (its signing subkey)"
  exit 1
fi
# An exported subkey leaves a stub for the primary key, marked # in field 15.
if gpg_sign --with-colons --fixed-list-mode --list-secret-keys | awk -F: '$1 == "sec" && $15 != "#" { found = 1 } END { exit !found }'; then
  echo "::warning::RELEASE_SIGNING_KEY holds the primary key's secret. Keep the primary key offline and store only the signing subkey (gpg --export-secret-subkeys), as docs/RELEASE-SIGNING.md says."
fi

if [[ -f "$KEYS" ]]; then
  gpg_check --import "$KEYS" 2>/dev/null || { echo "::error::$KEYS cannot be read"; exit 1; }
  trusted=()
  while IFS= read -r line; do
    trusted+=("$line")
  done < <(gpg_check --with-colons --fixed-list-mode --list-keys | primaries)
  # An empty array is "unbound" under set -u before bash 4.4, so it is never expanded as one.
  if (( ${#trusted[@]} == 0 )) || [[ ! " ${trusted[*]} " == *" ${signer[0]} "* ]]; then
    echo "::error::RELEASE_SIGNING_KEY belongs to ${signer[0]}, which is not in $(basename "$KEYS") (${trusted[*]:-no keys}): installs would refuse this signature."
    exit 1
  fi
  cp "$KEYS" "$out/herald-os-release-key.asc"
else
  gpg_sign --armor --export "${signer[0]}" >"$out/herald-os-release-key.asc"
  gpg_check --import "$out/herald-os-release-key.asc" 2>/dev/null
  echo "::notice::$(basename "$KEYS") is not committed: this release is signed, but installs do not check signatures yet (docs/RELEASE-SIGNING.md)."
fi

gpg_sign --pinentry-mode loopback --passphrase-fd 3 --local-user "${signer[0]}" \
  --detach-sign --output "$out/SHA256SUMS.sig" "$out/SHA256SUMS" 3<<<"${RELEASE_SIGNING_PASSPHRASE:-}" ||
  { echo "::error::gpg could not sign SHA256SUMS with RELEASE_SIGNING_KEY (is RELEASE_SIGNING_PASSPHRASE right, and the subkey unexpired?)"; exit 1; }

# The signature is checked the way installs check it: against the public keys alone.
status="$(gpg_check --status-fd 1 --verify "$out/SHA256SUMS.sig" "$out/SHA256SUMS" 2>/dev/null)" || true
if ! grep -q '^\[GNUPG:\] GOODSIG ' <<<"$status" ||
  ! grep -Eq "^\[GNUPG:\] VALIDSIG ([^ ]+ ){9}${signer[0]}\$" <<<"$status"; then
  echo "::error::the new SHA256SUMS.sig does not check out against the release keys"
  exit 1
fi
output signed=true
echo "SHA256SUMS is signed with the release key ${signer[0]}."
