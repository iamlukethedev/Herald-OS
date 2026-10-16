import { useStore } from '@nanostores/react'
import { IconAccessible, IconApps, IconBell, IconCircleCheckFilled, IconPuzzle, IconDatabase, IconGauge, IconInfoCircle, IconListDetails, IconMicrophone, IconPalette, IconPaw, IconPlayerPause, IconRobot, IconSettings, IconShield, IconSofa, IconWifi } from '@tabler/icons-react'
import { type ComponentType, useEffect, useState } from 'react'
import type { TextKey } from '../../../shared/i18n.ts'
import { GlassButton, PageHeader, SearchField } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { pauseAllAgents } from '../../store/agents-control.ts'
import { $chats } from '../../store/chat.ts'
import { useT } from '../../store/i18n.ts'
import { AboutSection } from './sections/AboutSection.tsx'
import { AccessibilitySection, applyAccessibility } from './sections/AccessibilitySection.tsx'
import { AgentsSection } from './sections/AgentsSection.tsx'
import { AppearanceSection } from './sections/AppearanceSection.tsx'
import { GeneralSection } from './sections/GeneralSection.tsx'
import { NetworkSection } from './sections/NetworkSection.tsx'
import { NotificationsSection } from './sections/NotificationsSection.tsx'
import { PrivacySection } from './sections/PrivacySection.tsx'
import { $settingsFocus, $settingsSavedAt, type SectionId, SettingsFilterContext } from './sections/shared.tsx'
import { PluginsSection } from './sections/PluginsSection.tsx'
import { PetSection } from '../pet/PetSection.tsx'
import { RoomSection } from '../room/RoomSection.tsx'
import { SoftwareSection } from './sections/SoftwareSection.tsx'
import { StorageSection } from './sections/StorageSection.tsx'
import { UsageSection } from './sections/UsageSection.tsx'
import { VoiceCommandsSection } from './sections/VoiceCommandsSection.tsx'
import { VoiceSection } from './sections/VoiceSection.tsx'

/*
 * Settings: left nav of sections, right content of grouped rows. A search query replaces the
 * active section with every section stacked; rows filter themselves and empty groups/sections
 * collapse through `:has()`, so the result reads as "matching rows grouped by section".
 */

const SECTIONS: { id: SectionId; label: TextKey; icon: ComponentType<{ size?: number; stroke?: number; className?: string }>; view: ComponentType }[] = [
  { id: 'general', label: 'settings.section.general', icon: IconSettings, view: GeneralSection },
  { id: 'appearance', label: 'settings.section.appearance', icon: IconPalette, view: AppearanceSection },
  { id: 'pet', label: 'settings.section.pet', icon: IconPaw, view: PetSection },
  { id: 'room', label: 'settings.section.room', icon: IconSofa, view: RoomSection },
  { id: 'software', label: 'settings.section.software', icon: IconApps, view: SoftwareSection },
  { id: 'plugins', label: 'settings.section.plugins', icon: IconPuzzle, view: PluginsSection },
  { id: 'agents', label: 'settings.section.agents', icon: IconRobot, view: AgentsSection },
  { id: 'usage', label: 'settings.section.usage', icon: IconGauge, view: UsageSection },
  { id: 'voice', label: 'settings.section.voice', icon: IconMicrophone, view: VoiceSection },
  { id: 'commands', label: 'settings.section.commands', icon: IconListDetails, view: VoiceCommandsSection },
  { id: 'privacy', label: 'settings.section.privacy', icon: IconShield, view: PrivacySection },
  { id: 'notifications', label: 'settings.section.notifications', icon: IconBell, view: NotificationsSection },
  { id: 'network', label: 'settings.section.network', icon: IconWifi, view: NetworkSection },
  { id: 'storage', label: 'settings.section.storage', icon: IconDatabase, view: StorageSection },
  { id: 'accessibility', label: 'settings.section.accessibility', icon: IconAccessible, view: AccessibilitySection },
  { id: 'about', label: 'settings.section.about', icon: IconInfoCircle, view: AboutSection }
]

const SAVED_VISIBLE_MS = 2500

export function SettingsPage() {
  const t = useT()
  const [section, setSection] = useState<SectionId>('agents')
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0

  useEffect(applyAccessibility, [])

  // A command (voice, agent) asked for a section or a search: follow it.
  const focus = useStore($settingsFocus)

  useEffect(() => {
    if (!focus) {
      return
    }

    if (focus.section && SECTIONS.some(item => item.id === focus.section)) {
      setQuery('')
      setSection(focus.section as SectionId)
    }

    if (focus.query !== undefined) {
      setQuery(focus.query)
    }
  }, [focus])

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader icon="settings" title={t('app.settings')} actions={<SearchField value={query} onChange={setQuery} placeholder={t('settings.search')} className="w-[300px]" />} />

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-4">
        <nav className="flex w-[170px] shrink-0 flex-col gap-0.5" aria-label={t('settings.sections')}>
          {SECTIONS.map(item => {
            const active = !searching && item.id === section
            const Icon = item.icon

            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  setQuery('')
                  setSection(item.id)
                }}
                className={cn('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150', active ? 'bg-accent text-accent-fg shadow-[0_4px_16px_rgba(47,125,255,.35)]' : 'text-fg-2 hover:bg-white/6 hover:text-fg')}
              >
                <Icon size={17} stroke={1.7} className="shrink-0" />
                <span className="min-w-0 truncate" title={t(item.label)}>
                  {t(item.label)}
                </span>
              </button>
            )
          })}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <SettingsFilterContext.Provider value={query}>
            <div className="relative min-h-0 flex-1 overflow-y-auto pr-1">
              {searching ? (
                <div className="flex flex-col gap-7 [&:not(:has(.settings-item))>[data-empty]]:flex">
                  {SECTIONS.map(item => {
                    const View = item.view

                    return (
                      <section key={item.id} className="hidden flex-col gap-4 has-[.settings-item]:flex">
                        <View />
                      </section>
                    )
                  })}
                  <div data-empty="" className="hidden flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line px-6 py-10 text-center">
                    <div className="text-[13px] text-fg-2">{t('settings.noMatch', { query: query.trim() })}</div>
                    <div className="text-[12px] text-fg-3">{t('settings.noMatchHint')}</div>
                  </div>
                </div>
              ) : (
                <div key={section} className="page-enter flex flex-col gap-4">
                  <ActiveSection id={section} />
                </div>
              )}
            </div>
          </SettingsFilterContext.Provider>

          <Footer />
        </div>
      </div>
    </div>
  )
}

function ActiveSection({ id }: { id: SectionId }) {
  const View = SECTIONS.find(item => item.id === id)?.view ?? AgentsSection

  return <View />
}

function Footer() {
  const t = useT()
  const savedAt = useStore($settingsSavedAt)
  const [showSaved, setShowSaved] = useState(false)

  useEffect(() => {
    if (!savedAt) {
      return
    }

    setShowSaved(true)
    const timer = setTimeout(() => setShowSaved(false), SAVED_VISIBLE_MS)

    return () => clearTimeout(timer)
  }, [savedAt])

  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-3 pt-2">
      <div className={cn('flex items-center gap-1.5 text-[12px] text-fg-2 transition-opacity duration-300', showSaved ? 'opacity-100' : 'opacity-0')} aria-live="polite">
        <IconCircleCheckFilled size={16} className="text-ok" />
        {t('settings.saved')}
      </div>
      <PauseAllAgents />
    </div>
  )
}

function PauseAllAgents() {
  const t = useT()
  const chats = useStore($chats)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const streaming = Object.values(chats).filter(chat => chat.streaming)

  const pauseAll = async () => {
    setConfirming(false)
    setBusy(true)

    try {
      await pauseAllAgents()
    } finally {
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <div className="animate-pop flex items-center gap-2 text-[12px] text-fg-2">
        <span>{t('settings.pauseConfirm', { count: streaming.length })}</span>
        <GlassButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          {t('settings.cancel')}
        </GlassButton>
        <GlassButton size="sm" variant="danger" onClick={() => void pauseAll()} aria-label={t('settings.pauseConfirmLabel')}>
          {t('settings.pauseEverything')}
        </GlassButton>
      </div>
    )
  }

  return (
    <GlassButton size="sm" onClick={() => setConfirming(true)} disabled={busy} aria-label={t('settings.pauseAll')}>
      <IconPlayerPause />
      {busy ? t('settings.pausing') : t('settings.pauseAll')}
    </GlassButton>
  )
}
