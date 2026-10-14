# macOS signing and notarization

The Release workflow (`.github/workflows/release.yml`) signs the macOS app with a Developer ID
Application certificate and has Apple notarize it, so the DMG opens on any Mac without a Gatekeeper
warning. It does this only when all five secrets below are set in the `macos-release` environment.
With any of them missing, the build still succeeds: it goes out unsigned and not notarized, and the
job shows a warning that names the missing secrets (never their values). Tracking issue: #12.

## The `macos-release` environment

The macOS job runs in a GitHub environment named `macos-release`, and the five secrets are
environment secrets there, not repository secrets. The environment's deployment rules decide which
refs can reach them. Create it before adding any secret:

1. Settings > Environments > New environment, named exactly `macos-release`.
2. Under Deployment branches and tags, choose **Selected branches and tags** and add two rules:
   - a branch rule for `main` (manual runs of the Release workflow from `main`);
   - a tag rule for `v*` (the release tags).
3. Optionally add yourself under Required reviewers, so each signed build waits for your approval.
4. Add the five secrets under Environment secrets (the steps below show how).

If the workflow references `macos-release` before you create it, GitHub creates it with no rules, so
any branch could use it. Create it with the rules first. Do not keep copies of these secrets as
repository secrets: the job would read those too, and they are not limited to `main` and `v*`.

Only `main` and `v*` tags may deploy to the environment. A manual Release run from a feature branch
therefore fails: the macOS job stops at the `macos-release` gate with "not allowed to deploy to
macos-release" before any step runs, signed or unsigned. That is GitHub enforcing the rule, not a
missing secret. To try workflow changes, merge them to `main` first or push a `v*` release-candidate
tag.

## The secrets

| Secret | What it holds |
| --- | --- |
| `MAC_CERTIFICATE_P12` | The Developer ID Application certificate and its private key, exported as a `.p12` and encoded as base64 |
| `MAC_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | The email of the Apple Account in the developer team, used to submit for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple Account (not its real password) |
| `APPLE_TEAM_ID` | The 10-character Team ID of the developer team that owns the certificate |

No step gets more secrets than it needs:

| Step | Secrets it gets |
| --- | --- |
| Checkout, install, `sync-upstream`, renderer and Electron build | none |
| Check the signing secrets (only tests whether each is set) | all five |
| Package, sign and notarize the app (electron-builder) | all five: the first two as `CSC_LINK` and `CSC_KEY_PASSWORD`, the others by name for `@electron/notarize` |
| Notarize and staple the DMG (`notarytool`) | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Verify the signatures and the notarization tickets | `APPLE_TEAM_ID` |

Dependencies are installed with `npm ci --ignore-scripts`, then only node-pty's and esbuild's install
scripts run (`npm rebuild node-pty esbuild`). None of these steps can see a secret. The job's
`GITHUB_TOKEN` can only read the repository, and checkouts don't keep it (`persist-credentials:
false`). Only the separate release job, which holds no Apple secrets, can write to releases.

The DMG notarization step passes the app-specific password to `xcrun notarytool` on its command
line (`--password`), as `@electron/notarize` does for the app. Other processes on the same machine
could read it from the process list while notarytool runs. That is acceptable on GitHub-hosted
runners: each job gets a fresh, single-use VM that is destroyed afterwards, and GitHub masks the
value in logs. To keep the password off argv entirely, use an App Store Connect API key instead of
an Apple ID: a `.p8` private key, its key ID, and the issuer ID, created under App Store Connect >
Users and Access > Integrations. notarytool reads the key from a file (`--key`, `--key-id`,
`--issuer`), and electron-builder uses it through `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
`APPLE_API_ISSUER`. The workflow doesn't support the API key yet: switching would replace the two
Apple ID secrets and change the five-secret check.

## Setting them up

You need a membership of the Apple Developer Program (the paid one) and a Mac. The `gh` commands
use the [GitHub CLI](https://cli.github.com) from the repository; `--env macos-release` stores each
secret in the environment.

### 1. Create the Developer ID Application certificate

1. On the Mac, open Keychain Access and choose Keychain Access > Certificate Assistant > Request a
   Certificate From a Certificate Authority. Enter your email, choose "Saved to disk", and save the
   `.certSigningRequest` file.
2. At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list),
   add a certificate of type **Developer ID Application**. Apple Development and Mac App
   Distribution certificates won't work, because they can't sign apps distributed outside the App
   Store. Only the team's Account Holder can create one. Upload the request file and download the
   `.cer`.
3. Double-click the `.cer` to add it to your login keychain. In Keychain Access > My Certificates it
   appears as `Developer ID Application: <Name> (<TEAMID>)`, with a private key under it. If there
   is no private key under it, the certificate was requested on another Mac; export from that one.

### 2. Export it as a base64 `.p12`

1. In Keychain Access > My Certificates, right-click `Developer ID Application: <Name> (<TEAMID>)`
   and choose Export. Save it as `herald-os-developer-id.p12` (Personal Information Exchange) and set
   a strong password: that password is `MAC_CERTIFICATE_PASSWORD`.
2. Encode it and add both secrets:

   ```bash
   base64 -i herald-os-developer-id.p12 | gh secret set MAC_CERTIFICATE_P12 --env macos-release
   gh secret set MAC_CERTIFICATE_PASSWORD --env macos-release     # paste the export password
   ```

   Without the GitHub CLI, run `base64 -i herald-os-developer-id.p12 | pbcopy` and paste the result
   as the value of `MAC_CERTIFICATE_P12` under Settings > Environments > macos-release.
3. Delete the `.p12` once the secret is saved; the certificate stays in your keychain.

### 3. Create the app-specific password

1. Sign in at [account.apple.com](https://account.apple.com) with the Apple Account you will use for
   `APPLE_ID` (it must be a member of the developer team and have two-factor authentication on).
2. Go to Sign-In and Security > App-Specific Passwords, add one named `Herald OS notarization`, and
   copy the password it shows (`xxxx-xxxx-xxxx-xxxx`). Apple shows it only once.
3. Add the secrets:

   ```bash
   gh secret set APPLE_ID --env macos-release                     # the Apple Account email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD --env macos-release  # the generated password
   ```

Changing the Apple Account's password revokes all its app-specific passwords; generate a new one
and update the secret when that happens.

### 4. Find the Team ID

Any of these shows it:

- [developer.apple.com/account](https://developer.apple.com/account) > Membership details > Team ID.
- The certificate's name: the 10 characters in parentheses in `Developer ID Application: <Name> (<TEAMID>)`.
- On the Mac with the certificate: `security find-identity -v -p codesigning`.

```bash
gh secret set APPLE_TEAM_ID --env macos-release
```

## What gets notarized

There are two notarization submissions per signed build, and the zip has no ticket of its own:

| Artifact | Signed | Notarized | Ticket stapled |
| --- | --- | --- | --- |
| `Herald OS.app` | Developer ID, hardened runtime, `build/entitlements.mac.plist` | Yes: electron-builder submits it through `@electron/notarize` | Yes, to the app, before the DMG and zip are made |
| `HeraldOS-<version>-mac-arm64.dmg` | Developer ID (`-c.dmg.sign=true`) | Yes: a second `xcrun notarytool submit` of the DMG itself | Yes, to the DMG (`xcrun stapler staple`) |
| `HeraldOS-<version>-mac-arm64.zip` | No (a zip cannot be signed) | Not on its own; it holds the notarized app | No (a zip cannot carry a ticket); the app inside carries its own |

So Gatekeeper accepts the DMG when it is opened, even offline, and accepts the app from either
download. Stapling changes the DMG's bytes after electron-builder has written it. That is fine
because the workflow uploads only the `.dmg` and `.zip`, not the `.blockmap` or `latest-mac.yml`.

## What the workflow does

1. **Check the signing secrets.** Checks that all five are set. If any is not, it writes a
   `::warning::` naming the missing ones and builds unsigned.
2. **Check the mac signing config.** This step needs no secrets, so it runs on unsigned builds too.
   It runs `apps/desktop/scripts/check-mac-signing-config.mjs`, which fails the job if `build.mac`
   in `apps/desktop/package.json`:
   - no longer has `hardenedRuntime: true`;
   - has `entitlements` or `entitlementsInherit` unset, or pointing at a file that is not there;
   - turns signing off (`identity: null`) or notarization off (`notarize: false`).

   Then `plutil -lint` checks the entitlements file.
3. **Package.** Runs `npm run pack:mac` on the bundles built earlier.
   - Signed: electron-builder imports the certificate into a temporary keychain, signs the app with
     the hardened runtime and the entitlements, notarizes and staples it, then builds and signs the
     DMG and the zip.
   - Unsigned: the step gets no secrets at all. `CSC_IDENTITY_AUTO_DISCOVERY=false` stops
     electron-builder from picking up any identity on the runner, and `-c.mac.notarize=false` turns
     notarization off. The app keeps the linker's ad-hoc signature.
4. **Notarize and staple the DMG** (signed builds only). The step submits the DMG with
   `xcrun notarytool submit --wait`, then staples the ticket. If Apple returns any status other
   than `Accepted`, the step prints the notarization log and fails.
5. **Verify the signatures and the notarization tickets** (signed builds only). The job fails if any
   of these fail:
   - on the app:
     - `codesign --verify --deep --strict`;
     - `codesign --display` shows a Developer ID Application authority, the team `APPLE_TEAM_ID`,
       and the hardened runtime flag;
     - `xcrun stapler validate`;
     - `spctl --assess --type execute -vv` (Gatekeeper reports `source=Notarized Developer ID`);
   - on each DMG: `codesign --verify --strict`, `xcrun stapler validate`, and
     `spctl --assess --type open --context context:primary-signature -vv`;
   - on each zip: unpacks it, then runs `xcrun stapler validate` and `spctl --assess` on the app
     inside.
6. **Attach to the draft release** (tags only). This separate job downloads the artifacts and is the
   only job that can write to releases (`contents: write`).

## Checking a build on your Mac

After downloading a release:

```bash
dmg=~/Downloads/HeraldOS-<version>-mac-arm64.dmg
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature -vv "$dmg"

app="/Applications/Herald OS.app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=4 "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory)'
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app"
```

An unsigned build shows `flags=0x20002(adhoc,linker-signed)` and `spctl` rejects it.

## When it fails

- **The warning names secrets you set.** Check that they are environment secrets of
  `macos-release`, not repository or Dependabot secrets, and that the names match exactly.
- **"not allowed to deploy to macos-release".** The run is not on `main` or a `v*` tag. Run it from
  one of those, or change the environment's rules.
- **`is not signed with a Developer ID Application certificate`.** The `.p12` holds another kind of
  certificate (Apple Development, Mac App Distribution). Export the Developer ID Application one.
- **electron-builder cannot import the certificate.** The `.p12` lacks the private key, the password
  is wrong, or the base64 was wrapped or truncated when pasted. Re-export and set the secret again
  with `base64 -i ... | gh secret set MAC_CERTIFICATE_P12 --env macos-release`.
- **Notarization is rejected.** For the DMG, the job prints Apple's log. For the app, the
  electron-builder output prints a submission ID. On a Mac, run
  `xcrun notarytool log <submission-id> --apple-id <APPLE_ID> --team-id <APPLE_TEAM_ID>` (it asks
  for the app-specific password). Common causes are an unsigned nested binary or a missing hardened
  runtime.
- **HTTP 401 from notarytool.** The app-specific password was revoked or mistyped, or `APPLE_ID` is
  not in the team `APPLE_TEAM_ID`.
- **The certificate expired.** Developer ID Application certificates last five years. Create a new
  one and update `MAC_CERTIFICATE_P12` and `MAC_CERTIFICATE_PASSWORD`; apps signed and notarized
  before it expired keep opening.

## After the first signed release

Once a signed build has opened on a second Mac without a warning, remove the
`xattr -dr com.apple.quarantine` step from the README's install instructions.
