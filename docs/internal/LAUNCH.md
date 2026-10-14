# Launch checklist

What has to happen, in order, to take Herald OS public. Nothing in this list is automated: every
step is a deliberate decision.

## Before the repository goes public

1. **Mac signing.** Enrol in the Apple Developer Program, create a Developer ID Application
   certificate, export it as a `.p12`, create the `macos-release` environment (deployments limited
   to `main` and `v*` tags), and add its environment secrets `MAC_CERTIFICATE_P12`
   (base64 of the file), `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
   (from account.apple.com) and `APPLE_TEAM_ID`. [MACOS-SIGNING.md](../MACOS-SIGNING.md) walks
   through each one. The build stays unsigned, with a warning naming what is missing, until all five
   are set.
2. **A dry run.** Run the Release workflow by hand and check the macOS job verified the signature,
   the notarization ticket and Gatekeeper (`spctl`). Install the DMG on a second Mac.
3. **Linux artifacts.** Tag a release candidate (`v0.2.0-rc.1`); check the Linux tarballs and the
   images build, then boot the qcow2 with `linux/vm/run-qemu.sh --image`.
4. **History and secrets.** `bash scripts/check-secrets.sh` on the full history; no personal names,
   work email or private screenshots anywhere (README images, docs, commits).
5. **Image signing key.** `cosign generate-key-pair`; add `COSIGN_PRIVATE_KEY` and `COSIGN_PASSWORD`
   as repository secrets and commit `cosign.pub` as `linux/image/cosign.pub` (images built after
   that only accept signed updates). Keep the private key and its password out of the repository.
6. **The Arch package.** Run the Arch package workflow; fill `sha256sums` in
   `packaging/arch/herald-os-bin/PKGBUILD` from the release's `.sha256` files (`updpkgsums`), and
   generate each `.SRCINFO` with `makepkg --printsrcinfo`.
7. **An Omarchy test.** On an Omarchy VM: install the package, `herald-os setup`, `herald-os omarchy
   install`, and check the theme hook, the menu entry (Omarchy's menu extension format) and the keys.

## Launch day

1. Flip the repository to public.
2. Enable GitHub Discussions (Settings > General > Features) with Q&A, Ideas and Show and tell.
3. Publish the draft release the tag created.
4. Publish the AUR packages from `packaging/arch/` (`herald-os-bin` first, then `herald-os-git`).
5. Switch image signing to keyless cosign if wanted (ADR-018): it publishes the workflow identity to
   the public Rekor log, which is fine once the repository is public.
6. Post the demo and the release notes.

## After launch

- Answer Discussions daily for the first two weeks; turn repeated questions into
  [FAQ](../manual/faq.md) entries and troubleshooting notes.
- Watch the crash-help and usage features for false alarms and adjust their thresholds.
