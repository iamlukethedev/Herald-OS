import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MAC_ARCHES, machO, macBuildProblems, packScriptProblems } from './check-mac-builds.mjs'

const CPU = { arm64: 0x0100000c, x64: 0x01000007, i386: 0x00000007, arm: 0x0000000c } as const
type Arch = keyof typeof CPU

/** The first bytes of a thin Mach-O file for `arch`: 64-bit, or 32-bit with `bits: 32`. */
function thin(arch: Arch, bits: 32 | 64 = 64) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(bits === 64 ? 0xfeedfacf : 0xfeedface, 0)
  header.writeUInt32LE(CPU[arch], 4)
  return header
}

/** The first bytes of a universal Mach-O file holding each of `arches`. */
function universal(arches: Arch[]) {
  const header = Buffer.alloc(8 + arches.length * 20)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(arches.length, 4)
  arches.forEach((arch, i) => header.writeUInt32BE(CPU[arch], 8 + i * 20))
  return header
}

const VERSION = '0.2.0'
const CONTENTS = 'Herald OS.app/Contents'
const UNPACKED = `${CONTENTS}/Resources/app.asar.unpacked/node_modules/node-pty`
const FRAMEWORK = `${CONTENTS}/Frameworks/Electron Framework.framework`
/** How a problem names a file in the Intel app at release/mac/. */
const inMac = (rel: string) => `mac/Herald OS.app: ${path.relative('Herald OS.app', rel)}`
const HELPER = `${CONTENTS}/Frameworks/Herald OS Helper (GPU).app/Contents/MacOS/Herald OS Helper (GPU)`

describe('check-mac-builds', () => {
  let root = ''

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function release() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-builds-'))
    return root
  }

  function write(file: string, contents: Buffer | string = '') {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }

  /**
   * What electron-builder leaves for one architecture: release/<dir>/Herald OS.app with Electron's
   * framework and a helper app, both node-pty darwin prebuilds and a Windows one, plus this
   * version's DMG and zip. `files` replaces (or, with null, removes) files inside release/<dir>/.
   */
  function build(dir: string, arch: 'arm64' | 'x64', files: Record<string, Buffer | string | null> = {}) {
    const at = (rel: string) => path.join(root, dir, rel)
    const layout: Record<string, Buffer | string | null> = {
      [`${CONTENTS}/MacOS/Herald OS`]: thin(arch),
      [`${CONTENTS}/Info.plist`]: '<plist/>',
      [`${FRAMEWORK}/Versions/A/Electron Framework`]: thin(arch),
      [`${FRAMEWORK}/Versions/A/Libraries/libffmpeg.dylib`]: thin(arch),
      [HELPER]: thin(arch),
      [`${CONTENTS}/Resources/app.asar`]: 'asar',
      [`${UNPACKED}/prebuilds/darwin-arm64/pty.node`]: thin('arm64'),
      [`${UNPACKED}/prebuilds/darwin-arm64/spawn-helper`]: thin('arm64'),
      [`${UNPACKED}/prebuilds/darwin-x64/pty.node`]: thin('x64'),
      [`${UNPACKED}/prebuilds/darwin-x64/spawn-helper`]: thin('x64'),
      [`${UNPACKED}/prebuilds/win32-x64/pty.node`]: 'MZ',
      [`${UNPACKED}/lib/index.js`]: 'module.exports = {}',
      ...files
    }
    for (const [rel, contents] of Object.entries(layout)) if (contents !== null) write(at(rel), contents)
    fs.symlinkSync('A', at(`${FRAMEWORK}/Versions/Current`))
    fs.symlinkSync('Versions/Current/Electron Framework', at(`${FRAMEWORK}/Electron Framework`))
    write(path.join(root, `HeraldOS-${VERSION}-mac-${arch}.dmg`))
    write(path.join(root, `HeraldOS-${VERSION}-mac-${arch}.zip`))
  }

  const check = () => macBuildProblems(root, { version: VERSION })

  /** An arm64 build and an x64 one, with `files` applied to the x64 app in release/mac/. */
  function pair(files: Record<string, Buffer | string | null> = {}) {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64', files)
    return check()
  }

  it('reads thin, 32-bit and universal Mach-O files, and nothing from other files', () => {
    const dir = release()
    const files: Record<string, Buffer | string> = {
      arm: thin('arm64'),
      intel: thin('x64'),
      i386: thin('i386', 32),
      arm32: thin('arm', 32),
      both: universal(['x64', 'arm64']),
      java: Buffer.from('cafebabe00000034', 'hex'),
      script: '#!/bin/sh\necho hi\n',
      empty: ''
    }
    for (const [name, contents] of Object.entries(files)) write(path.join(dir, name), contents)

    expect(machO(path.join(dir, 'arm'))).toEqual({ fat: false, arches: ['arm64'] })
    expect(machO(path.join(dir, 'intel'))).toEqual({ fat: false, arches: ['x64'] })
    expect(machO(path.join(dir, 'i386'))).toEqual({ fat: false, arches: ['i386 (32-bit)'] })
    expect(machO(path.join(dir, 'arm32'))).toEqual({ fat: false, arches: ['arm (32-bit)'] })
    expect(machO(path.join(dir, 'both'))).toEqual({ fat: true, arches: ['x64', 'arm64'] })
    expect(machO(path.join(dir, 'java'))).toBeNull()
    expect(machO(path.join(dir, 'script'))).toBeNull()
    expect(machO(path.join(dir, 'empty'))).toBeNull()
  })

  it('passes an Apple Silicon and an Intel build that both carry both darwin prebuilds, each in its own folder', () => {
    expect(pair()).toEqual([])
  })

  it('catches an arm64 spawn-helper in the darwin-x64 prebuild', () => {
    expect(pair({ [`${UNPACKED}/prebuilds/darwin-x64/spawn-helper`]: thin('arm64') })).toEqual([
      `${inMac(path.join(UNPACKED, 'prebuilds/darwin-x64/spawn-helper'))} is arm64, not x64 alone.`
    ])
  })

  it('catches an arm64 Electron Framework in the Intel app', () => {
    expect(pair({ [`${FRAMEWORK}/Versions/A/Electron Framework`]: thin('arm64') })).toEqual([
      `${inMac(path.join(FRAMEWORK, 'Versions/A/Electron Framework'))} is arm64, not x64 alone.`
    ])
  })

  it('catches an arm64 helper app in the Intel app', () => {
    expect(pair({ [HELPER]: thin('arm64') })).toEqual([`${inMac(HELPER)} is arm64, not x64 alone.`])
  })

  it('catches an arm64 build/Release/pty.node, which node-pty loads before any prebuild', () => {
    expect(pair({ [`${UNPACKED}/build/Release/pty.node`]: thin('arm64') })).toEqual([
      `${inMac(path.join(UNPACKED, 'build/Release/pty.node'))} is arm64, not x64 alone.`
    ])
  })

  it('catches a build/Release/pty.node that is not a Mac binary at all', () => {
    expect(pair({ [`${UNPACKED}/build/Release/pty.node`]: '\x7fELF' })).toEqual([
      `${inMac(path.join(UNPACKED, 'build/Release/pty.node'))} is not a Mac binary, but node would load it on x64.`
    ])
  })

  it('catches any other arm64 native module, inside app.asar.unpacked or outside it', () => {
    expect(
      pair({
        [`${CONTENTS}/Resources/app.asar.unpacked/node_modules/other/build/Release/other.node`]: thin('arm64'),
        [`${CONTENTS}/Resources/tool.node`]: thin('arm64')
      })
    ).toEqual([
      `${inMac(path.join(CONTENTS, 'Resources/app.asar.unpacked/node_modules/other/build/Release/other.node'))} is arm64, not x64 alone.`,
      `${inMac(path.join(CONTENTS, 'Resources/tool.node'))} is arm64, not x64 alone.`
    ])
  })

  it('rejects universal binaries, a universal pty.node in darwin-x64 included', () => {
    expect(
      pair({
        [`${UNPACKED}/prebuilds/darwin-x64/pty.node`]: universal(['x64', 'arm64']),
        [`${FRAMEWORK}/Versions/A/Libraries/libffmpeg.dylib`]: universal(['x64', 'arm64'])
      })
    ).toEqual([
      `${inMac(path.join(FRAMEWORK, 'Versions/A/Libraries/libffmpeg.dylib'))} is universal (x64 and arm64), not x64 alone.`,
      `${inMac(path.join(UNPACKED, 'prebuilds/darwin-x64/pty.node'))} is universal (x64 and arm64), not x64 alone.`
    ])
  })

  it('names a 32-bit binary as 32-bit', () => {
    expect(pair({ [HELPER]: thin('i386', 32) })).toEqual([`${inMac(HELPER)} is i386 (32-bit), not x64 alone.`])
  })

  it('checks the other darwin prebuild against its own folder, not the app', () => {
    expect(pair({ [`${UNPACKED}/prebuilds/darwin-arm64/pty.node`]: thin('x64') })).toEqual([
      `${inMac(path.join(UNPACKED, 'prebuilds/darwin-arm64/pty.node'))} is x64, not arm64 alone.`
    ])
  })

  it('needs the DMG and zip of the version in package.json, and refuses a leftover from another one', () => {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64')
    fs.renameSync(path.join(root, `HeraldOS-${VERSION}-mac-x64.dmg`), path.join(root, 'HeraldOS-0.1.9-mac-x64.dmg'))

    expect(check()).toEqual([
      `No HeraldOS-${VERSION}-mac-x64.dmg in ${root}.`,
      `HeraldOS-0.1.9-mac-x64.dmg in ${root} is not this build's (${VERSION}); it would be uploaded with it.`
    ])
    expect(macBuildProblems(root, {})).toEqual([expect.stringContaining('No version')])
  })

  it('asks for the Intel build when only the Apple Silicon one was packaged', () => {
    release()
    build('mac-arm64', 'arm64')
    fs.rmSync(path.join(root, `HeraldOS-${VERSION}-mac-arm64.zip`))

    expect(check()).toEqual([
      `No HeraldOS-${VERSION}-mac-arm64.zip in ${root}.`,
      `No Herald OS.app in ${root} is built for x64.`,
      `No HeraldOS-${VERSION}-mac-x64.dmg in ${root}.`,
      `No HeraldOS-${VERSION}-mac-x64.zip in ${root}.`
    ])
  })

  it('catches an Intel app whose main binary is arm64, so two apps claim arm64', () => {
    const problems = pair({ [`${CONTENTS}/MacOS/Herald OS`]: thin('arm64') })

    expect(problems).toContain('mac/Herald OS.app and mac-arm64/Herald OS.app are both built for arm64.')
    expect(problems).toContain(`No Herald OS.app in ${root} is built for x64.`)
    expect(problems).toContain(`${inMac(HELPER)} is x64, not arm64 alone.`)
  })

  it('rejects a universal main binary', () => {
    expect(pair({ [`${CONTENTS}/MacOS/Herald OS`]: universal(['x64', 'arm64']) })[0]).toBe(
      'mac/Herald OS.app is universal (x64 and arm64), not exactly one of arm64, x64.'
    )
  })

  it('names a missing node-pty prebuild or spawn-helper', () => {
    release()
    build('mac-arm64', 'arm64', { [`${UNPACKED}/prebuilds/darwin-arm64/spawn-helper`]: null })
    build('mac', 'x64', { [`${UNPACKED}/prebuilds/darwin-x64/pty.node`]: null })

    expect(check()).toEqual([expect.stringContaining('no darwin-arm64/spawn-helper'), expect.stringContaining('no node-pty prebuild for darwin-x64')])
  })

  it('reports a release folder that was never written', () => {
    expect(macBuildProblems(path.join(os.tmpdir(), 'no-such-release-folder'), { version: VERSION })).toEqual([expect.stringContaining('was not packaged')])
  })

  it('needs pack:mac to build every shipped architecture, and the Mac build to leave node-pty build/ out', () => {
    const { scripts, build: config } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

    expect(MAC_ARCHES).toEqual(['arm64', 'x64'])
    expect(packScriptProblems(scripts)).toEqual([])
    expect(packScriptProblems({ 'pack:mac': 'electron-builder --mac --arm64 --publish never' })).toEqual(['The pack:mac script does not build --x64.'])
    expect(packScriptProblems({})).toHaveLength(2)
    expect(config.mac.files).toContain('!**/node_modules/node-pty/build/**')
  })
})
