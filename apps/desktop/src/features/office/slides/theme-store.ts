import { atom } from 'nanostores'
import type { FilePreview } from '../../../../shared/ipc.ts'
import { $env } from '../../../store/backend.ts'
import type { Theme } from './deck.ts'
import { normalizeTheme } from './normalize.ts'
import { setCustomThemes } from './themes.ts'

/*
 * Custom slide themes, kept for every deck in one file in Herald's data folder and written whole
 * on every change. Each theme is checked as a deck's theme is when it is read, and its id
 * (`custom-` and its name) never takes a built-in theme's place.
 */

export const THEMES_FORMAT = 'herald-slide-themes'

export const THEMES_VERSION = 1

export interface ThemesFile {
  format: typeof THEMES_FORMAT
  version: typeof THEMES_VERSION
  themes: Theme[]
}

/** The custom themes as last read or written. */
export const $customThemes = atom<readonly Theme[]>([])

export const customThemesPath = (hermesHome: string): string => `${hermesHome.replace(/\/+$/, '')}/herald-os/office/slide-themes.json`

function hermesHome(): string {
  const home = $env.get()?.hermesHome

  if (!home) {
    throw new Error('Hermes home is not known yet.')
  }

  return home
}

const slug = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'theme'

/** `custom-` and the name, numbered on when another theme has it. */
function freeId(name: string, themes: readonly Theme[]): string {
  const base = `custom-${slug(name)}`
  let id = base

  for (let n = 2; themes.some((entry) => entry.id === id); n++) {
    id = `${base}-${n}`
  }

  return id
}

const OWN_ID = /^custom-[a-z0-9-]+$/

async function readThemes(home: string): Promise<Theme[]> {
  const location = customThemesPath(home)

  // Main logs every read that fails, so a file nobody has written yet is not read.
  if ((await window.heraldOS.canvas.exists(location)) !== 'file') {
    return []
  }

  let preview: FilePreview

  try {
    preview = await window.heraldOS.fs.readFile(location)
  } catch (error) {
    if (/ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error))) {
      return []
    }

    throw error
  }

  if (preview.kind !== 'text' || preview.truncated) {
    throw new Error('The custom slide themes file is too large or is not text')
  }

  let data: unknown

  try {
    data = JSON.parse(preview.content ?? '')
  } catch {
    throw new Error('The custom slide themes file is damaged (it is not JSON)')
  }

  const file = typeof data === 'object' && data !== null ? (data as Partial<Record<keyof ThemesFile, unknown>>) : {}

  if (file.format !== THEMES_FORMAT || typeof file.version !== 'number') {
    throw new Error('The custom slide themes file is not a Herald slide themes file')
  }

  if (file.version > THEMES_VERSION) {
    throw new Error('The custom slide themes file was written by a newer Herald')
  }

  const themes: Theme[] = []

  for (const raw of Array.isArray(file.themes) ? file.themes.slice(0, 500) : []) {
    const theme = normalizeTheme(raw)
    themes.push({ ...theme, id: OWN_ID.test(theme.id) && !themes.some((entry) => entry.id === theme.id) ? theme.id : freeId(theme.name, themes) })
  }

  return themes
}

async function writeThemes(home: string, themes: Theme[]): Promise<void> {
  const file: ThemesFile = { format: THEMES_FORMAT, version: THEMES_VERSION, themes }

  await window.heraldOS.fs.writeText(customThemesPath(home), `${JSON.stringify(file, null, 2)}\n`)
}

function publish(themes: Theme[]): Theme[] {
  setCustomThemes(themes)
  $customThemes.set(themes)

  return themes
}

let queue: Promise<unknown> = Promise.resolve()

/** Reads and writes one after another, so a save never writes over another's file. */
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)

  return run
}

/** The custom themes from disk (none when there is no file yet). */
export const loadCustomThemes = (): Promise<Theme[]> => inTurn(async () => publish(await readThemes(hermesHome())))

/**
 * A theme saved among the custom themes, and the theme as saved: under its own id when it is a
 * custom theme's (replacing the one saved before), otherwise under a new `custom-` id from its name.
 */
export const saveCustomTheme = (theme: Theme): Promise<Theme> =>
  inTurn(async () => {
    const home = hermesHome()
    const themes = await readThemes(home)
    const clean = normalizeTheme(theme)
    const at = themes.findIndex((entry) => entry.id === theme.id)
    const saved = { ...clean, id: at >= 0 || OWN_ID.test(theme.id) ? theme.id : freeId(clean.name, themes) }
    const next = at >= 0 ? themes.map((entry, index) => (index === at ? saved : entry)) : [...themes, saved]

    await writeThemes(home, next)
    publish(next)

    return saved
  })

/** A custom theme taken out of the file (nothing happens when there is no such theme). */
export const deleteCustomTheme = (id: string): Promise<void> =>
  inTurn(async () => {
    const home = hermesHome()
    const themes = await readThemes(home)
    const next = themes.filter((entry) => entry.id !== id)

    if (next.length !== themes.length) {
      await writeThemes(home, next)
    }

    publish(next)
  })
