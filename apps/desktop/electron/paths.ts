import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { osEnv } from './env.ts'

/** Profile-aware Hermes home; mirrors upstream `get_hermes_home()` for the default profile. */
export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()

  if (override) {
    return override
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
  }

  return path.join(os.homedir(), '.hermes')
}

export function heraldOsDataDir(): string {
  return path.join(hermesHome(), 'herald-os')
}

let packaged: boolean | undefined

/**
 * Main passes `app.isPackaged` as it starts, before any window opens; this module stays free of
 * Electron so the rest of main and its tests can load it alone. Until then nothing is trusted to
 * be a checkout.
 */
export function setPackaged(value: boolean): void {
  packaged = value
}

export function isDev(): boolean {
  return process.env.HERALD_OS_BUILD_MODE === 'development' || Boolean(devServerUrl())
}

/** The dev server to load the shell from. An installed build never does, whatever its environment says. */
export function devServerUrl(env: NodeJS.ProcessEnv = process.env, installed = packaged ?? true): string | undefined {
  return installed ? undefined : osEnv('DEV_SERVER', env)
}

/** The built renderer page. Every electron/ module is bundled into dist/electron/main.mjs. */
export function rendererIndex(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'index.html')
}

/**
 * Whether `url` is the shell's own page: the dev server's origin, or the bundled renderer. Shell
 * windows carry the preload bridge, so they must load nothing else (a dropped HTML file or a stray
 * link would otherwise get it), and only the shell may use the microphone.
 */
export function isShellPage(url: string, index = rendererIndex(), dev: string | undefined = devServerUrl()): boolean {
  try {
    const target = new URL(url)

    if (dev) {
      return target.origin === new URL(dev).origin
    }

    // A file URL with a host (file://server/...) names a file on another machine, whatever its path.
    return target.protocol === 'file:' && target.host === '' && target.pathname === pathToFileURL(index).pathname
  } catch {
    return false
  }
}
