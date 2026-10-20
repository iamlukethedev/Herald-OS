# Signing release files

Every release can carry a `SHA256SUMS` that lists the installer ISO, the VM disks, the Linux tarballs
and the Mac downloads, with `SHA256SUMS.sig` beside it: a detached OpenPGP signature made by the
release workflows with the Herald OS release key. `herald-os update` on a tarball install checks that
signature before it trusts any checksum, the Arch package checks it in `makepkg`, and anyone can check
a download by hand ([SECURITY.md](../SECURITY.md#release-signatures)). ADR-031 says why OpenPGP and not
cosign. Container images are signed separately, with cosign (#18, [LINUX.md](LINUX.md)). Tracking
issue: #41.

Until a maintainer turns it on (below), releases are not signed: the workflows write `SHA256SUMS`
and say in a notice that it is unsigned, and nothing fails.

## How it fits together

- **The release key** is an Ed25519 primary key that only certifies, never expires and never leaves
  an offline machine, with an Ed25519 signing subkey that expires after two years. CI holds only
  the subkey. Installs trust the primary key's fingerprint, so a new subkey or a later expiry date
  needs no change on their side.
- **`linux/keys/herald-os-release.asc`** holds the public keys installs trust. It is not in the
  repository until signing is turned on. A tarball built with it ships it in
  `resources/herald-os-linux/keys/`; from that version on, `herald-os update` installs only releases
  whose `SHA256SUMS.sig` checks out against it. Versions without it, everything released before,
  keep checking the `.sha256` as they always did, so no install stops updating on the way.
- **The fingerprint** goes in four places that a test (`linux/tests/test_release_signing.py`) keeps
  in step with the key file: the `Release key fingerprint:` lines in [SECURITY.md](../SECURITY.md)
  and the [README](../README.md), and `_release_keys` in `packaging/arch/herald-os-bin/PKGBUILD`.
  Publish it outside GitHub too (the Discord, a website), since whoever can change the repository
  can change all four.
- **The workflows.** The release jobs of `image.yml` (the ISO and the VM disks) and `release.yml`
  (the tarballs and the Mac downloads) each run `scripts/release-sums.sh` after their upload. It
  writes `SHA256SUMS` from every `.sha256` on the draft release (a split file under its joined name),
  signs it, checks the signature against the committed keys, and uploads `SHA256SUMS`,
  `SHA256SUMS.sig` and `herald-os-release-key.asc` (the committed keys). The two jobs share a
  concurrency group per tag, so they run one at a time and the second lists everything.
- **The release's key file** (`herald-os-release-key.asc`) is never trusted by itself. An install
  reads it only for newer subkeys and expiry dates of the keys it already trusts, and for a new
  primary key that one of those keys has certified.

## The `release-signing` environment and its secrets

Both release jobs run in a GitHub environment named `release-signing`. Create it, with its
protection rules, before any tag is pushed after this change lands: the first run of a job that
names an environment that does not exist yet makes GitHub create it with no protection at all (any
ref may deploy, no one approves), and secrets added to it later would be open to every run until
the rules are set. As for [macOS signing](MACOS-SIGNING.md):

1. Settings > Environments > New environment, named exactly `release-signing`.
2. Under Deployment branches and tags, choose **Selected branches and tags** and add a tag rule for
   `v*`. The release jobs only run for tags.
3. Under Required reviewers, add the people who publish releases, so each signing job waits for one
   of them to approve it, and keep **Prevent self-review** off only if a single person publishes.
4. Add the two environment secrets once the key exists (step 3 below), as environment secrets, never
   as repository secrets, which every job could read:

| Secret | What it holds |
| --- | --- |
| `RELEASE_SIGNING_KEY` | The signing subkey, armored: the output of `gpg --armor --export-secret-subkeys` |
| `RELEASE_SIGNING_PASSPHRASE` | The passphrase of that export (empty if it has none) |

Without `RELEASE_SIGNING_KEY` a release is left unsigned with a notice, until
`linux/keys/herald-os-release.asc` is committed. From then on the job fails instead, because installs
of that version would refuse an unsigned release (a fork only warns). The job also fails if the
secret is not a subkey of a committed key, and warns if it holds the primary key's secret.

## Turning signing on (once)

Do it in this order, so no install ever trusts a key whose releases are not signed yet.

**1. Make the key on an offline machine.** A computer that is not connected (a live USB system
works), with the key's folder on an encrypted USB stick:

```bash
export GNUPGHOME=/media/release-key/gnupg      # on the encrypted stick
mkdir -m 700 -p "$GNUPGHOME"
gpg --quick-generate-key 'Herald OS releases <252071647+iamlukethedev@users.noreply.github.com>' ed25519 cert never
FPR="$(gpg --with-colons --list-keys 'Herald OS releases' | awk -F: '$1 == "fpr" { print $10; exit }')"
gpg --quick-add-key "$FPR" ed25519 sign 2y
gpg --list-keys "$FPR"                          # one primary [C], one subkey [S]
echo "$FPR"                                     # the fingerprint to publish
```

gpg asks for a passphrase for the key; use a long one and keep it in a password manager.

**2. Back it up and export what leaves the machine.**

```bash
gpg --armor --export-secret-keys "$FPR" > herald-os-release-primary.asc   # the backup, stays offline
cp "$GNUPGHOME/openpgp-revocs.d/$FPR.rev" herald-os-release-revoke.asc    # gpg's revocation certificate
gpg --armor --export "$FPR" > herald-os-release.asc                       # public: goes in the repository
# The subkey for CI, under a passphrase of its own, from a throwaway copy of the keyring:
cp -a "$GNUPGHOME" /tmp/ci-export && GNUPGHOME=/tmp/ci-export gpg --passwd "$FPR"
GNUPGHOME=/tmp/ci-export gpg --armor --export-secret-subkeys "$FPR" > release-signing-subkey.asc
rm -rf /tmp/ci-export
```

Keep `herald-os-release-primary.asc` and the passphrase on two offline media in different places
(a second encrypted stick, or paper with `paperkey`), and the revocation certificate apart from them:
anyone who has it can revoke the key. Only `herald-os-release.asc` and `release-signing-subkey.asc`
leave the offline machine.

**3. Add the secrets.** Put the contents of `release-signing-subkey.asc` in `RELEASE_SIGNING_KEY` and
its passphrase in `RELEASE_SIGNING_PASSPHRASE` (the `release-signing` environment, above). Then
delete `release-signing-subkey.asc` (`shred -u`).

**4. Check a signed release before installs trust the key.** Push a pre-release tag. Both release
jobs say "SHA256SUMS is signed with the release key <fingerprint>" and, in a notice, that installs do
not check signatures yet. On another computer, check the draft's files with the commands in
[SECURITY.md](../SECURITY.md#release-signatures), using `herald-os-release.asc` from step 2 and the
fingerprint from step 1, and check that `SHA256SUMS` lists the ISO, the VM disks and the tarballs.

**5. Commit the key, in one pull request:**

- `herald-os-release.asc` as `linux/keys/herald-os-release.asc`;
- the fingerprint, in backticks, on the `Release key fingerprint:` lines of `SECURITY.md` and
  `README.md`, in place of "not set yet";
- `_release_keys=(<fingerprint>)` in `packaging/arch/herald-os-bin/PKGBUILD`, together with a
  `_version` that is a signed release (the package cannot check a release that has no signature);
- the first signed version in SECURITY.md, in place of "from the first signed one on".

CI's tests fail until the four places agree with the key file. The first release built from this
commit is the first whose installs refuse unsigned releases; installs updating to it still check it
the old way.

**6. Publish the fingerprint** outside GitHub: an announcement in the Discord, a website, and, if you
like, `gpg --keyserver hkps://keys.openpgp.org --send-keys "$FPR"`.

## Every release

Nothing changes: push the tag. Publish the draft only after both workflows have finished, since the
release job that finishes last writes the `SHA256SUMS` that lists everything. A re-run writes and
signs it again.

## Extending the subkey

The subkey expires after two years; renew it a few months before, on the offline machine:

```bash
SUB="$(gpg --with-colons --list-keys "$FPR" | awk -F: '$1 == "sub" { s = 1 } $1 == "fpr" && s { print $10; s = 0 }' | tail -n 1)"
gpg --quick-set-expire "$FPR" 2y "$SUB"
gpg --armor --export "$FPR" > herald-os-release.asc
```

Commit the new `herald-os-release.asc` as `linux/keys/herald-os-release.asc`, and export the subkey
for `RELEASE_SIGNING_KEY` again as in step 2 (the expiry date travels with it). Installs of older
versions read the new date from the release's `herald-os-release-key.asc`.

## Rotating

- **A new signing subkey** (routine, or the CI secret leaked): `gpg --quick-add-key "$FPR" ed25519
  sign 2y` on the offline machine. If the old one leaked, revoke it (`gpg --edit-key "$FPR"`, then
  `key <n>`, `revkey`, `save`). Commit the new public export and replace `RELEASE_SIGNING_KEY` with
  the new subkey. Nothing changes for installs: the fingerprint is the primary key's, and the new
  subkey arrives in each release's key file. A revocation reaches an install with the release's key
  file, so until then a leaked subkey together with write access to the releases could still sign a
  release they accept; rotate the GitHub credentials too. An install that never receives the
  revocation (every key file it reads predates it) keeps accepting that subkey: see the limits below.
- **A new primary key** (planned): make it as in step 1, then certify it with the old one
  (`gpg --local-user "$OLD" --quick-sign-key "$NEW"`), and commit both keys' public exports in
  `linux/keys/herald-os-release.asc` (`gpg --armor --export "$OLD" "$NEW"`), with both fingerprints
  on the four lines. Switch `RELEASE_SIGNING_KEY` to the new subkey. Installs that only know the old
  key accept the new one through that certification, which they find in the release's key file; a
  key the new one certifies in turn is not accepted. Once installs have moved past the versions
  with only the old key, drop it. Do not revoke the old key while installs may still rely on it:
  once it is revoked its certification counts for nothing, so those installs refuse every release
  until they are updated by hand.
- **The primary key compromised or lost.** A certification by a compromised key proves nothing, so
  installs need a new key file another way: publish the new fingerprint everywhere the old one was,
  revoke the old key with the revocation certificate, and tell people to install the tarball again
  by hand after checking it. A lost key with its revocation certificate safe can still be revoked.

## What a revocation does, and what it does not

`herald-os update` reads revocations and expiry dates from the key file it carries and from the
release's `herald-os-release-key.asc`, each time it checks a release. A trusted key revoked or
expired in either one no longer signs or vouches for another key, and a certification its own key
has revoked no longer counts. So a release whose key file carries the revocation of the key an
install trusts is refused there, saying that its keys are revoked or expired, and so is a release
signed with a key that revoked key certified. That is intended: once a revocation is seen, nothing
the revoked key signed or certified is trusted, even if its stolen secret made it after the
revocation. An install that trusts no other key that is still good then stays where it is until the
person installs a newer tarball by hand.

Nothing is remembered between checks. A later release whose key file leaves the revocation out is
judged as if there had been none, so an install whose own key file predates the revocation trusts
the revoked key again for that release. A revocation sticks only once it is in the install's own key
file: ship it in `linux/keys/herald-os-release.asc`, and every version built from then on refuses the
revoked key whatever a release's key file says.

## Limits

- **No downgrade guard.** `herald-os update <version>` installs any older release that is signed and
  checks out, so whoever controls the releases can offer an older signed version with known bugs.
  It refuses releases from before signing, since they have no signature.
- **No memory of revocations.** As above, a revocation seen in one release's key file is not kept:
  until the install's own key file carries it, a later release that leaves it out is checked as if
  the key were still good.
- **A revocation must reach the install.** For the same reason, an install learns of a revoked subkey
  only from a key file it reads: its own, or a release's. A release whose key file leaves the
  revocation out, signed with a stolen subkey, is accepted by installs whose own key file predates
  the revocation. Releases must keep carrying the revocation, and the subkeys expire after two years,
  which bounds the window.
- **The Arch package reads revocations from the release's key file only.** Its `prepare()` check
  imports the release's `herald-os-release-key.asc`, not `linux/keys/herald-os-release.asc`, so a
  release whose key file leaves out the revocation of a stolen subkey passes it. makepkg's own check
  still refuses such a signature when the builder's keyring holds the revocation (from importing
  `linux/keys/herald-os-release.asc`), so for Arch a revocation sticks through what the builder
  imported, not through the PKGBUILD. When a key is revoked, move `_release_keys` to the new key in
  the same commit.
