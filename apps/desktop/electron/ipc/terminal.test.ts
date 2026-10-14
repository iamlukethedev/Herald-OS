import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))

const { ensureSpawnHelperExecutable, spawnHelperPaths } = await import('./terminal.ts')

describe('spawnHelperPaths', () => {
  it('looks outside app.asar, where a packaged app runs the helper from', () => {
    const resources = '/Applications/Herald OS.app/Contents/Resources'

    expect(spawnHelperPaths(`${resources}/app.asar/node_modules/node-pty/lib/index.js`, 'darwin', 'arm64')).toEqual([
      `${resources}/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`,
      `${resources}/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`
    ])
  })

  it('keeps the path of a checkout, or one already outside the archive', () => {
    expect(spawnHelperPaths('/Users/sam/Herald-OS/node_modules/node-pty/lib/index.js', 'darwin', 'x64')[1]).toBe('/Users/sam/Herald-OS/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper')
    expect(spawnHelperPaths('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/lib/index.js', 'linux', 'arm64')[0]).toBe('/opt/herald-os/resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper')
  })
})

describe('ensureSpawnHelperExecutable', () => {
  let root = ''

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('gives the prebuilt helper back the execute bit npm strips', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-'))
    const pty = path.join(root, 'node_modules', 'node-pty')
    const helper = path.join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, '')
    fs.chmodSync(helper, 0o644)

    ensureSpawnHelperExecutable(path.join(pty, 'lib', 'index.js'))

    expect(fs.statSync(helper).mode & 0o777).toBe(0o755)
  })
})
