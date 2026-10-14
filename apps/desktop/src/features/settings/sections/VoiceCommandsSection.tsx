import { useStore } from '@nanostores/react'
import { IconMicrophone, IconPlayerPlay, IconRobot, IconShieldCheck } from '@tabler/icons-react'
import { useContext, useMemo } from 'react'
import { GlassButton, GlassCard, Pill } from '../../../components/ui/glass.tsx'
import { deviceNoun, voiceKeyLabel } from '../../../lib/platform-labels.ts'
import { $prefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { type CommandPhrase, type CommandSummary, listCommands, runCommand } from '../../../store/os-commands.ts'
import { useT } from '../../../store/i18n.ts'
import { SectionTitle, SettingsFilterContext } from './shared.tsx'

/*
 * Everything Herald OS can do by voice, generated from the command registry so it can never fall
 * behind the code. Grouped by area; each command shows what to say (slots in angle quotes), what it
 * does, whether it asks first, and a Try button for commands that need no details.
 */

interface Group {
  id: string
  title: string
  prefixes: readonly string[]
}

const GROUPS: readonly Group[] = [
  { id: 'nav', title: 'Open and navigate', prefixes: ['open', 'page', 'overlay', 'sidebar', 'space', 'help'] },
  { id: 'windows', title: 'Windows', prefixes: ['window'] },
  { id: 'typing', title: 'Typing and editing', prefixes: ['text', 'key', 'edit', 'view'] },
  { id: 'hermes', title: 'Hermes, chats and missions', prefixes: ['chat', 'mission', 'agents'] },
  { id: 'build', title: 'Build and watch (Studio)', prefixes: ['build', 'studio'] },
  { id: 'memory', title: 'Memory', prefixes: ['memory'] },
  { id: 'files', title: 'Files', prefixes: ['files', 'file'] },
  { id: 'automations', title: 'Automations', prefixes: ['automation'] },
  { id: 'connections', title: 'Connections', prefixes: ['connection'] },
  { id: 'apps', title: 'Apps and the web', prefixes: ['native', 'web'] },
  { id: 'settings', title: 'Settings and appearance', prefixes: ['settings', 'theme', 'accent', 'motion', 'dock', 'notifications'] },
  { id: 'voice', title: 'Voice', prefixes: ['voice'] }
]

const SLOT_EXAMPLES: Record<string, string> = {
  name: 'missions',
  text: 'hello, how are you',
  query: 'my projects',
  goal: 'tidy my downloads',
  place: 'downloads',
  key: 'enter',
  match: 'tea',
  url: 'news.ycombinator.com',
  title: 'the Herald project',
  section: 'voice',
  theme: 'graphite',
  accent: 'violet',
  engine: 'live'
}

/** Examples that only make sense for one command ("create a website for a hair salon"). */
const COMMAND_SLOT_EXAMPLES: Record<string, string> = {
  'build.start.goal': 'a hair salon',
  'studio.preview.url': 'http://localhost:5173',
  'studio.file.path': 'index.html'
}

const phraseText = (phrase: CommandPhrase) => (typeof phrase === 'string' ? phrase : phrase.phrase)

/** "open {name}" -> parts for rendering the slot as a placeholder. */
function renderPhrase(phrase: string) {
  return phrase.split(/(\{[a-zA-Z]+\})/).map((part, index) => {
    const slot = /^\{([a-zA-Z]+)\}$/.exec(part)

    return slot ? (
      <span key={index} className="rounded bg-accent-soft px-1 text-accent-strong" title={`e.g. "${SLOT_EXAMPLES[slot[1]] ?? slot[1]}"`}>
        {slot[1]}
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  })
}

function groupOf(command: CommandSummary): string {
  const prefix = command.id.split('.')[0]

  return GROUPS.find(group => group.prefixes.includes(prefix))?.id ?? 'hermes'
}

/** An example sentence with the slots filled in, for the section subtitle and tooltips. */
export function exampleFor(command: CommandSummary): string | null {
  const phrase = command.phrases.map(phraseText)[0]

  return phrase ? phrase.replace(/\{([a-zA-Z]+)\}/g, (_match, slot: string) => COMMAND_SLOT_EXAMPLES[`${command.id}.${slot}`] ?? SLOT_EXAMPLES[slot] ?? slot) : null
}

export function VoiceCommandsSection() {
  const t = useT()
  const query = useContext(SettingsFilterContext).trim().toLowerCase()
  const commands = useMemo(() => listCommands({ includeHidden: true }), [])
  const voiceKey = voiceKeyLabel(useStore($prefs).voice.hotkey)
  const matches = (command: CommandSummary) =>
    !query || command.title.toLowerCase().includes(query) || command.description.toLowerCase().includes(query) || command.id.includes(query) || command.phrases.some(p => phraseText(p).toLowerCase().includes(query))

  const spoken = commands.filter(command => command.phrases.length > 0 && matches(command))
  const agentOnly = commands.filter(command => command.phrases.length === 0 && matches(command))

  const tryCommand = async (command: CommandSummary) => {
    const result = await runCommand(command.id, {}, { source: 'palette' })

    if (!result.ok) {
      notify({ title: command.title, body: result.error ?? result.summary, level: 'warn' })
    }
  }

  return (
    <>
      <SectionTitle
        title={t('settings.section.commands')}
        subtitle={voiceKey ? t('settings.commands.subtitleKey', { count: commands.length, key: voiceKey }) : t('settings.commands.subtitle', { count: commands.length })}
      />

      <GlassCard className="settings-item flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-[12px] text-fg-2">
        <span className="flex items-center gap-1.5">
          <IconMicrophone size={14} className="text-accent-strong" /> Instant: runs on this {deviceNoun()}, no tokens
        </span>
        <span className="flex items-center gap-1.5">
          <IconShieldCheck size={14} className="text-warn" /> Asks first: Hermes shows an approval card
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-accent-soft px-1 text-accent-strong">slot</span> say your own words there
        </span>
      </GlassCard>

      {GROUPS.map(group => {
        const items = spoken.filter(command => groupOf(command) === group.id)

        if (items.length === 0) {
          return null
        }

        return (
          <section key={group.id} className="settings-item flex flex-col gap-1.5">
            <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">{group.title}</h3>
            <GlassCard className="flex flex-col divide-y divide-line">
              {items.map(command => (
                <CommandRow key={command.id} command={command} onTry={() => void tryCommand(command)} />
              ))}
            </GlassCard>
          </section>
        )
      })}

      {agentOnly.length > 0 && (
        <section className="settings-item flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 px-0.5 text-[12.5px] font-medium text-fg-2">
            <IconRobot size={14} /> Ask Hermes to do these
          </h3>
          <GlassCard className="flex flex-col divide-y divide-line">
            {agentOnly.map(command => (
              <div key={command.id} className="flex items-start gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg">{command.title}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-fg-3">{command.description}</div>
                </div>
                <code className="shrink-0 font-mono text-[11px] text-fg-4">{command.id}</code>
              </div>
            ))}
          </GlassCard>
        </section>
      )}

      {spoken.length === 0 && agentOnly.length === 0 && <div className="settings-item px-1 text-[12.5px] text-fg-3">No command matches “{query}”.</div>}
    </>
  )
}

function CommandRow({ command, onTry }: { command: CommandSummary; onTry: () => void }) {
  const phrases = command.phrases.map(phraseText)
  const shown = phrases.slice(0, 4)
  const more = phrases.length - shown.length
  const canTry = !command.args.some(arg => arg.required) && command.tier !== 'destructive' && !/^(text|key|edit)\./.test(command.id)

  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-fg">{command.title}</span>
          {command.tier === 'destructive' ? (
            <Pill tone="warn">asks first</Pill>
          ) : command.tier === 'mutate' ? (
            <Pill tone="muted">changes things</Pill>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {shown.map(phrase => (
            <span key={phrase} className="rounded-md border border-line bg-white/5 px-2 py-0.5 text-[12px] text-fg-2">
              “{renderPhrase(phrase)}”
            </span>
          ))}
          {more > 0 && (
            <span className="px-1 py-0.5 text-[11.5px] text-fg-4" title={phrases.slice(4).join(' · ')}>
              +{more} more
            </span>
          )}
        </div>
        <div className="mt-1 text-[12px] leading-snug text-fg-3">{command.description}</div>
      </div>
      {canTry && (
        <GlassButton size="sm" variant="ghost" onClick={onTry} aria-label={`Try ${command.title}`}>
          <IconPlayerPlay />
          Try
        </GlassButton>
      )}
    </div>
  )
}
