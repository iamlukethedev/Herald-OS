import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkoutRuntime, pathRuntime, pendingInstall, resolveBackendRuntime } from './resolve.ts'

let dir: string

function write(file: string, text: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode })
}

/** A Hermes Agent checkout with its `serve` subcommand and these executables (paths in the checkout). */
function checkout(root: string, executables: string[]): string {
  write(path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py'), '')

  for (const file of executables) {
    write(path.join(root, file), '#!/bin/sh\n', 0o755)
  }

  return root
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-resolve-'))
  vi.stubEnv('HERMES_HOME', path.join(dir, '.hermes'))
  vi.stubEnv('PATH', path.join(dir, 'empty'))
  vi.stubEnv('HERALD_OS_HERMES_ROOT', undefined)
  vi.stubEnv('HERMES_OS_HERMES_ROOT', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('checkoutRuntime', () => {
  it("runs the launcher today's installers publish", () => {
    const root = checkout(path.join(dir, 'agent'), ['.hermes/bin/hermes'])

    expect(checkoutRuntime(root, 'managed', 'managed Hermes install')).toEqual({ kind: 'managed', label: 'managed Hermes install', root, command: [path.join(root, '.hermes', 'bin', 'hermes')] })
  })

  it("runs an earlier installer's venv", () => {
    const root = checkout(path.join(dir, 'agent'), ['venv/bin/python'])

    expect(checkoutRuntime(root, 'env', 'override')?.command).toEqual([path.join(root, 'venv', 'bin', 'python'), '-m', 'hermes_cli.main'])
  })

  it('prefers the launcher when an update left the old venv behind', () => {
    const root = checkout(path.join(dir, 'agent'), ['venv/bin/python', '.hermes/bin/hermes'])

    expect(checkoutRuntime(root, 'managed', 'managed Hermes install')?.command).toEqual([path.join(root, '.hermes', 'bin', 'hermes')])
  })

  it('needs the serve subcommand and something that runs', () => {
    const bare = path.join(dir, 'bare')
    write(path.join(bare, '.hermes', 'bin', 'hermes'), '#!/bin/sh\n', 0o755)
    expect(checkoutRuntime(bare, 'managed', 'x')).toBeNull()

    const cloned = checkout(path.join(dir, 'cloned'), [])
    expect(checkoutRuntime(cloned, 'managed', 'x')).toBeNull()

    // A launcher that cannot run is no launcher; the venv beside it still counts.
    write(path.join(cloned, '.hermes', 'bin', 'hermes'), '#!/bin/sh\n', 0o644)
    expect(checkoutRuntime(cloned, 'managed', 'x')).toBeNull()
    write(path.join(cloned, 'venv', 'bin', 'python'), '#!/bin/sh\n', 0o755)
    expect(checkoutRuntime(cloned, 'managed', 'x')?.command[0]).toBe(path.join(cloned, 'venv', 'bin', 'python'))
  })
})

describe('resolveBackendRuntime', () => {
  it('finds the managed install in either layout', () => {
    const managed = path.join(dir, '.hermes', 'hermes-agent')
    checkout(managed, ['.hermes/bin/hermes'])

    expect(resolveBackendRuntime()).toMatchObject({ kind: 'managed', root: managed, command: [path.join(managed, '.hermes', 'bin', 'hermes')] })

    fs.rmSync(path.join(managed, '.hermes'), { recursive: true })
    checkout(managed, ['venv/bin/python'])
    expect(resolveBackendRuntime()).toMatchObject({ kind: 'managed', command: [path.join(managed, 'venv', 'bin', 'python'), '-m', 'hermes_cli.main'] })
  })

  it('puts HERALD_OS_HERMES_ROOT first', () => {
    checkout(path.join(dir, '.hermes', 'hermes-agent'), ['.hermes/bin/hermes'])
    const own = checkout(path.join(dir, 'own'), ['.hermes/bin/hermes'])
    vi.stubEnv('HERALD_OS_HERMES_ROOT', own)

    expect(resolveBackendRuntime()).toMatchObject({ kind: 'env', root: own })
  })
})

describe('pathRuntime', () => {
  it("finds the installer's ~/.local/bin command when PATH does not name it", () => {
    const bin = path.join(dir, '.local', 'bin')
    write(path.join(bin, 'hermes'), '#!/bin/sh\nexec /home/a/.hermes/hermes-agent/.hermes/bin/hermes "$@"\n', 0o755)

    expect(pathRuntime([])).toBeNull()
    expect(pathRuntime([bin])).toEqual({ kind: 'path', label: `hermes on PATH (${path.join(bin, 'hermes')})`, command: [path.join(bin, 'hermes')] })
  })
})

describe('pendingInstall', () => {
  it("reads the image's note on installing Hermes", () => {
    const note = path.join(dir, 'hermes-pending')
    expect(pendingInstall(note)).toBeNull()

    write(note, 'offline\n')
    expect(pendingInstall(note)).toBe('offline')

    write(note, '')
    expect(pendingInstall(note)).toBe('pending')
  })
})
