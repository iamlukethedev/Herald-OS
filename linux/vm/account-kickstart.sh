#!/usr/bin/env bash
# The account %pre of linux/image/unattended.ks with ACCOUNT and SSH_KEYS filled in, and the %include
# its %post needs, to append to another kickstart: .github/workflows/installer-test.yml adds them to
# the ISO's own when it is asked to test an account and SSH keys.
#
#   bash linux/vm/account-kickstart.sh <account> <public-key-file> >>ks.cfg
set -euo pipefail

usage="usage: $0 <account> <public-key-file>"
account="${1:?$usage}"
keys="$(cat "${2:?$usage}")"
kickstart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/image/unattended.ks"

echo "%include /tmp/herald-os-account.ks"
inside=0 filled=0
while IFS= read -r line; do
  if (( !inside )) && [[ "$line" == "%pre "*"--log=/tmp/herald-os-account.log"* ]]; then
    inside=1
  fi
  (( inside )) || continue
  case "$line" in
    'ACCOUNT=""') printf 'ACCOUNT=%q\n' "$account"; filled=$((filled + 1)) ;;
    'SSH_KEYS=""') printf 'SSH_KEYS=%q\n' "$keys"; filled=$((filled + 1)) ;;
    *) printf '%s\n' "$line" ;;
  esac
  [[ "$line" != "%end" ]] || break
done <"$kickstart"
# The kickstart's settings were not where this looks for them: better no snippet than one that
# installs without the account it was asked for.
(( filled == 2 )) || { echo "$0: no ACCOUNT=\"\" and SSH_KEYS=\"\" in the account %pre of $kickstart" >&2; exit 1; }
