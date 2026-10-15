import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISPLAY_ARGS, VERIFY_ARGS, bundleCountProblems, checkDmg, main, releaseBundles, signatureProblems } from './check-mac-signatures.mjs'

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
      'mac-arm64/Herald OS.app has no sealed resources (no _CodeSignature/CodeResources).',
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
      'a has no sealed resources (no _CodeSignature/CodeResources).',
      'a does not bind its Info.plist to the signature.',
      'a is signed as nothing, not dev.iamluke.heraldos.'
    ])
  })

  it('on a signed build, needs the Developer ID signature and the expected TeamIdentifier', () => {
    const signed = { ...options, signed: true, teamId: 'ABCDE12345' }

    expect(signatureProblems('a', { verify: ok, details: developerId }, signed)).toEqual([])
    expect(signatureProblems('a', { verify: ok, details: developerId }, { ...signed, teamId: 'ZZZZZ99999' })).toEqual(['a has TeamIdentifier ABCDE12345, not ZZZZZ99999.'])
    expect(signatureProblems('a', { verify: ok, details: adhoc }, signed)).toEqual([
      'a is signed ad hoc, but this build should carry the Developer ID signature.',
      'a has TeamIdentifier not set, not ABCDE12345.'
    ])
  })

  it('ignores the team on an ad hoc build', () => {
    expect(signatureProblems('a', { verify: ok, details: adhoc }, { ...options, signed: false, teamId: 'ABCDE12345' })).toEqual([])
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

describe('bundleCountProblems', () => {
  const two = ['mac/Herald OS.app', 'mac-arm64/Herald OS.app']

  it('passes a zip and a DMG for each app', () => {
    expect(bundleCountProblems({ apps: two, zips: ['a.zip', 'b.zip'], dmgs: ['a.dmg', 'b.dmg'] }, 'release')).toEqual([])
  })

  it('fails when a zip or a DMG is missing', () => {
    expect(bundleCountProblems({ apps: two, zips: ['a.zip'], dmgs: [] }, 'release')).toEqual([
      'release has 1 zip(s) for 2 app(s): each app needs its own zip.',
      'release has 0 DMG(s) for 2 app(s): each app needs its own DMG.'
    ])
  })

  it('fails when there is no app', () => {
    expect(bundleCountProblems({ apps: [], zips: ['a.zip'], dmgs: ['a.dmg'] }, 'release')).toEqual(['No Herald OS.app under release.'])
  })
})

describe('checkDmg', () => {
  type Call = { command: string; args: string[] }

  /** A stand-in for spawnSync that records each call and answers hdiutil attach with `attachStatus`. */
  function fakeExec(attachStatus: number) {
    const calls: Call[] = []
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args })
      return args[0] === 'attach' ? { status: attachStatus, output: attachStatus ? 'hdiutil: attach failed - no mountable file systems\n' : '' } : { status: 0, output: '' }
    }
    const mount = () => calls[0].args[calls[0].args.indexOf('-mountpoint') + 1]
    return { calls, exec, mount }
  }

  it('reports a DMG that does not mount, and removes the empty mount folder', () => {
    const { calls, exec, mount } = fakeExec(1)
    const check = () => {
      throw new Error('must not check an app that was never mounted')
    }

    expect(checkDmg('/r/HeraldOS-0.2.0-mac-x64.dmg', options, { exec, check })).toEqual({
      checked: false,
      problems: ['HeraldOS-0.2.0-mac-x64.dmg does not mount: hdiutil: attach failed - no mountable file systems']
    })
    expect(calls.map(call => call.args[0])).toEqual(['attach'])
    expect(fs.existsSync(mount())).toBe(false)
  })

  it('checks the app in a mounted DMG, then detaches it and removes the mount folder', () => {
    const { calls, exec, mount } = fakeExec(0)
    const checked: string[] = []
    const check = (app: string, where: string) => {
      checked.push(app)
      return [`${where} is bad.`]
    }

    expect(checkDmg('/r/HeraldOS-0.2.0-mac-arm64.dmg', options, { exec, check })).toEqual({
      checked: true,
      problems: ['HeraldOS-0.2.0-mac-arm64.dmg: Herald OS.app is bad.']
    })
    expect(checked).toEqual([path.join(mount(), 'Herald OS.app')])
    expect(calls.map(call => call.args.slice(0, 2))).toEqual([
      ['attach', '-readonly'],
      ['detach', mount()]
    ])
    expect(fs.existsSync(mount())).toBe(false)
  })

  it('leaves the mount folder alone when the DMG is still mounted on it', () => {
    let left = ''
    const exec = (_command: string, args: string[]) => {
      if (args[0] === 'attach') {
        left = args[args.indexOf('-mountpoint') + 1]
        fs.writeFileSync(path.join(left, 'still-mounted'), '')
      }
      return { status: 0, output: '' }
    }

    checkDmg('/r/x.dmg', options, { exec, check: () => [] })

    expect(fs.existsSync(path.join(left, 'still-mounted'))).toBe(true)
    fs.rmSync(left, { recursive: true, force: true })
  })
})

describe('main', () => {
  const APP_ID = 'dev.iamluke.heraldos'
  const HELPERS = ['Electron Framework.framework', 'Herald OS Helper.app']
  type Call = { command: string; args: string[] }
  type Fault = 'verify' | 'linker' | 'identifier'

  let root = ''

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** An app with a helper app and a framework, as electron-builder lays one out. */
  function makeApp(app: string) {
    for (const helper of HELPERS) fs.mkdirSync(path.join(app, 'Contents', 'Frameworks', helper), { recursive: true })
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  }

  /** release/ with an app, a zip and a DMG for each of arm64 and x64, unless `skip` names some of them. */
  function makeRelease(skip: string[] = []) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-main-'))
    const releaseDir = path.join(root, 'release')
    fs.mkdirSync(path.join(root, 'tmp'))
    fs.mkdirSync(releaseDir)
    for (const dir of ['mac-arm64', 'mac']) if (!skip.includes(dir)) makeApp(path.join(releaseDir, dir, 'Herald OS.app'))
    for (const arch of ['arm64', 'x64']) {
      for (const ext of ['zip', 'dmg']) {
        const name = `HeraldOS-0.2.0-mac-${arch}.${ext}`
        if (!skip.includes(name)) fs.writeFileSync(path.join(releaseDir, name), '')
      }
    }
    return releaseDir
  }

  /**
   * Stands in for codesign, ditto and hdiutil. `faults` breaks the bundles whose path ends with a
   * match of a key (a regular expression); `unmountable` names DMGs hdiutil cannot attach, and
   * `unzippable` zips ditto cannot unpack. `signature` is what codesign reports.
   */
  function fakeTools({
    faults = {},
    unmountable = [],
    unzippable = [],
    signature = 'adhoc'
  }: { faults?: Record<string, Fault>; unmountable?: string[]; unzippable?: string[]; signature?: 'adhoc' | 'developer-id' } = {}) {
    const calls: Call[] = []
    const fault = (bundle: string) => Object.entries(faults).find(([pattern]) => new RegExp(`${pattern}$`).test(bundle))?.[1]
    const exec = (command: string, args: string[]) => {
      calls.push({ command, args })
      const last = args[args.length - 1]
      if (command === 'codesign' && args[0] === '--verify') {
        return fault(last) === 'verify' ? { status: 1, output: `${last}: a sealed resource is missing or invalid\n` } : { status: 0, output: `${last}: valid on disk\n` }
      }
      if (command === 'codesign' && args[0] === '--display') {
        const base = signature === 'adhoc' ? adhoc : developerId
        const identifier = last.endsWith('Herald OS.app') ? APP_ID : `${APP_ID}.${path.basename(last)}`
        if (fault(last) === 'linker') return { status: 0, output: linkerSigned }
        if (fault(last) === 'identifier') return { status: 0, output: base.replace(`Identifier=${APP_ID}`, 'Identifier=Electron') }
        return { status: 0, output: base.replace(`Identifier=${APP_ID}`, `Identifier=${identifier}`) }
      }
      if (command === 'ditto') {
        if (unzippable.includes(path.basename(args[args.length - 2]))) return { status: 1, output: 'ditto: Couldn\'t read PKZip signature\n' }
        makeApp(path.join(last, 'Herald OS.app'))
        return { status: 0, output: '' }
      }
      if (command === 'hdiutil' && args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1]
        if (unmountable.includes(path.basename(last))) return { status: 1, output: 'hdiutil: attach failed - no mountable file systems\n' }
        makeApp(path.join(mount, 'Herald OS.app'))
        return { status: 0, output: '' }
      }
      if (command === 'hdiutil' && args[0] === 'detach') {
        fs.rmSync(path.join(args[1], 'Herald OS.app'), { recursive: true, force: true })
        return { status: 0, output: '' }
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`)
    }
    return { calls, exec }
  }

  function runMain(releaseDir: string, exec: (command: string, args: string[]) => { status: number; output: string }, env: Record<string, string> = {}) {
    const lines: string[] = []
    const code = main({ platform: 'darwin', exec, log: line => lines.push(line), releaseDir, build: { appId: APP_ID }, env, tmpdir: path.join(root, 'tmp') })
    return { code, lines, errors: lines.filter(line => line.startsWith('::error::')) }
  }

  it('passes a release whose every copy and helper is signed, and runs codesign --verify --deep --strict on each', () => {
    const releaseDir = makeRelease()
    const { calls, exec } = fakeTools()

    const { code, lines } = runMain(releaseDir, exec)

    expect(lines).toEqual([expect.stringContaining('All 6 copies of Herald OS.app')])
    expect(code).toBe(0)
    const verifies = calls.filter(call => call.command === 'codesign' && call.args[0] === '--verify')
    // 2 apps, 2 zips and 2 DMGs, each with the app and its 2 helpers.
    expect(verifies).toHaveLength(18)
    for (const call of verifies) expect(call.args.slice(0, -1)).toEqual(['--verify', '--deep', '--strict', '--verbose=2'])
    expect(VERIFY_ARGS).toEqual(['--verify', '--deep', '--strict', '--verbose=2'])
    for (const call of calls.filter(c => c.command === 'codesign' && c.args[0] === '--display')) expect(call.args.slice(0, -1)).toEqual(DISPLAY_ARGS)
    expect(verifies.map(call => call.args.at(-1))).toContain(path.join(releaseDir, 'mac-arm64', 'Herald OS.app'))
    expect(verifies.map(call => call.args.at(-1))).toContain(path.join(releaseDir, 'mac', 'Herald OS.app', 'Contents', 'Frameworks', 'Herald OS Helper.app'))
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  it('fails when release/ has no app', () => {
    const releaseDir = makeRelease(['mac-arm64', 'mac'])

    const { code, errors } = runMain(releaseDir, fakeTools().exec)

    expect(code).toBe(1)
    expect(errors).toContain(`::error::No Herald OS.app under ${releaseDir}.`)
  })

  it('fails when release/ is missing altogether', () => {
    makeRelease()

    const { code, errors } = runMain(path.join(root, 'nowhere'), fakeTools().exec)

    expect(code).toBe(1)
    expect(errors).toEqual([expect.stringContaining('No Herald OS.app under')])
  })

  it('fails when a zip or a DMG is missing', () => {
    const releaseDir = makeRelease(['HeraldOS-0.2.0-mac-x64.zip'])

    const { code, errors } = runMain(releaseDir, fakeTools().exec)

    expect(code).toBe(1)
    expect(errors).toEqual([`::error::${releaseDir} has 1 zip(s) for 2 app(s): each app needs its own zip.`])
  })

  it.each([
    ['verify fails on the packed arm64 app', { 'mac-arm64/Herald OS.app': 'verify' as Fault }, 'mac-arm64/Herald OS.app fails codesign'],
    ['the app in a zip has only linker signatures', { 'herald-zip-[^/]+/Herald OS\\.app': 'linker' as Fault }, "HeraldOS-0.2.0-mac-arm64.zip: Herald OS.app has only the linker's ad hoc signature"],
    ['the packed x64 app has the wrong identifier', { 'mac/Herald OS.app': 'identifier' as Fault }, 'mac/Herald OS.app is signed as Electron']
  ])('exits non-zero when %s', (_name, faults, message) => {
    const releaseDir = makeRelease()

    const { code, errors } = runMain(releaseDir, fakeTools({ faults }).exec)

    expect(code).toBe(1)
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining(message)]))
  })

  it('fails when a helper has only linker signatures, even though the app and codesign --verify pass', () => {
    const releaseDir = makeRelease()

    const { code, errors } = runMain(releaseDir, fakeTools({ faults: { 'mac-arm64/Herald OS.app/Contents/Frameworks/Herald OS Helper.app': 'linker' } }).exec)

    expect(code).toBe(1)
    expect(errors).toEqual([
      "::error::mac-arm64/Herald OS.app: Contents/Frameworks/Herald OS Helper.app has only the linker's ad hoc signature, not one over the bundle.",
      '::error::mac-arm64/Herald OS.app: Contents/Frameworks/Herald OS Helper.app has no sealed resources (no _CodeSignature/CodeResources).',
      '::error::mac-arm64/Herald OS.app: Contents/Frameworks/Herald OS Helper.app does not bind its Info.plist to the signature.'
    ])
  })

  it('fails when a DMG does not mount, and cleans up its mount folder', () => {
    const releaseDir = makeRelease()

    const { code, errors } = runMain(releaseDir, fakeTools({ unmountable: ['HeraldOS-0.2.0-mac-x64.dmg'] }).exec)

    expect(code).toBe(1)
    expect(errors).toEqual(['::error::HeraldOS-0.2.0-mac-x64.dmg does not mount: hdiutil: attach failed - no mountable file systems'])
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  it('fails when a zip does not unpack', () => {
    const releaseDir = makeRelease()

    const { code, errors } = runMain(releaseDir, fakeTools({ unzippable: ['HeraldOS-0.2.0-mac-arm64.zip'] }).exec)

    expect(code).toBe(1)
    expect(errors).toEqual(["::error::HeraldOS-0.2.0-mac-arm64.zip does not unpack: ditto: Couldn't read PKZip signature"])
    expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([])
  })

  it('fails on any other platform', () => {
    const lines: string[] = []

    expect(main({ platform: 'linux', exec: fakeTools().exec, log: line => lines.push(line), build: { appId: APP_ID } })).toBe(1)
    expect(lines).toEqual([expect.stringContaining('needs macOS')])
  })

  it('on a signed build, checks the TeamIdentifier against APPLE_TEAM_ID and rejects ad hoc', () => {
    const releaseDir = makeRelease()

    expect(runMain(releaseDir, fakeTools({ signature: 'developer-id' }).exec, { HERALD_OS_MAC_SIGNED: 'true', APPLE_TEAM_ID: 'ABCDE12345' }).code).toBe(0)
    const wrongTeam = runMain(releaseDir, fakeTools({ signature: 'developer-id' }).exec, { HERALD_OS_MAC_SIGNED: 'true', APPLE_TEAM_ID: 'ZZZZZ99999' })
    expect(wrongTeam.code).toBe(1)
    expect(wrongTeam.errors).toContain('::error::mac-arm64/Herald OS.app has TeamIdentifier ABCDE12345, not ZZZZZ99999.')
    expect(runMain(releaseDir, fakeTools().exec, { HERALD_OS_MAC_SIGNED: 'true' }).errors).toContain(
      '::error::mac-arm64/Herald OS.app is signed ad hoc, but this build should carry the Developer ID signature.'
    )
  })

  it('skips the team check on an ad hoc build', () => {
    const releaseDir = makeRelease()

    expect(runMain(releaseDir, fakeTools().exec, { HERALD_OS_MAC_SIGNED: 'false', APPLE_TEAM_ID: 'ABCDE12345' }).code).toBe(0)
  })
})
