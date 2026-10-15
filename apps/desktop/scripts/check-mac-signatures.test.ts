import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseBundles, signatureProblems } from './check-mac-signatures.mjs'

const options = { identifier: 'dev.iamluke.heraldos' }
const ok = { status: 0, output: 'Herald OS.app: valid on disk\nHerald OS.app: satisfies its Designated Requirement\n' }

// What codesign --display --verbose=4 printed for the 0.1.0-alpha.4 app, which macOS called damaged.
const linkerSigned = `Executable=/Applications/Herald OS.app/Contents/MacOS/Herald OS
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=530 flags=0x20002(adhoc,linker-signed) hashes=13+0 location=embedded
Hash type=sha256 size=32
CDHash=0e7b0c4c6b0d1f2a3e4f5a6b7c8d9e0f1a2b3c4d
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`

const adhoc = `Executable=/Applications/Herald OS.app/Contents/MacOS/Herald OS
Identifier=dev.iamluke.heraldos
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=769 flags=0x10002(adhoc,runtime) hashes=13+7 location=embedded
Hash type=sha256 size=32
CDHash=5d1c3a7e9b2f4d6c8a0e1f3b5d7c9a2e4f6b8d0c
Signature=adhoc
Info.plist entries=33
TeamIdentifier=not set
Runtime Version=26.0.0
Sealed Resources version=2 rules=13 files=412
Internal requirements count=0 size=12
`

const developerId = adhoc
  .replace('Signature=adhoc\n', 'Authority=Developer ID Application: Luke The Dev (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\n')
  .replace('flags=0x10002(adhoc,runtime)', 'flags=0x10000(runtime)')
  .replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDE12345')

describe('signatureProblems', () => {
  it('rejects the alpha.4 app: linker signatures only, no sealed resources, Info.plist not bound', () => {
    const verify = { status: 1, output: 'Herald OS.app: code has no resources but signature indicates they must be present\n' }

    expect(signatureProblems('mac-arm64/Herald OS.app', { verify, details: linkerSigned }, options)).toEqual([
      'mac-arm64/Herald OS.app fails codesign --verify --deep --strict: Herald OS.app: code has no resources but signature indicates they must be present',
      "mac-arm64/Herald OS.app has only the linker's ad hoc signature, not one over the bundle.",
      'mac-arm64/Herald OS.app has no sealed resources (no Contents/_CodeSignature/CodeResources).',
      'mac-arm64/Herald OS.app does not bind its Info.plist to the signature.',
      'mac-arm64/Herald OS.app is signed as Electron, not dev.iamluke.heraldos.'
    ])
  })

  it('passes an app signed ad hoc over the whole bundle, and one signed with a Developer ID', () => {
    expect(signatureProblems('a', { verify: ok, details: adhoc }, options)).toEqual([])
    expect(signatureProblems('a', { verify: ok, details: developerId }, options)).toEqual([])
  })

  it('reports a failed verify even when the signature looks complete', () => {
    const verify = { status: 1, output: 'a sealed resource is missing or invalid\n' }

    expect(signatureProblems('x.dmg: Herald OS.app', { verify, details: adhoc }, options)).toEqual([
      'x.dmg: Herald OS.app fails codesign --verify --deep --strict: a sealed resource is missing or invalid'
    ])
  })

  it('reports an app with no signature at all', () => {
    const verify = { status: 1, output: 'code object is not signed at all\n' }

    expect(signatureProblems('a', { verify, details: 'a: code object is not signed at all\n' }, options)).toEqual([
      'a fails codesign --verify --deep --strict: code object is not signed at all',
      'a is not signed.',
      'a has no sealed resources (no Contents/_CodeSignature/CodeResources).',
      'a does not bind its Info.plist to the signature.',
      'a is signed as nothing, not dev.iamluke.heraldos.'
    ])
  })
})

describe('releaseBundles', () => {
  let root = ''

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('finds the app in each architecture folder, and every zip and DMG', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-sign-'))
    for (const dir of ['mac-arm64', 'mac']) fs.mkdirSync(path.join(root, dir, 'Herald OS.app', 'Contents'), { recursive: true })
    fs.mkdirSync(path.join(root, 'builder-debug'))
    for (const file of ['HeraldOS-0.2.0-mac-arm64.dmg', 'HeraldOS-0.2.0-mac-arm64.zip', 'HeraldOS-0.2.0-mac-x64.dmg', 'HeraldOS-0.2.0-mac-x64.zip', 'HeraldOS-0.2.0-mac-x64.zip.blockmap', 'latest-mac.yml']) {
      fs.writeFileSync(path.join(root, file), '')
    }

    expect(releaseBundles(root)).toEqual({
      apps: [path.join(root, 'mac', 'Herald OS.app'), path.join(root, 'mac-arm64', 'Herald OS.app')],
      zips: [path.join(root, 'HeraldOS-0.2.0-mac-arm64.zip'), path.join(root, 'HeraldOS-0.2.0-mac-x64.zip')],
      dmgs: [path.join(root, 'HeraldOS-0.2.0-mac-arm64.dmg'), path.join(root, 'HeraldOS-0.2.0-mac-x64.dmg')]
    })
  })

  it('finds nothing when release/ is missing', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-sign-'))

    expect(releaseBundles(path.join(root, 'release'))).toEqual({ apps: [], zips: [], dmgs: [] })
  })
})
