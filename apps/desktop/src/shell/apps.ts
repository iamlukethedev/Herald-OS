import type { ComponentType } from 'react'
import type { TextKey } from '../../shared/i18n.ts'
import type { InstalledApp } from '../../shared/ipc.ts'
import { t } from '../store/i18n.ts'

/** Pages inside the main Hermes window (sidebar navigation). */
export type PageId = 'overview' | 'hermes' | 'missions' | 'memory' | 'files' | 'automations' | 'connections' | 'settings'

/** Apps that open in their own floating window. */
export type FloatingAppId = 'terminal' | 'system' | 'chat-popout' | 'web' | 'studio' | 'capture-editor' | 'camera' | 'widget' | 'canvas' | 'docs' | 'sheets' | 'slides' | 'room' | 'calc'

export type HermesAppId = PageId | FloatingAppId

export type AppCategory = 'productivity' | 'creative' | 'development' | 'system'

export interface HermesAppDef<Id extends HermesAppId = HermesAppId> {
  id: Id
  name: string
  tagline: string
  category: AppCategory
  /** Where the app lives: a page in the main window, or its own floating window. */
  kind: 'page' | 'window'
  /** Codicon-free inline SVG icon id rendered by AppIcon. */
  icon: AppIconId
  defaultSize?: { width: number; height: number }
  shortcut?: string
}

export type AppIconId =
  | 'hermes'
  | 'overview'
  | 'missions'
  | 'memory'
  | 'files'
  | 'automations'
  | 'connections'
  | 'settings'
  | 'terminal'
  | 'system'
  | 'code'
  | 'studio'
  | 'canvas'
  | 'docs'
  | 'sheets'
  | 'slides'
  | 'room'
  | 'calc'
  | 'office'
  | 'documents'
  | 'grid'
  | 'trash'

export const PAGES: readonly HermesAppDef<PageId>[] = [
  { id: 'overview', name: 'Overview', tagline: 'Your day, already in motion.', category: 'productivity', kind: 'page', icon: 'overview', shortcut: '1' },
  { id: 'hermes', name: 'Hermes', tagline: 'Talk to your computer.', category: 'productivity', kind: 'page', icon: 'hermes', shortcut: '2' },
  { id: 'missions', name: 'Missions', tagline: 'From intent to finished work.', category: 'productivity', kind: 'page', icon: 'missions', shortcut: '3' },
  { id: 'memory', name: 'Memory', tagline: 'What Hermes knows, and why.', category: 'productivity', kind: 'page', icon: 'memory', shortcut: '4' },
  { id: 'files', name: 'Files', tagline: 'Everything on this Mac.', category: 'productivity', kind: 'page', icon: 'files', shortcut: '5' },
  { id: 'automations', name: 'Automations', tagline: 'Good routines, handled.', category: 'productivity', kind: 'page', icon: 'automations', shortcut: '6' },
  { id: 'connections', name: 'Connections', tagline: 'Bring your tools into one workspace.', category: 'system', kind: 'page', icon: 'connections', shortcut: '7' },
  { id: 'settings', name: 'Settings', tagline: 'Choose how Hermes works with you.', category: 'system', kind: 'page', icon: 'settings', shortcut: ',' }
]

export const FLOATING_APPS: readonly HermesAppDef<FloatingAppId>[] = [
  { id: 'terminal', name: 'Terminal', tagline: 'A real shell.', category: 'development', kind: 'window', icon: 'terminal', defaultSize: { width: 900, height: 560 }, shortcut: '8' },
  { id: 'system', name: 'System', tagline: 'Monitor and control your Mac.', category: 'system', kind: 'window', icon: 'system', defaultSize: { width: 980, height: 640 }, shortcut: '9' },
  { id: 'chat-popout', name: 'Hermes', tagline: 'A conversation in its own window.', category: 'productivity', kind: 'window', icon: 'hermes', defaultSize: { width: 820, height: 620 } },
  // Opened by the shell for a specific page (e.g. the provider sign-in); not launchable on its own.
  { id: 'web', name: 'Web', tagline: 'A page inside Herald OS.', category: 'productivity', kind: 'window', icon: 'grid', defaultSize: { width: 960, height: 680 } },
  // One per Hermes session; opened with "build …" or "show me the code".
  { id: 'studio', name: 'Studio', tagline: 'Watch Hermes build.', category: 'development', kind: 'window', icon: 'studio', defaultSize: { width: 1280, height: 800 } },
  // Opens on a screenshot (the capture preview's Edit).
  { id: 'capture-editor', name: 'Markup', tagline: 'Draw on a screenshot, hide what is private.', category: 'creative', kind: 'window', icon: 'documents', defaultSize: { width: 960, height: 680 } },
  { id: 'camera', name: 'Camera', tagline: 'Your camera in a bubble, for screen recordings.', category: 'creative', kind: 'window', icon: 'system', defaultSize: { width: 260, height: 290 } },
  // A widget plugin in its own window (its `panel` placement); opened with plugin.open.
  { id: 'widget', name: 'Widget', tagline: 'A widget plugin in a window.', category: 'productivity', kind: 'window', icon: 'grid', defaultSize: { width: 360, height: 280 } },
  { id: 'canvas', name: 'Herald Canvas', tagline: 'Edit images in layers, with Hermes.', category: 'creative', kind: 'window', icon: 'canvas', defaultSize: { width: 1320, height: 840 } },
  { id: 'docs', name: 'Herald Docs', tagline: 'Write and edit documents, with Hermes.', category: 'productivity', kind: 'window', icon: 'docs', defaultSize: { width: 1120, height: 840 } },
  { id: 'sheets', name: 'Herald Sheets', tagline: 'Spreadsheets and formulas, with Hermes.', category: 'productivity', kind: 'window', icon: 'sheets', defaultSize: { width: 1280, height: 820 } },
  { id: 'slides', name: 'Herald Slides', tagline: 'Make presentations, with Hermes.', category: 'productivity', kind: 'window', icon: 'slides', defaultSize: { width: 1280, height: 820 } },
  { id: 'room', name: 'Pet Room', tagline: 'Watch Hermes at work.', category: 'productivity', kind: 'window', icon: 'room', defaultSize: { width: 1100, height: 720 } },
  { id: 'calc', name: 'Herald Calc', tagline: 'Math in plain sentences, exact every time.', category: 'productivity', kind: 'window', icon: 'calc', defaultSize: { width: 780, height: 560 } }
]

/** Floating apps the launcher and command bar offer; the rest open only with a payload. */
export const LAUNCHABLE_APPS: readonly HermesAppDef[] = [...PAGES, ...FLOATING_APPS].filter(app => app.id !== 'chat-popout' && app.id !== 'web' && app.id !== 'studio' && app.id !== 'capture-editor' && app.id !== 'widget')

export const HERMES_APPS: readonly HermesAppDef[] = [...PAGES, ...FLOATING_APPS]

export const appById = (id: HermesAppId): HermesAppDef => HERMES_APPS.find(a => a.id === id) ?? PAGES[0]

const APP_NAMES: Record<HermesAppId, TextKey> = {
  overview: 'app.overview',
  hermes: 'app.hermes',
  missions: 'app.missions',
  memory: 'app.memory',
  files: 'app.files',
  automations: 'app.automations',
  connections: 'app.connections',
  settings: 'app.settings',
  terminal: 'app.terminal',
  system: 'app.system',
  'chat-popout': 'app.chatPopout',
  web: 'app.web',
  studio: 'app.studio',
  'capture-editor': 'app.captureEditor',
  camera: 'app.camera',
  widget: 'app.widget',
  canvas: 'app.canvas',
  docs: 'app.docs',
  sheets: 'app.sheets',
  slides: 'app.slides',
  room: 'app.room',
  calc: 'app.calc'
}

/** An app's name in the language Herald shows; `name` stays English, which commands, voice and the Dock match on. */
export const appName = (app: Pick<HermesAppDef, 'id'>): string => t(APP_NAMES[app.id])

/** Native macOS apps the launcher and dock feature by name; matched against the installed list. */
export interface NativeAppAlias {
  label: string
  /** Candidate bundle names, first match wins. */
  names: string[]
  category: AppCategory
  icon: AppIconId
}

export const FEATURED_NATIVE: readonly NativeAppAlias[] = [
  { label: 'Browser', names: ['Safari', 'Google Chrome', 'Arc', 'Firefox'], category: 'productivity', icon: 'grid' },
  { label: 'Mail', names: ['Mail'], category: 'productivity', icon: 'grid' },
  { label: 'Calendar', names: ['Calendar'], category: 'productivity', icon: 'grid' },
  { label: 'Notes', names: ['Notes'], category: 'productivity', icon: 'grid' },
  { label: 'Code', names: ['Visual Studio Code', 'Cursor', 'Zed', 'Xcode'], category: 'development', icon: 'code' },
  { label: 'Photos', names: ['Photos'], category: 'creative', icon: 'grid' },
  { label: 'Music', names: ['Music', 'Spotify'], category: 'creative', icon: 'grid' },
  { label: 'App Store', names: ['App Store'], category: 'system', icon: 'grid' }
]

/**
 * An installed app's label beside Herald's own: GNOME Files becomes "Files (Nautilus)" next to
 * Herald's Files, named after the last part of its id. `taken` holds lowercase labels already shown.
 */
export function distinctAppLabel(app: Pick<InstalledApp, 'name' | 'bundleId'>, taken: ReadonlySet<string>): string {
  const tail = app.bundleId?.split('.').pop() ?? ''

  if (!taken.has(app.name.toLowerCase()) || !tail || tail.toLowerCase() === app.name.toLowerCase()) {
    return app.name
  }

  return `${app.name} (${tail[0].toUpperCase()}${tail.slice(1)})`
}

export type PageComponent = ComponentType<Record<string, never>>
