import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { hermesHome } from '../paths.ts'

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * A source checkout is usable only with the `serve` subcommand and an install of it, in either layout
 * Hermes Agent's installers leave:
 *   - `.hermes/bin/hermes`, the launcher today's installers publish (it runs the Python and the
 *     dependencies Hermes keeps in $HERMES_HOME/tools and $HERMES_HOME/installs);
 *   - `venv/bin/python`, the virtualenv earlier installers made inside the checkout.
 * The launcher wins: an update to the new layout leaves the old venv behind, unused. `herald-os`
 * (linux/bin/herald-os, `hermes_install`) looks for Hermes the same way.
 */
export function checkoutRuntime(root: string, kind: BackendRuntime['kind'], label: string): BackendRuntime | null {
  if (!fs.existsSync(path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py'))) {
    return null
  }

  const launcher = path.join(root, '.hermes', 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes')

  if (isExecutable(launcher)) {
    return { kind, label, root, command: [launcher] }
  }

  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

  return isExecutable(python) ? { kind, label, root, command: [python, '-m', 'hermes_cli.main'] } : null
}

export function pathRuntime(extraDirs: string[]): BackendRuntime | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean)

  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'hermes.exe' : 'hermes')

    if (isExecutable(candidate)) {
      return { kind: 'path', label: `hermes on PATH (${candidate})`, command: [candidate] }
    }
  }

  return null
}

/**
 * On the Herald OS image, firstboot.sh's note that Hermes Agent is not installed yet because the first
 * start had no network: one word for what herald-os-hermes.service is doing about it (offline,
 * installing, retrying). While it is there the shell waits, rather than start a Hermes that is still
 * being installed and set up.
 */
export const HERMES_PENDING = '/var/lib/herald-os/hermes-pending'

export function pendingInstall(file = HERMES_PENDING): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || 'pending'
  } catch {
    return null
  }
}

/**
 * Ordered ladder. Each rung is validated before it is trusted; a failed read falls to the next.
 *   1. HERALD_OS_HERMES_ROOT (explicit developer override)
 *   2. $HERMES_HOME/hermes-agent managed install, in either layout (what the official installer and
 *      `hermes update` maintain)
 *   3. `hermes` shim on PATH (+ the usual user bin dirs a GUI app does not inherit)
 */
export function resolveBackendRuntime(): BackendRuntime | null {
  const envRoot = osEnv('HERMES_ROOT')?.trim()

  if (envRoot) {
    const runtime = checkoutRuntime(envRoot, 'env', `HERALD_OS_HERMES_ROOT (${envRoot})`)

    if (runtime) {
      return runtime
    }
  }

  const managed = checkoutRuntime(path.join(hermesHome(), 'hermes-agent'), 'managed', 'managed Hermes install')

  if (managed) {
    return managed
  }

  return pathRuntime([path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])
}
