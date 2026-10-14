import { useStore } from '@nanostores/react'
import { IconArrowRight, IconBolt, IconMessage, IconSlash } from '@tabler/icons-react'
import { Command } from 'cmdk'
import { useMemo, useState } from 'react'
import { AppGlyph, HermesAvatar } from '../components/app-icon.tsx'
import { Kbd } from '../components/ui/primitives.tsx'
import { cn } from '../lib/cn.ts'
import { shortcutLabel } from '../lib/platform-labels.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { openStoredSession, runSlash, sendPrompt } from '../store/chat.ts'
import { useT } from '../store/i18n.ts'
import { useNativeApps } from '../store/native-apps.ts'
import { notify } from '../store/notifications.ts'
import { listCommands, runCommand } from '../store/os-commands.ts'
import { $sessions } from '../store/sessions.ts'
import { openSurface, relayToMain } from '../store/shell.ts'
import { $applicationsOpen, $commandBarOpen, toggleCommandBar } from '../store/surface.ts'
import { openApp, showPage } from '../store/windows.ts'
import { appName, LAUNCHABLE_APPS } from './apps.ts'
import { useSlashCatalog } from '../features/chat/use-slash-catalog.ts'

/**
 * The global command bar (Cmd+K): type to talk to Hermes, or jump to a page, session, app or slash
 * command. Enter on free text sends it to Hermes and opens the Hermes page.
 */
export function CommandBar() {
  const open = useStore($commandBarOpen)

  if (!open) {
    return null
  }

  const close = () => toggleCommandBar(false)

  return (
    <div className="absolute inset-0 z-(--z-command) flex items-start justify-center bg-black/35 pt-[14vh] backdrop-blur-[2px] animate-fade-in" onMouseDown={close}>
      <CommandPalette onClose={close} className="w-[640px] animate-pop" />
    </div>
  )
}

export interface CommandPaletteProps {
  onClose: () => void
  /**
   * Standalone: the palette lives in its own window (panels mode) with its own gateway connection, so
   * anything that must land in the Hermes window is relayed there instead of run locally.
   */
  standalone?: boolean
  /** Standalone hosts show the launcher themselves; the desktop toggles the overlay store. */
  onApplications?: () => void
  className?: string
}

/** The palette itself, without backdrop: shared by the in-window command bar and the panels-mode overlay. */
export function CommandPalette({ onClose, standalone = false, onApplications, className }: CommandPaletteProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  const sessions = useStore($sessions)
  const slash = useSlashCatalog()
  const { apps } = useNativeApps()

  const close = onClose
  const ask = async (text: string) => {
    close()

    if (standalone) {
      relayToMain({ type: 'send-prompt', text })
      openSurface('main')

      return
    }

    showPage('hermes')

    if (text.startsWith('/')) {
      await runSlash(text)
    } else {
      await sendPrompt(text)
    }
  }

  const openSession = (id: string) => {
    close()

    if (standalone) {
      relayToMain({ type: 'open-session', args: [id] })
      openSurface('main')

      return
    }

    showPage('hermes')
    void openStoredSession(id)
  }

  const applications = () => {
    if (onApplications) {
      onApplications()

      return
    }

    $applicationsOpen.set(true)
    close()
  }

  const trimmed = query.trim()
  const isSlash = trimmed.startsWith('/')
  const needle = trimmed.toLowerCase()
  const matches = (label: string) => !needle || label.toLowerCase().includes(needle)
  // English names match too, so "settings" still finds Settings in any language.
  const filteredApps = useMemo(() => (isSlash ? [] : LAUNCHABLE_APPS.filter(app => matches(app.name) || matches(appName(app)))), [isSlash, needle])
  const filteredSessions = useMemo(() => (isSlash ? [] : sessions.filter(session => matches(session.title ?? session.preview ?? '')).slice(0, 8)), [isSlash, needle, sessions])
  const filteredSlash = useMemo(() => {
    if (!isSlash) {
      return []
    }

    const word = trimmed.slice(1).toLowerCase().split(/\s+/)[0] ?? ''

    return slash.filter(entry => entry.name.toLowerCase().startsWith(word)).slice(0, 12)
  }, [isSlash, slash, trimmed])
  const filteredNative = useMemo(() => {
    if (trimmed.length < 2 || isSlash) {
      return []
    }

    return apps.filter(app => app.name.toLowerCase().includes(needle)).slice(0, 6)
  }, [apps, isSlash, needle, trimmed.length])
  // Registry commands without required arguments run directly; the rest match as intents below.
  const filteredCommands = useMemo(() => {
    if (trimmed.length < 2 || isSlash) {
      return []
    }

    return listCommands()
      .filter(command => !command.hidden && !command.args.some(arg => arg.required))
      .filter(command => command.title.toLowerCase().includes(needle) || command.phrases.some(phrase => (typeof phrase === 'string' ? phrase : phrase.phrase).toLowerCase().includes(needle)))
      .slice(0, 6)
  }, [isSlash, needle, trimmed.length])
  const intent = useMemo(() => (trimmed.length >= 3 && !isSlash ? matchIntent(trimmed) : null), [isSlash, trimmed])

  const runRegistry = async (id: string, args: Record<string, unknown>) => {
    close()

    if (standalone) {
      relayToMain({ type: 'os', args: [id], payload: args })
      openSurface('main')

      return
    }

    const result = await runCommand(id, args, { source: 'palette' })

    if (!result.ok) {
      notify({ title: t('commandBar.failed'), body: result.error ?? result.summary, level: 'warn' })
    }
  }

  return (
    <Command
      label={t('commandBar.label')}
      shouldFilter={false}
      className={cn('float overflow-hidden rounded-2xl', className)}
      onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          close()
        }
      }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <HermesAvatar size={22} rounded={6} />
        <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={t('commandBar.placeholder')} className="h-7 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-4 outline-none" />
        <Kbd>esc</Kbd>
      </div>
      <div className="h-px bg-line" />
      <Command.List className="max-h-[420px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-fg-3 [&_[cmdk-group-heading]]:uppercase">
        {trimmed && (
          <Command.Group heading={t('app.hermes')}>
            <Item value={`ask:${trimmed}`} onSelect={() => void ask(trimmed)} icon={<IconMessage size={15} />} hint="↵">
              {isSlash ? t('commandBar.run', { command: trimmed }) : t('commandBar.ask', { text: trimmed })}
            </Item>
          </Command.Group>
        )}

        {(intent || filteredCommands.length > 0) && (
          <Command.Group heading={t('commandBar.do')}>
            {intent && (
              <Item value={`intent:${intent.command}`} onSelect={() => void runRegistry(intent.command, intent.args)} icon={<IconBolt size={15} />} hint={intent.command}>
                {intent.title}
              </Item>
            )}
            {filteredCommands
              .filter(command => command.id !== intent?.command)
              .map(command => (
                <Item key={command.id} value={`do:${command.id}`} onSelect={() => void runRegistry(command.id, {})} icon={<IconBolt size={15} />} hint={command.id}>
                  {command.title}
                </Item>
              ))}
          </Command.Group>
        )}

        {isSlash && filteredSlash.length > 0 && (
          <Command.Group heading={t('commandBar.commands')}>
            {filteredSlash.map(entry => (
              <Item key={entry.name} value={`slash:${entry.name}`} onSelect={() => void ask(`/${entry.name}`)} icon={<IconSlash size={15} />} hint={entry.description}>
                /{entry.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {filteredNative.length > 0 && (
          <Command.Group heading={t('commandBar.openApp')}>
            {filteredNative.map(app => (
              <Item
                key={app.path}
                value={`app:${app.name}`}
                onSelect={() => {
                  window.heraldOS.apps.launch(app.path).catch(() => undefined)
                  close()
                }}
                icon={<IconArrowRight size={15} />}
                hint={t('commandBar.launch')}
              >
                {app.name}
              </Item>
            ))}
          </Command.Group>
        )}

        {filteredApps.length > 0 && (
          <Command.Group heading={t('commandBar.goTo')}>
            {filteredApps.map(app => (
              <Item
                key={app.id}
                value={`page:${app.name}`}
                onSelect={() => {
                  openApp(app.id)
                  close()
                }}
                icon={<AppGlyph id={app.icon} size={15} />}
                hint={app.shortcut ? shortcutLabel(app.shortcut) : undefined}
              >
                {appName(app)}
              </Item>
            ))}
            <Item value="page:applications" onSelect={applications} icon={<AppGlyph id="grid" size={15} />} hint={shortcutLabel('A', { shift: true })}>
              {t('app.applications')}
            </Item>
          </Command.Group>
        )}

        {filteredSessions.length > 0 && (
          <Command.Group heading={t('commandBar.recentSessions')}>
            {filteredSessions.map(session => (
              <Item key={session.id} value={`session:${session.title ?? session.preview ?? session.id}`} onSelect={() => openSession(session.id)} icon={<IconMessage size={15} />}>
                {session.title || session.preview || t('commandBar.untitledSession')}
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command>
  )
}

function Item({ value, onSelect, icon, hint, children }: { value: string; onSelect: () => void; icon: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[13px] text-fg-2 data-[selected=true]:bg-white/10 data-[selected=true]:text-fg">
      <span className="flex size-5 items-center justify-center text-fg-3">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="max-w-[45%] truncate text-[11px] text-fg-4">{hint}</span>}
    </Command.Item>
  )
}
