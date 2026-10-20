# shellcheck shell=bash
# Sourced by the PKGBUILD's prepare(): checks the release's SHA256SUMS.sig as strictly as
# herald-os-tarball does. makepkg's own check (validpgpkeys) passes a signature by an expired key or
# subkey with only a warning; this refuses it (docs/RELEASE-SIGNING.md).
#
#   _herald_os_check_release <SHA256SUMS> <SHA256SUMS.sig> <the release's key file> <fingerprint>...
#
# It passes only when the signature file holds exactly one signature, gpg reports it good, and it was
# made by one of the fingerprints, neither that key nor the subkey revoked or expired. The key file
# comes from the release, so it is used only for those fingerprints' subkeys, revocations and expiry
# dates: a key outside them is never accepted, certified or not, since the PKGBUILD names the keys of
# its own version. makepkg runs prepare() with errexit and an ERR trap, so nothing here may fail
# outside a condition, and it runs in bash 3.2 as well (the tests run it on macOS).
_herald_os_check_release() {
  local sums="$1" sig="$2" offered="$3" home listing status packets signer fpr usable=""
  shift 3
  home="$(mktemp -d /tmp/herald-os-pkg-gpg.XXXXXX)" || return 1
  local gpg=(gpg --batch --no-options --no-autostart --no-auto-key-retrieve --homedir "$home")
  "${gpg[@]}" --import "$offered" >/dev/null 2>&1 || true
  # Each primary key's fingerprint and validity: r revoked, e expired, i invalid, d disabled.
  listing="$("${gpg[@]}" --with-colons --fixed-list-mode --list-keys 2>/dev/null |
    awk -F: '$1 == "pub" { v = $2; want = 1; next } $1 == "fpr" && want { print $10, v; want = 0 }')" || true
  for fpr in "$@"; do
    if grep -Eq "^$fpr [^reid]?\$" <<<"$listing"; then
      usable="$usable $fpr"
    fi
  done
  packets="$("${gpg[@]}" --list-packets "$sig" 2>/dev/null | grep -c '^:signature packet:')" || true
  status="$("${gpg[@]}" --status-fd 1 --verify "$sig" "$sums" 2>/dev/null)" || status="$status
[GNUPG:] HERALD_OS_FAILED"
  rm -rf "$home"
  signer="$(awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $NF }' <<<"$status")" || true
  local reason=""
  if [[ -z "$usable" ]]; then
    reason="none of the release keys ($*) is in the release's key file, neither revoked nor expired"
  elif [[ "$packets" != 1 || "$(grep -c '^\[GNUPG:\] NEWSIG' <<<"$status" || true)" != 1 ]]; then
    reason="it does not hold exactly one signature"
  elif grep -Eq '^\[GNUPG:\] (EXPKEYSIG|REVKEYSIG|EXPSIG)' <<<"$status"; then
    reason="it was made by a key or subkey that has expired or been revoked"
  elif grep -Eq '^\[GNUPG:\] (BADSIG|ERRSIG|HERALD_OS_FAILED)' <<<"$status" ||
    [[ "$(grep -c '^\[GNUPG:\] GOODSIG' <<<"$status" || true)" != 1 ]]; then
    reason="it does not check out"
  elif [[ -z "$signer" || " $usable " != *" $signer "* ]]; then
    reason="it was not made by one of the release keys ($*)"
  fi
  if [[ -n "$reason" ]]; then
    echo "herald-os-bin: refusing the release's SHA256SUMS.sig: $reason" >&2
    return 1
  fi
  return 0
}
