# macOS signing and notarization

The Release workflow (`.github/workflows/release.yml`) signs the macOS app with a Developer ID
Application certificate and has Apple notarize it, so the DMG opens on any Mac without a Gatekeeper
warning. It does this only when all five repository secrets below are set. With any of them missing,
the build still succeeds: it goes out unsigned and not notarized, and the job shows a warning that
names the missing secrets (never their values). Tracking issue: #12.

## The secrets

Add them under Settings > Secrets and variables > Actions > Repository secrets.

| Secret | What it holds |
| --- | --- |
| `MAC_CERTIFICATE_P12` | The Developer ID Application certificate and its private key, exported as a `.p12` and encoded as base64 |
| `MAC_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | The email of the Apple Account in the developer team, used to submit for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple Account (not its real password) |
| `APPLE_TEAM_ID` | The 10-character Team ID of the developer team that owns the certificate |

The workflow passes the first two to electron-builder as `CSC_LINK` and `CSC_KEY_PASSWORD`, and the
other three under their own names, which electron-builder hands to `@electron/notarize`.

## Setting them up

You need a membership of the Apple Developer Program (the paid one) and a Mac.

### 1. Create the Developer ID Application certificate

1. On the Mac, open Keychain Access and choose Keychain Access > Certificate Assistant > Request a
   Certificate From a Certificate Authority. Enter your email, choose "Saved to disk", and save the
   `.certSigningRequest` file.
2. At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list),
   add a certificate of type **Developer ID Application** (not Apple Development or Mac App
   Distribution: those cannot sign apps distributed outside the App Store). Only the team's Account
   Holder can create one. Upload the request file and download the `.cer`.
3. Double-click the `.cer` to add it to your login keychain. In Keychain Access > My Certificates it
   appears as `Developer ID Application: <Name> (<TEAMID>)`, with a private key under it. If there
   is no private key under it, the certificate was requested on another Mac; export from that one.

### 2. Export it as a base64 `.p12`

1. In Keychain Access > My Certificates, right-click `Developer ID Application: <Name> (<TEAMID>)`
   and choose Export. Save it as `herald-os-developer-id.p12` (Personal Information Exchange) and set
   a strong password: that password is `MAC_CERTIFICATE_PASSWORD`.
2. Encode it and add both secrets (with the [GitHub CLI](https://cli.github.com), from the repository):

   ```bash
   base64 -i herald-os-developer-id.p12 | gh secret set MAC_CERTIFICATE_P12
   gh secret set MAC_CERTIFICATE_PASSWORD     # paste the export password when asked
   ```

   Without the GitHub CLI, run `base64 -i herald-os-developer-id.p12 | pbcopy` and paste the result
   as the value of `MAC_CERTIFICATE_P12` on the website.
3. Delete the `.p12` once the secret is saved; the certificate stays in your keychain.

### 3. Create the app-specific password

1. Sign in at [account.apple.com](https://account.apple.com) with the Apple Account you will use for
   `APPLE_ID` (it must be a member of the developer team and have two-factor authentication on).
2. Go to Sign-In and Security > App-Specific Passwords, add one named `Herald OS notarization`, and
   copy the password it shows (`xxxx-xxxx-xxxx-xxxx`). Apple shows it only once.
3. Add the secrets:

   ```bash
   gh secret set APPLE_ID                     # the Apple Account email
   gh secret set APPLE_APP_SPECIFIC_PASSWORD  # the generated password
   ```

Changing the Apple Account's password revokes all its app-specific passwords; generate a new one
and update the secret when that happens.

### 4. Find the Team ID

Any of these shows it:

- [developer.apple.com/account](https://developer.apple.com/account) > Membership details > Team ID.
- The certificate's name: the 10 characters in parentheses in `Developer ID Application: <Name> (<TEAMID>)`.
- On the Mac with the certificate: `security find-identity -v -p codesigning`.

```bash
gh secret set APPLE_TEAM_ID
```

## What the workflow does

1. **Check the signing secrets.** Checks that all five are set. If any is not, it writes a
   `::warning::` naming the missing ones and builds unsigned.
2. **Check the mac signing config.** Runs `apps/desktop/scripts/check-mac-signing-config.mjs`, which
   fails the job if `build.mac` in `apps/desktop/package.json` no longer has `hardenedRuntime: true`,
   has `entitlements` and `entitlementsInherit` pointing at files that are not there, or turns signing
   (`identity: null`) or notarization (`notarize: false`) off. Then `plutil -lint` checks the
   entitlements file. This step runs on unsigned builds too, since it needs no secrets.
3. **Build, sign and notarize.**
   - Signed: electron-builder imports the certificate into a temporary keychain, signs the app with
     the hardened runtime and `build/entitlements.mac.plist`, submits it with `notarytool`, staples
     the ticket, and signs the DMG (`-c.dmg.sign=true`).
   - Unsigned: the secrets are removed from the environment, `CSC_IDENTITY_AUTO_DISCOVERY=false` stops
     electron-builder from picking up any identity on the runner, and `-c.mac.notarize=false` turns
     notarization off. The app keeps the linker's ad-hoc signature.
4. **Verify the signature and the notarization ticket** (signed builds only). The job fails if any of
   these fail:
   - `codesign --verify --deep --strict` on the app;
   - `codesign --display`: the signing authority is a Developer ID Application certificate, the team
     is `APPLE_TEAM_ID`, and the hardened runtime flag is set;
   - `xcrun stapler validate`: the notarization ticket is stapled;
   - `spctl --assess --type execute -vv`: Gatekeeper accepts it (`source=Notarized Developer ID`);
   - `codesign --verify --strict` on each DMG.

## Checking a build on your Mac

After downloading a release:

```bash
app="/Applications/Herald OS.app"
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=4 "$app" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory)'
xcrun stapler validate "$app"
spctl --assess --type execute -vv "$app"
```

An unsigned build shows `flags=0x20002(adhoc,linker-signed)` and `spctl` rejects it.

## When it fails

- **The warning names secrets you set.** Check that they are repository secrets (not environment or
  Dependabot secrets) and that the names match exactly.
- **`is not signed with a Developer ID Application certificate`.** The `.p12` holds another kind of
  certificate (Apple Development, Mac App Distribution). Export the Developer ID Application one.
- **electron-builder cannot import the certificate.** The `.p12` lacks the private key, the password
  is wrong, or the base64 was wrapped or truncated when pasted. Re-export and set the secret again
  with `base64 -i ... | gh secret set`.
- **Notarization is rejected.** The log prints a submission ID. On a Mac, see why with
  `xcrun notarytool log <submission-id> --apple-id <APPLE_ID> --team-id <APPLE_TEAM_ID>` (it asks for
  the app-specific password). Common causes are an unsigned nested binary or a missing hardened runtime.
- **HTTP 401 from notarytool.** The app-specific password was revoked or mistyped, or `APPLE_ID` is
  not in the team `APPLE_TEAM_ID`.
- **The certificate expired.** Developer ID Application certificates last five years. Create a new
  one and update `MAC_CERTIFICATE_P12` and `MAC_CERTIFICATE_PASSWORD`; apps signed and notarized
  before it expired keep opening.

## After the first signed release

Once a signed build has opened on a second Mac without a warning, remove the
`xattr -dr com.apple.quarantine` step from the README's install instructions.
