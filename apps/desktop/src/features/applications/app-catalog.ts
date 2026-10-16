import type { InstalledApp } from '../../../shared/ipc.ts'
import { type AppCategory, type AppIconId, FEATURED_NATIVE, type HermesAppId, appById, distinctAppLabel } from '../../shell/apps.ts'

/*
 * The launcher catalog: turns the Hermes registry plus the installed macOS apps into one ordered
 * list of tiles, then filters it by category tab and search query. Pure functions, no React.
 */

export type LauncherFilter = 'all' | AppCategory

export const LAUNCHER_FILTERS: readonly { id: LauncherFilter; label: string }[] = [
  { id: 'all', label: 'All apps' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'creative', label: 'Creative' },
  { id: 'development', label: 'Development' },
  { id: 'system', label: 'System' }
]

interface TileBase {
  /** Stable React key; unique even when one Hermes page appears under two labels. */
  key: string
  label: string
  category: AppCategory
  /** Extra search terms beyond the label (the bundle name for aliased native apps). */
  keywords: string[]
}

export interface HermesTile extends TileBase {
  kind: 'hermes'
  appId: HermesAppId
  icon: AppIconId
}

export interface NativeTile extends TileBase {
  kind: 'native'
  app: InstalledApp
}

export type LauncherTile = HermesTile | NativeTile

const STUDIO_NAMES = ['Pixelmator Pro', 'Figma', 'Sketch', 'Affinity Designer', 'Photoshop']

/** The curated head of "All apps", in mockup order. Native slots are hidden when nothing matches. */
type Slot =
  | { kind: 'hermes'; appId: HermesAppId; label?: string; icon?: AppIconId; keywords?: string[] }
  | { kind: 'featured'; label: string }
  | { kind: 'native'; label: string; names: string[]; category: AppCategory }

const ORDER: readonly Slot[] = [
  { kind: 'hermes', appId: 'hermes' },
  { kind: 'hermes', appId: 'files' },
  { kind: 'featured', label: 'Browser' },
  { kind: 'featured', label: 'Mail' },
  { kind: 'featured', label: 'Calendar' },
  { kind: 'featured', label: 'Notes' },
  { kind: 'hermes', appId: 'missions' },
  { kind: 'hermes', appId: 'room', keywords: ['petdex', 'agents', 'helpers', 'activity'] },
  { kind: 'hermes', appId: 'memory' },
  { kind: 'native', label: 'Studio', names: STUDIO_NAMES, category: 'creative' },
  { kind: 'hermes', appId: 'canvas' },
  { kind: 'hermes', appId: 'docs', keywords: ['word', 'document', 'writer', 'markdown'] },
  { kind: 'hermes', appId: 'sheets', keywords: ['excel', 'spreadsheet', 'numbers', 'csv'] },
  { kind: 'hermes', appId: 'slides', keywords: ['powerpoint', 'presentation', 'keynote', 'deck'] },
  { kind: 'hermes', appId: 'calc', keywords: ['calculator', 'math', 'convert', 'units', 'currency', 'graph'] },
  { kind: 'hermes', appId: 'files', label: 'Documents', icon: 'documents' },
  { kind: 'hermes', appId: 'automations' },
  { kind: 'hermes', appId: 'connections' },
  { kind: 'hermes', appId: 'terminal' },
  { kind: 'featured', label: 'Code' },
  { kind: 'featured', label: 'Photos' },
  { kind: 'featured', label: 'Music' },
  { kind: 'featured', label: 'App Store' },
  { kind: 'hermes', appId: 'settings' }
]

const PRODUCTIVITY_TYPES = new Set(['productivity', 'business', 'utilities', 'reference', 'finance'])
const CREATIVE_TYPES = new Set(['graphics-design', 'photography', 'music', 'video', 'entertainment'])

/** Maps an LSApplicationCategoryType onto the launcher's four tabs. */
export function nativeCategory(app: InstalledApp): AppCategory {
  const type = (app.category ?? '').replace('public.app-category.', '')

  if (type === 'developer-tools') {
    return 'development'
  }

  if (PRODUCTIVITY_TYPES.has(type)) {
    return 'productivity'
  }

  if (CREATIVE_TYPES.has(type)) {
    return 'creative'
  }

  return app.path.startsWith('/System') ? 'system' : 'productivity'
}

/** First installed app whose name matches one of the candidates; exact name first, then a loose contains. */
function findFirst(apps: readonly InstalledApp[], names: readonly string[]): InstalledApp | undefined {
  for (const name of names) {
    const exact = apps.find(app => app.name === name)

    if (exact) {
      return exact
    }
  }

  for (const name of names) {
    const needle = name.toLowerCase()
    const loose = apps.find(app => app.name.toLowerCase().includes(needle))

    if (loose) {
      return loose
    }
  }

  return undefined
}

function nativeTile(app: InstalledApp, label: string, category: AppCategory): NativeTile {
  return { kind: 'native', key: `native:${app.path}`, label, category, keywords: label === app.name ? [] : [app.name], app }
}

export function buildCatalog(apps: readonly InstalledApp[]): LauncherTile[] {
  const tiles: LauncherTile[] = []
  const used = new Set<string>()

  const pushNative = (app: InstalledApp | undefined, label: string, category: AppCategory) => {
    if (!app || used.has(app.path)) {
      return
    }

    used.add(app.path)
    tiles.push(nativeTile(app, label, category))
  }

  for (const slot of ORDER) {
    if (slot.kind === 'hermes') {
      const def = appById(slot.appId)
      const label = slot.label ?? def.name
      tiles.push({ kind: 'hermes', key: `hermes:${slot.appId}:${label}`, label, category: def.category, keywords: [...(label === def.name ? [] : [def.name]), ...(slot.keywords ?? [])], appId: slot.appId, icon: slot.icon ?? def.icon })
    } else if (slot.kind === 'featured') {
      const alias = FEATURED_NATIVE.find(entry => entry.label === slot.label)

      if (alias) {
        pushNative(findFirst(apps, alias.names), alias.label, alias.category)
      }
    } else {
      pushNative(findFirst(apps, slot.names), slot.label, slot.category)
    }
  }

  const rest = apps.filter(app => !used.has(app.path)).sort((a, b) => a.name.localeCompare(b.name))
  const taken = new Set(tiles.map(tile => tile.label.toLowerCase()))

  for (const app of rest) {
    pushNative(app, distinctAppLabel(app, taken), nativeCategory(app))
  }

  return tiles
}

export function filterTiles(tiles: readonly LauncherTile[], filter: LauncherFilter, query: string): LauncherTile[] {
  const needle = query.trim().toLowerCase()

  return tiles.filter(tile => {
    if (filter !== 'all' && tile.category !== filter) {
      return false
    }

    if (!needle) {
      return true
    }

    return tile.label.toLowerCase().includes(needle) || tile.keywords.some(keyword => keyword.toLowerCase().includes(needle))
  })
}
