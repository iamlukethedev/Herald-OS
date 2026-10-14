import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MAC_ARCHES, machoArches, macBuildProblems, packScriptProblems } from './check-mac-builds.mjs'

const CPU = { arm64: 0x0100000c, x64: 0x01000007 } as const
type Arch = keyof typeof CPU

/** The first bytes of a thin 64-bit Mach-O file for `arch`. */
function thin(arch: Arch) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
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

  /** What electron-builder leaves for one architecture: release/<dir>/Herald OS.app, a DMG and a zip. */
  function build(dir: string, arch: Arch, { executable = thin(arch), pty = thin(arch) as Buffer | null, helper = true } = {}) {
    const app = path.join(root, dir, 'Herald OS.app', 'Contents')
    write(path.join(app, 'MacOS', 'Herald OS'), executable)
    const prebuild = path.join(app, 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`)
    if (pty) write(path.join(prebuild, 'pty.node'), pty)
    if (helper) write(path.join(prebuild, 'spawn-helper'))
    write(path.join(root, `HeraldOS-0.2.0-mac-${arch}.dmg`))
    write(path.join(root, `HeraldOS-0.2.0-mac-${arch}.zip`))
  }

  it('reads the architecture of thin and universal Mach-O files, and nothing from other files', () => {
    const dir = release()
    write(path.join(dir, 'arm'), thin('arm64'))
    write(path.join(dir, 'intel'), thin('x64'))
    write(path.join(dir, 'both'), universal(['x64', 'arm64']))
    write(path.join(dir, 'script'), '#!/bin/sh\necho hi\n')
    write(path.join(dir, 'empty'))

    expect(machoArches(path.join(dir, 'arm'))).toEqual(['arm64'])
    expect(machoArches(path.join(dir, 'intel'))).toEqual(['x64'])
    expect(machoArches(path.join(dir, 'both'))).toEqual(['x64', 'arm64'])
    expect(machoArches(path.join(dir, 'script'))).toEqual([])
    expect(machoArches(path.join(dir, 'empty'))).toEqual([])
  })

  it('passes an Apple Silicon and an Intel build, each with its own node-pty prebuild', () => {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64')

    expect(macBuildProblems(root)).toEqual([])
  })

  it('asks for the Intel build when only the Apple Silicon one was packaged', () => {
    release()
    build('mac-arm64', 'arm64')

    expect(macBuildProblems(root)).toEqual([
      expect.stringContaining('No Herald OS.app in'),
      expect.stringContaining('No HeraldOS-<version>-mac-x64.dmg'),
      expect.stringContaining('No HeraldOS-<version>-mac-x64.zip')
    ])
    expect(macBuildProblems(root)[0]).toContain('built for x64')
  })

  it('catches an app built for the wrong architecture, so two apps claim the same one', () => {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64', { executable: thin('arm64') })

    expect(macBuildProblems(root)).toEqual([
      'mac/Herald OS.app and mac-arm64/Herald OS.app are both built for arm64.',
      expect.stringContaining('mac/Herald OS.app has no node-pty prebuild for darwin-arm64'),
      expect.stringContaining('mac/Herald OS.app has no darwin-arm64/spawn-helper'),
      expect.stringMatching(/^No Herald OS\.app in .* is built for x64\.$/)
    ])
  })

  it('rejects a universal app, which the per-architecture downloads are not', () => {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64', { executable: universal(['x64', 'arm64']) })

    expect(macBuildProblems(root)[0]).toBe('mac/Herald OS.app is built for x64 and arm64, not exactly one of arm64, x64.')
  })

  it('needs node-pty built for the app it ships in', () => {
    release()
    build('mac-arm64', 'arm64')
    build('mac', 'x64', { pty: thin('arm64') })

    expect(macBuildProblems(root)).toEqual(['mac/Herald OS.app carries a darwin-x64/pty.node built for arm64.'])
  })

  it('names a missing node-pty prebuild or spawn-helper', () => {
    release()
    build('mac-arm64', 'arm64', { helper: false })
    build('mac', 'x64', { pty: null })

    expect(macBuildProblems(root)).toEqual([
      expect.stringContaining('no darwin-arm64/spawn-helper'),
      expect.stringContaining('no node-pty prebuild for darwin-x64')
    ])
  })

  it('reports a release folder that was never written', () => {
    expect(macBuildProblems(path.join(os.tmpdir(), 'no-such-release-folder'))).toEqual([expect.stringContaining('was not packaged')])
  })

  it('needs pack:mac to build every shipped architecture, as the shipped script does', () => {
    const { scripts } = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

    expect(MAC_ARCHES).toEqual(['arm64', 'x64'])
    expect(packScriptProblems(scripts)).toEqual([])
    expect(packScriptProblems({ 'pack:mac': 'electron-builder --mac --arm64 --publish never' })).toEqual(['The pack:mac script does not build --x64.'])
    expect(packScriptProblems({})).toHaveLength(2)
  })
})
