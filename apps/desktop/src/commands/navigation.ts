import { $notificationsOpen, clearNotifications } from '../store/notifications.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { setSidebarCollapsed, toggleSidebar } from '../store/sidebar.ts'
import { $spaces, setActiveSpace } from '../store/spaces.ts'
import { $applicationsOpen, toggleCommandBar } from '../store/surface.ts'
import { $focusedWindowId, $page, $windows, closeWindow, focusWindow, goBackPage, MAIN_WINDOW_ID, minimizeWindow, openApp, showPage, toggleMaximize } from '../store/windows.ts'
import { FLOATING_APPS, type HermesAppId, PAGES, type PageId } from '../shell/apps.ts'
import { focusSettings } from '../features/settings/sections/shared.tsx'

/*
 * Navigation and window commands. Page and app names accept the labels users say ("missions",
 * "the memory page", "terminal") plus a few synonyms; see `resolveAppId`.
 */

const PAGE_ALIASES: Record<string, PageId> = {
  home: 'overview',
  today: 'overview',
  dashboard: 'overview',
  chat: 'hermes',
  conversation: 'hermes',
  conversations: 'hermes',
  sessions: 'hermes',
  mission: 'missions',
  tasks: 'automations',
  automation: 'automations',
  schedules: 'automations',
  cron: 'automations',
  routines: 'automations',
  memories: 'memory',
  notes: 'memory',
  file: 'files',
  finder: 'files',
  folders: 'files',
  documents: 'files',
  connection: 'connections',
  integrations: 'connections',
  tools: 'connections',
  mcp: 'connections',
  preferences: 'settings',
  options: 'settings',
  config: 'settings'
}

const APP_ALIASES: Record<string, HermesAppId> = {
  shell: 'terminal',
  console: 'terminal',
  command: 'terminal',
  monitor: 'system',
  'system monitor': 'system',
  'activity monitor': 'system',
  processes: 'system',
  cpu: 'system',
  popout: 'chat-popout',
  'chat window': 'chat-popout',
  calculator: 'calc'
}

const normalise = (value: string) => value.toLowerCase().replace(/^(the|my)\s+/, '').replace(/\s+(page|tab|window|app|screen|section)$/, '').trim()

/** Resolve a spoken/typed name to a Hermes page or app id. */
export function resolveAppId(name: string): HermesAppId | null {
  const key = normalise(name)

  if (!key) {
    return null
  }

  const page = PAGES.find(p => p.id === key || p.name.toLowerCase() === key)

  if (page) {
    return page.id
  }

  const app = FLOATING_APPS.find(a => a.id === key || a.name.toLowerCase() === key)

  if (app && app.id !== 'web') {
    return app.id
  }

  return PAGE_ALIASES[key] ?? APP_ALIASES[key] ?? null
}

export const APP_NAMES: readonly string[] = [...PAGES.map(p => p.name.toLowerCase()), ...FLOATING_APPS.filter(a => a.id !== 'web' && a.id !== 'chat-popout').map(a => a.name.toLowerCase()), ...Object.keys(PAGE_ALIASES), ...Object.keys(APP_ALIASES)]

function appLabel(id: HermesAppId): string {
  return [...PAGES, ...FLOATING_APPS].find(a => a.id === id)?.name ?? id
}

/** Find an open floating window by app name/title; "this"/"current" means the focused one. */
function resolveWindow(name: string | undefined): { id: string; label: string } | null {
  const windows = Object.values($windows.get()).filter(w => w.phase !== 'closing')
  const key = normalise(name ?? '')

  if (!key || ['this', 'current', 'focused', 'it', 'that', 'this one', 'the window', 'window'].includes(key)) {
    const focused = $focusedWindowId.get()
    const win = focused ? windows.find(w => w.id === focused) : undefined

    return win ? { id: win.id, label: win.id === MAIN_WINDOW_ID ? 'Hermes' : win.title } : null
  }

  const listed = windows.find(w => w.id === name?.trim())

  if (listed) {
    return { id: listed.id, label: listed.id === MAIN_WINDOW_ID ? 'Hermes' : listed.title }
  }

  const appId = resolveAppId(key)
  const win = windows.find(w => (appId && w.appId === appId) || w.title.toLowerCase() === key || w.title.toLowerCase().includes(key))

  return win ? { id: win.id, label: win.id === MAIN_WINDOW_ID ? 'Hermes' : win.title } : null
}

export const navigationCommands: readonly OsCommand[] = [
  {
    id: 'page.open',
    title: 'Open a page or app',
    description: 'Show a Herald OS page (overview, hermes, missions, memory, files, automations, connections, settings) or open an app (terminal, system).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Page or app name', required: true }],
    phrases: ['open the {name} page', 'switch to {name}', 'go to the {name} page'],
    run: ({ name }) => {
      const id = resolveAppId(String(name))

      if (!id) {
        return fail(`I do not know a page or app called "${String(name)}".`)
      }

      openApp(id)
      const label = appLabel(id)
      const page = PAGES.some(p => p.id === id) ? (id as PageId) : undefined

      return ok(`Opened ${label}`, { spoken: `Opening ${label}.`, page, highlight: { kind: 'page', id } })
    }
  },
  {
    id: 'page.current',
    title: 'Which page is open',
    description: 'Report the current page and open windows.',
    tier: 'read',
    args: [],
    phrases: ['where am i', 'what page is this', 'which page is open'],
    hidden: true,
    run: () => {
      const page = $page.get()
      const windows = Object.values($windows.get())
        .filter(w => w.id !== MAIN_WINDOW_ID && w.phase !== 'closing')
        .map(w => ({ id: w.id, app: w.appId, title: w.title, minimized: w.phase === 'minimized' }))

      return ok(`On ${appLabel(page)}${windows.length ? `, with ${windows.map(w => w.title).join(', ')} open` : ''}`, { page, data: { page, windows } })
    }
  },
  {
    id: 'overlay.commandBar',
    title: 'Command bar',
    description: 'Open the command bar (Cmd+K).',
    tier: 'read',
    args: [],
    phrases: ['open the command bar', 'command bar', 'open command palette'],
    run: () => {
      toggleCommandBar(true)

      return ok('Opened the command bar')
    }
  },
  {
    id: 'overlay.applications',
    title: 'Applications',
    description: 'Open the application launcher.',
    tier: 'read',
    args: [],
    phrases: ['open applications', 'show applications', 'open apps', 'open my apps', 'show my apps', 'show all apps', 'open the launcher', 'app launcher'],
    run: () => {
      $applicationsOpen.set(true)

      return ok('Opened Applications')
    }
  },
  {
    id: 'overlay.notifications',
    title: 'Notifications',
    description: 'Open or close the notifications panel.',
    tier: 'read',
    args: [{ name: 'open', type: 'boolean', description: 'true to open, false to close (default: toggle)' }],
    phrases: [
      { phrase: 'show notifications', args: { open: true } },
      { phrase: 'open notifications', args: { open: true } },
      { phrase: 'show my notifications', args: { open: true } },
      { phrase: 'close notifications', args: { open: false } },
      { phrase: 'hide notifications', args: { open: false } }
    ],
    run: ({ open }) => {
      const next = typeof open === 'boolean' ? open : !$notificationsOpen.get()
      $notificationsOpen.set(next)

      return ok(next ? 'Opened notifications' : 'Closed notifications')
    }
  },
  {
    id: 'notifications.clear',
    title: 'Clear notifications',
    description: 'Dismiss every notification.',
    tier: 'act',
    args: [],
    phrases: ['clear notifications', 'clear my notifications', 'dismiss all notifications'],
    run: () => {
      clearNotifications()

      return ok('Cleared notifications')
    }
  },
  {
    id: 'sidebar.toggle',
    title: 'Toggle sidebar',
    description: 'Collapse or expand the sidebar.',
    tier: 'read',
    args: [{ name: 'collapsed', type: 'boolean', description: 'true to collapse, false to expand (default: toggle)' }],
    phrases: [
      'toggle the sidebar',
      { phrase: 'hide the sidebar', args: { collapsed: true } },
      { phrase: 'collapse the sidebar', args: { collapsed: true } },
      { phrase: 'show the sidebar', args: { collapsed: false } },
      { phrase: 'expand the sidebar', args: { collapsed: false } }
    ],
    run: ({ collapsed }) => {
      if (typeof collapsed === 'boolean') {
        setSidebarCollapsed(collapsed)
      } else {
        toggleSidebar()
      }

      return ok('Toggled the sidebar')
    }
  },
  {
    id: 'space.switch',
    title: 'Switch Space',
    description: 'Switch to a Space by name (Personal, Work, Ideas, …).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Space name', required: true }],
    phrases: ['switch to {name} space', 'go to my {name} space', 'open {name} space'],
    run: ({ name }) => {
      const key = String(name).toLowerCase().replace(/\s+space$/, '').trim()
      const space = $spaces.get().find(s => s.id === key || s.name.toLowerCase() === key)

      if (!space) {
        return fail(`No Space called "${String(name)}". Spaces: ${$spaces.get().map(s => s.name).join(', ')}.`)
      }

      setActiveSpace(space.id)

      return ok(`Switched to ${space.name}`, { spoken: `${space.name} space.` })
    }
  },
  {
    id: 'window.fullscreen',
    title: 'Toggle fullscreen',
    description: 'Enter or leave fullscreen.',
    tier: 'act',
    args: [],
    phrases: ['toggle fullscreen', 'go fullscreen', 'fullscreen', 'exit fullscreen', 'leave fullscreen', 'enter fullscreen'],
    run: async () => {
      await window.heraldOS.window.toggleFullscreen()

      return ok('Toggled fullscreen')
    }
  },
  {
    id: 'window.focus',
    title: 'Focus a window',
    description: 'Bring a window to the front (by app name or title).',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list', required: true }],
    phrases: ['focus {name}', 'bring {name} to the front', 'switch to the {name} window'],
    run: ({ name }) => {
      const win = resolveWindow(String(name))

      if (!win) {
        return fail(`No open window matches "${String(name)}".`)
      }

      focusWindow(win.id)

      return ok(`Focused ${win.label}`, { highlight: { kind: 'window', id: win.id } })
    }
  },
  {
    id: 'window.close',
    title: 'Close a window',
    description: 'Close a floating window (the Hermes window minimizes instead).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['close', 'close it', 'close that', 'close this window', 'close window', 'close the window', 'close {name}', 'close the {name} window', 'quit {name}'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? `No open window matches "${String(name)}".` : 'No window is focused.')
      }

      closeWindow(win.id)

      return ok(`Closed ${win.label}`)
    }
  },
  {
    id: 'window.minimize',
    title: 'Minimize a window',
    description: 'Minimize a window to the Dock.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['minimize', 'minimize it', 'minimize this', 'minimize this window', 'minimize the window', 'minimize {name}', 'hide it', 'hide this window', 'hide {name}', 'put it away'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? `No open window matches "${String(name)}".` : 'No window is focused.')
      }

      minimizeWindow(win.id)

      return ok(`Minimized ${win.label}`)
    }
  },
  {
    id: 'window.maximize',
    title: 'Maximize a window',
    description: 'Make a window fill the desktop.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['maximize', 'maximize it', 'maximize this window', 'expand', 'expand it', 'expand this window', 'make it bigger', 'make it full size', 'maximize {name}', 'expand {name}', 'make {name} bigger'],
    run: ({ name }) => {
      const win = resolveWindow(name ? String(name) : undefined)

      if (!win) {
        return fail(name ? `No open window matches "${String(name)}".` : 'No window is focused.')
      }

      if ($windows.get()[win.id]?.maximized) {
        return ok(`${win.label} is already maximized`)
      }

      toggleMaximize(win.id)

      return ok(`Maximized ${win.label}`)
    }
  },
  {
    id: 'window.restore',
    title: 'Restore a window',
    description: 'Bring a minimized window back, or return a maximized one to its normal size.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Window or app name, or an id from window.list; omit for the focused window' }],
    phrases: ['restore', 'restore it', 'restore the window', 'make it smaller', 'shrink it', 'unmaximize', 'restore {name}', 'bring back {name}', 'bring {name} back'],
    run: ({ name }) => {
      const key = name ? String(name) : undefined
      // A minimized window is never focused; look it up by name among all windows.
      const target = key
        ? Object.values($windows.get()).find(w => w.phase !== 'closing' && (resolveAppId(key) === w.appId || w.title.toLowerCase().includes(key.toLowerCase())))
        : (Object.values($windows.get()).find(w => w.id === $focusedWindowId.get()) ?? Object.values($windows.get()).filter(w => w.phase === 'minimized').sort((a, b) => b.z - a.z)[0])

      if (!target) {
        return fail(key ? `No window matches "${key}".` : 'No window to restore.')
      }

      const label = target.id === MAIN_WINDOW_ID ? 'Hermes' : target.title

      if (target.phase === 'minimized' || target.phase === 'minimizing') {
        focusWindow(target.id)

        return ok(`Restored ${label}`)
      }

      if (target.maximized && target.id !== MAIN_WINDOW_ID) {
        toggleMaximize(target.id)

        return ok(`Restored ${label} to its normal size`)
      }

      focusWindow(target.id)

      return ok(`${label} is already at its normal size`)
    }
  },
  {
    id: 'page.back',
    title: 'Go back',
    description: 'Return to the previous page.',
    tier: 'read',
    args: [],
    phrases: ['go back', 'back', 'previous page', 'go to the previous page', 'take me back'],
    run: () => {
      const previous = goBackPage()

      return previous ? ok(`Back to ${appLabel(previous)}`, { page: previous }) : fail('There is no previous page.')
    }
  },
  {
    id: 'help.commands',
    title: 'What can I say',
    description: 'Open the list of every voice command.',
    tier: 'read',
    args: [],
    phrases: ['what can i say', 'what can i ask', 'show voice commands', 'list voice commands', 'show me the commands', 'voice commands', 'help me with voice commands', 'what commands are there'],
    run: () => {
      showPage('settings')
      focusSettings({ section: 'commands' })

      return ok('Opened the voice commands list', { spoken: 'Here is everything you can say.', page: 'settings' })
    }
  },
  {
    id: 'window.list',
    title: 'List windows',
    description: 'List the open windows.',
    tier: 'read',
    args: [],
    phrases: ['what windows are open', 'list windows', 'which windows are open'],
    hidden: true,
    run: () => {
      const windows = Object.values($windows.get())
        .filter(w => w.phase !== 'closing')
        .map(w => ({ id: w.id, app: w.appId, title: w.id === MAIN_WINDOW_ID ? `Hermes (${appLabel($page.get())})` : w.title, minimized: w.phase === 'minimized', focused: w.id === $focusedWindowId.get() }))

      return ok(windows.map(w => w.title).join(', ') || 'No windows', { items: windows })
    }
  },
  {
    id: 'page.showHermes',
    title: 'Show Hermes',
    description: 'Bring the Hermes window to the front on the Hermes page.',
    tier: 'read',
    args: [],
    phrases: ['show hermes', 'open hermes', 'talk to hermes', 'open the chat'],
    hidden: true,
    run: () => {
      showPage('hermes')

      return ok('Opened Hermes', { page: 'hermes' })
    }
  }
]
