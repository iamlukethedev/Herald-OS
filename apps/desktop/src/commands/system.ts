import { LANGUAGES, type LanguageSetting } from '../../shared/i18n.ts'
import type { HeraldOSPrefs, VoiceEngine } from '../../shared/ipc.ts'
import { isPrivacyPane, PRIVACY_PANE_NAMES } from '../../shared/privacy-panes.ts'
import { canOpenPrivacyPanes, openPrivacyPane } from '../lib/privacy-pane.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { $language, setLanguage } from '../store/i18n.ts'
import { $nativeApps, loadNativeApps } from '../store/native-apps.ts'
import { delegate, fail, ok, type OsCommand } from '../store/os-commands.ts'
import { looksLikeFileNotUrl } from './files.ts'
import { endConversation, interruptSpeech, startVoice, toggleMute } from '../store/voice.ts'
import { setWakeWordEnabled } from '../store/wake.ts'
import { openWebWindow } from '../store/web-windows.ts'
import { showPage } from '../store/windows.ts'
import { FEATURED_NATIVE } from '../shell/apps.ts'
import { focusSettings, SETTINGS_SECTION_IDS } from '../features/settings/sections/shared.tsx'

/* Native apps, web pages, settings and the voice layer itself. */

const SECTION_ALIASES: Record<string, string> = {
  agents: 'agents',
  agent: 'agents',
  hermes: 'agents',
  model: 'agents',
  provider: 'agents',
  account: 'agents',
  language: 'general',
  look: 'appearance',
  theme: 'appearance',
  wallpaper: 'appearance',
  colors: 'appearance',
  colours: 'appearance',
  speech: 'voice',
  microphone: 'voice',
  sound: 'voice',
  wifi: 'network',
  'wi-fi': 'network',
  internet: 'network',
  disk: 'storage',
  space: 'storage',
  security: 'privacy',
  permissions: 'privacy',
  alerts: 'notifications',
  'pet room': 'room',
  motion: 'accessibility',
  version: 'about',
  update: 'about',
  billing: 'usage',
  tokens: 'usage',
  credits: 'usage',
  limits: 'usage',
  plan: 'usage'
}

function resolveSection(input: string | undefined): string | null {
  if (!input) {
    return null
  }

  const key = input.toLowerCase().replace(/\s+settings?$/, '').trim()

  return SETTINGS_SECTION_IDS.find(id => id === key) ?? SECTION_ALIASES[key] ?? null
}

async function nativeApps() {
  loadNativeApps()

  if ($nativeApps.get().length === 0) {
    // First call: the list is still loading; wait for it briefly.
    await new Promise<void>(resolve => {
      const off = $nativeApps.subscribe(apps => {
        if (apps.length > 0) {
          off()
          resolve()
        }
      })
      setTimeout(() => {
        off()
        resolve()
      }, 3000)
    })
  }

  return $nativeApps.get()
}

export const systemCommands: readonly OsCommand[] = [
  {
    id: 'native.launch',
    title: 'Launch an app',
    description: 'Launch an installed application by name (Safari, Mail, Notes, …).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Application name', required: true }],
    phrases: ['open the app {name}', 'launch the app {name}', 'start the app {name}'],
    run: async ({ name }) => {
      const apps = await nativeApps()
      const key = String(name).toLowerCase().trim()
      const alias = FEATURED_NATIVE.find(a => a.label.toLowerCase() === key)
      const candidates = alias ? alias.names.map(n => n.toLowerCase()) : [key]
      const app = apps.find(a => candidates.includes(a.name.toLowerCase())) ?? apps.find(a => a.name.toLowerCase().startsWith(key)) ?? apps.find(a => a.name.toLowerCase().includes(key))

      if (!app) {
        return fail(`No installed app called "${String(name)}".`)
      }

      await window.heraldOS.apps.launch(app.path)

      return ok(`Launched ${app.name}`, { spoken: `Opening ${app.name}.`, data: { path: app.path } })
    }
  },
  {
    id: 'web.open',
    title: 'Open a web page',
    description: 'Open a URL in a window inside Herald OS.',
    tier: 'act',
    args: [
      { name: 'url', type: 'string', description: 'URL or domain (https is assumed)', required: true },
      { name: 'title', type: 'string', description: 'Window title' }
    ],
    phrases: ['open the website {url}', 'go to {url}', 'open {url} in a window', 'browse to {url}'],
    run: async ({ url, title }, context) => {
      let target = String(url).trim()

      // "www.hello.pdf" is a mis-heard file name, not a site.
      if (looksLikeFileNotUrl(target)) {
        return delegate('file.open', { name: target }, context)
      }

      if (!/^https?:\/\//i.test(target)) {
        if (!/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target)) {
          return fail(`"${target}" does not look like a web address.`)
        }

        target = `https://${target}`
      }

      const id = await openWebWindow(target, { title: title ? String(title) : undefined })

      return ok(`Opened ${target}`, { spoken: 'Opening it in a window.', highlight: { kind: 'window', id: String(id) }, data: { url: target } })
    }
  },
  {
    id: 'settings.open',
    title: 'Open Settings',
    description: 'Open Settings, optionally at a section (general, appearance, pet, room, agents, usage, voice, privacy, notifications, network, storage, accessibility, about).',
    tier: 'read',
    args: [
      { name: 'section', type: 'string', description: 'Section name' },
      { name: 'query', type: 'string', description: 'Search inside Settings' }
    ],
    phrases: ['open settings', 'open {section} settings', 'show {section} settings', 'go to {section} settings', 'search settings for {query}'],
    run: ({ section, query }) => {
      const id = resolveSection(section ? String(section) : undefined)

      if (section && !id) {
        return fail(`No settings section called "${String(section)}". Sections: ${SETTINGS_SECTION_IDS.join(', ')}.`)
      }

      showPage('settings')
      focusSettings({ section: id ?? undefined, query: query ? String(query) : undefined })

      return ok(id ? `Opened ${id} settings` : 'Opened Settings', { page: 'settings', highlight: id ? { kind: 'setting', id } : undefined })
    }
  },
  {
    id: 'privacy.openPane',
    title: 'Open a Privacy & Security pane',
    description: 'Open the list in macOS System Settings > Privacy & Security where Herald OS is allowed a permission (microphone, camera, calendars, screen, accessibility, automation).',
    tier: 'read',
    hidden: true,
    args: [{ name: 'pane', type: 'string', description: 'The permission', required: true, enum: PRIVACY_PANE_NAMES }],
    run: async ({ pane }) => {
      if (!canOpenPrivacyPanes()) {
        return fail('System Settings panes exist only on macOS.')
      }

      if (!isPrivacyPane(pane)) {
        return fail(`No Privacy & Security pane called "${String(pane)}". Panes: ${PRIVACY_PANE_NAMES.join(', ')}.`)
      }

      await openPrivacyPane(pane)

      return ok(`Opened System Settings > Privacy & Security > ${pane}`)
    }
  },
  {
    id: 'language.set',
    title: 'Set the language',
    description: 'Show Herald OS in English, Brazilian Portuguese (Português (Brasil)) or Simplified Chinese (简体中文), or follow the system languages again (the default).',
    tier: 'mutate',
    // pt-BR: its phrases stay English, like every voice phrase.
    args: [
      {
        name: 'language',
        type: 'string',
        description: 'system, en (English), pt-BR (Brazilian Portuguese) or zh-CN (Simplified Chinese)',
        required: true,
        enum: ['system', 'en', 'pt-BR', 'zh-CN']
      }
    ],
    phrases: [
      { phrase: 'switch to english', args: { language: 'en' } },
      { phrase: 'use english', args: { language: 'en' } },
      { phrase: 'set the language to english', args: { language: 'en' } },
      { phrase: 'switch to portuguese', args: { language: 'pt-BR' } },
      { phrase: 'use portuguese', args: { language: 'pt-BR' } },
      { phrase: 'set the language to portuguese', args: { language: 'pt-BR' } },
      { phrase: 'switch to brazilian portuguese', args: { language: 'pt-BR' } },
      { phrase: 'switch to chinese', args: { language: 'zh-CN' } },
      { phrase: 'use chinese', args: { language: 'zh-CN' } },
      { phrase: 'set the language to chinese', args: { language: 'zh-CN' } },
      { phrase: 'use the system language', args: { language: 'system' } },
      { phrase: 'follow the system language', args: { language: 'system' } }
    ],
    run: async ({ language }) => {
      const setting = language as LanguageSetting
      await setLanguage(setting)
      const shown = LANGUAGES.find(entry => entry.id === $language.get())?.name

      return ok(setting === 'system' ? `Herald OS follows the system language: ${shown}` : `Herald OS is in ${shown}`, { highlight: { kind: 'setting', id: 'general' } })
    }
  },
  {
    id: 'accent.set',
    title: 'Set the accent colour',
    description: 'Switch the accent colour (blue, ice or violet).',
    tier: 'mutate',
    args: [{ name: 'accent', type: 'string', description: 'Accent name', required: true, enum: ['blue', 'ice', 'violet'] }],
    phrases: ['set the accent to {accent}', 'make the accent {accent}', 'change the accent color to {accent}'],
    run: async ({ accent }) => {
      // An accent belongs to the Ocean and Graphite presets; a theme with its own colours steps aside.
      const preset = $prefs.get().theme
      await updatePrefs({ accent: accent as HeraldOSPrefs['accent'], themeColors: undefined, themeScheme: undefined, themeName: `herald-${preset}` })

      return ok(`Accent set to ${String(accent)}`, { highlight: { kind: 'setting', id: 'appearance' } })
    }
  },
  {
    id: 'motion.reduce',
    title: 'Reduce motion',
    description: 'Turn reduced motion on or off.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to reduce motion', required: true }],
    phrases: [
      { phrase: 'turn on reduce motion', args: { enabled: true } },
      { phrase: 'reduce motion', args: { enabled: true } },
      { phrase: 'turn off reduce motion', args: { enabled: false } },
      { phrase: 'enable animations', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ reduceMotion: Boolean(enabled) })

      return ok(`Reduce motion ${enabled ? 'on' : 'off'}`, { highlight: { kind: 'setting', id: 'accessibility' } })
    }
  },
  {
    id: 'dock.autoHide',
    title: 'Dock auto-hide',
    description: 'Hide the Dock until the cursor reaches the bottom edge, or keep it visible.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to auto-hide', required: true }],
    phrases: [
      { phrase: 'hide the dock', args: { enabled: true } },
      { phrase: 'auto hide the dock', args: { enabled: true } },
      { phrase: 'show the dock', args: { enabled: false } },
      { phrase: 'keep the dock visible', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ dockAutoHide: Boolean(enabled) })

      return ok(`Dock auto-hide ${enabled ? 'on' : 'off'}`)
    }
  },
  {
    id: 'voice.engine.set',
    title: 'Voice engine',
    description: 'Choose the voice engine: chained (free) or live (GPT-Live, paid).',
    tier: 'mutate',
    args: [{ name: 'engine', type: 'string', description: 'chained or live', required: true, enum: ['chained', 'live'] }],
    phrases: [
      { phrase: 'use the free voice engine', args: { engine: 'chained' } },
      { phrase: 'switch to the free voice engine', args: { engine: 'chained' } },
      { phrase: 'switch to the live voice engine', args: { engine: 'live' } },
      { phrase: 'use live voice', args: { engine: 'live' } }
    ],
    run: async ({ engine }) => {
      const prefs = $prefs.get().voice
      await updatePrefs({ voice: { ...prefs, engine: engine as VoiceEngine } })

      return ok(`Voice engine set to ${String(engine)}`, { highlight: { kind: 'setting', id: 'voice' } })
    }
  },
  {
    id: 'voice.wake.set',
    title: 'Wake word',
    description: 'Turn the "hey hermes" wake word on or off.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to listen for the wake word', required: true }],
    phrases: [
      { phrase: 'turn on the wake word', args: { enabled: true } },
      { phrase: 'enable hey hermes', args: { enabled: true } },
      { phrase: 'turn off the wake word', args: { enabled: false } },
      { phrase: 'stop listening for hey hermes', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await setWakeWordEnabled(Boolean(enabled))

      return ok(`Wake word ${enabled ? 'on' : 'off'}`, { highlight: { kind: 'setting', id: 'voice' } })
    }
  },
  {
    id: 'voice.start',
    title: 'Start a voice conversation',
    description: 'Open the microphone and talk to Hermes.',
    tier: 'act',
    args: [],
    phrases: ['start listening', 'talk to me'],
    hidden: true,
    run: async () => {
      await startVoice('command')

      return ok('Listening')
    }
  },
  {
    id: 'voice.stop',
    title: 'End the voice conversation',
    description: 'Close the microphone and end the conversation.',
    tier: 'read',
    args: [],
    phrases: ['stop listening', 'end the conversation', 'goodbye hermes'],
    hidden: true,
    run: async () => {
      await endConversation('user')

      return ok('Conversation ended')
    }
  },
  {
    id: 'voice.mute',
    title: 'Mute the microphone',
    description: 'Mute or unmute the microphone during a conversation.',
    tier: 'read',
    args: [],
    phrases: ['mute', 'mute the microphone', 'unmute'],
    hidden: true,
    run: () => {
      toggleMute()

      return ok('Toggled mute')
    }
  },
  {
    id: 'voice.quiet',
    title: 'Stop talking',
    description: 'Cut the current spoken reply short.',
    tier: 'read',
    args: [],
    phrases: ['be quiet', 'stop talking', 'shush', 'enough'],
    hidden: true,
    run: () => {
      interruptSpeech()

      return ok('Stopped speaking')
    }
  }
]
