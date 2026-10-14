import { useStore } from '@nanostores/react'
import {
  IconActivity,
  IconBattery1,
  IconBox,
  IconBrain,
  IconCheck,
  IconConfetti,
  IconDatabaseExclamation,
  IconDownload,
  IconEar,
  IconEyeOff,
  IconMoodSad,
  IconNote,
  IconPaw,
  IconResize,
  IconRun,
  IconWalk
} from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { PET_DEFAULT_SCALE, type PetMoodKind, type PetNoteKind, type PetReaction } from '../../../shared/pet.ts'
import { GlassButton, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { $connection, gatewayRequest } from '../../store/gateway.ts'
import { useT } from '../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from '../settings/sections/shared.tsx'
import { $petPrefs, petShortcutLabel, selectPet, setPetEnabled, setPetPrefs, setPetScale } from './actions.ts'
import { $petInfo } from './info.ts'

/*
 * Settings > Pet. On or off, which pet and its size are Hermes's `display.pet`, so they change for
 * every Hermes surface; the rest is Herald's. The petdex gallery loads only when the person asks for
 * it, because it reaches petdex.dev.
 */

const REACTIONS: { key: PetReaction; label: string; description: string; icon: ReactNode }[] = [
  { key: 'thinking', label: 'Thinking', description: 'Reads along while Hermes thinks.', icon: <IconBrain /> },
  { key: 'running', label: 'Running', description: 'Runs while a tool runs.', icon: <IconRun /> },
  { key: 'cheering', label: 'Cheering', description: 'Jumps when a turn or a task finishes.', icon: <IconConfetti /> },
  { key: 'drooping', label: 'Drooping', description: 'Droops when something goes wrong.', icon: <IconMoodSad /> },
  { key: 'listening', label: 'Listening', description: 'Perks up when the wake word hears you, and listens.', icon: <IconEar /> }
]

const MOODS: { key: PetMoodKind; label: string; description: string; icon: ReactNode }[] = [
  { key: 'disk', label: 'Disk nearly full', description: 'Looks worried when the disk has little room left.', icon: <IconDatabaseExclamation /> },
  { key: 'battery', label: 'Battery low', description: 'Looks worried when the battery runs low and is not charging.', icon: <IconBattery1 /> }
]

const NOTES: { key: PetNoteKind; label: string; description: string; icon: ReactNode }[] = [
  { key: 'update', label: 'Update ready', description: 'Carries a box when an update is ready to install.', icon: <IconBox /> },
  { key: 'job', label: 'Long job finished', description: 'Brings a note when something Hermes worked on for a while finishes and you were not watching.', icon: <IconNote /> }
]

interface GalleryPet {
  slug: string
  displayName: string
  installed: boolean
  spritesheetUrl?: string
}

const thumbs = new Map<string, Promise<string | null>>()

/** The pet's first idle frame from Hermes (a not-installed one is fetched from petdex for it). */
function thumbFor(slug: string, url?: string): Promise<string | null> {
  const key = `${slug}|${url ?? ''}`
  let pending = thumbs.get(key)

  if (!pending) {
    // A failed request (Hermes still starting) is not kept, so the next look asks again.
    pending = gatewayRequest('pet.thumb', url ? { slug, url } : { slug })
      .then(result => (result.ok && result.dataUri ? result.dataUri : null))
      .catch(() => null)
      .then(value => {
        if (!value) {
          thumbs.delete(key)
        }

        return value
      })
    thumbs.set(key, pending)
  }

  return pending
}

function PetThumb({ slug, url, lazy }: { slug: string; url?: string; lazy?: boolean }) {
  const connection = useStore($connection)
  const [src, setSrc] = useState<string | null>(null)
  const [near, setNear] = useState(!lazy)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (near || !ref.current) {
      return
    }

    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNear(true)
        observer.disconnect()
      }
    })
    observer.observe(ref.current)

    return () => observer.disconnect()
  }, [near])

  useEffect(() => {
    let live = true

    if (near && connection === 'open') {
      void thumbFor(slug, url).then(value => live && setSrc(value))
    }

    return () => {
      live = false
    }
  }, [slug, url, near, connection])

  return (
    <div ref={ref} className="flex size-14 items-center justify-center overflow-hidden rounded-lg bg-white/6">
      {src ? <img src={src} alt="" className="max-h-full max-w-full object-contain" /> : <IconPaw size={18} className="text-fg-4" />}
    </div>
  )
}

function PetCard({ slug, name, url, selected, busy, action, onPick, lazy }: { slug: string; name: string; url?: string; selected?: boolean; busy?: boolean; action: string; onPick: () => void; lazy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy || selected}
      aria-pressed={selected}
      aria-label={`${action} ${name}`}
      className={cn('glass-card glass-card-hover flex w-[104px] flex-col items-center gap-1.5 rounded-xl p-2 text-center disabled:cursor-default', selected && 'glass-card-selected')}
    >
      <PetThumb slug={slug} url={url} lazy={lazy} />
      <span className="w-full truncate text-[12px] text-fg">{name}</span>
      <span className="flex items-center gap-1 text-[11px] text-fg-3">
        {selected ? <IconCheck size={12} className="text-ok" /> : busy ? null : action === 'Install' ? <IconDownload size={12} /> : null}
        {selected ? 'In use' : busy ? 'Working…' : action}
      </span>
    </button>
  )
}

const PAGE = 12

function Gallery({ active, onPicked }: { active: string | null; onPicked: (error: string | null) => void }) {
  const [pets, setPets] = useState<GalleryPet[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [installing, setInstalling] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setProblem(null)
    gatewayRequest('pet.gallery', {})
      .then(result => {
        const list = (result.pets ?? []).map(pet => ({ slug: pet.slug, displayName: pet.displayName, installed: pet.installed, spritesheetUrl: pet.spritesheetUrl }))
        setPets(list)

        if (!list.some(pet => !pet.installed)) {
          setProblem('The petdex gallery did not answer: check the network and try again.')
        }
      })
      .catch(reason => setProblem(errorText(reason)))
      .finally(() => setLoading(false))
  }

  const install = (pet: GalleryPet) => {
    setInstalling(pet.slug)
    selectPet(pet.slug)
      .then(
        () => {
          setPets(current => current?.map(entry => (entry.slug === pet.slug ? { ...entry, installed: true } : entry)) ?? null)
          markSaved()
          onPicked(null)
        },
        reason => onPicked(errorText(reason))
      )
      .finally(() => setInstalling(null))
  }

  if (!pets) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[12px] text-fg-3">The gallery lives at petdex.dev: browsing it and installing a pet reach that site, and nothing else leaves this computer for it. Herald itself ships no pet artwork.</div>
        <div>
          <GlassButton size="sm" onClick={load} disabled={loading}>
            {loading ? 'Loading the gallery…' : 'Browse the petdex gallery'}
          </GlassButton>
        </div>
        {problem && <InlineNote tone="danger">{problem}</InlineNote>}
      </div>
    )
  }

  const needle = query.trim().toLowerCase()
  const matching = pets.filter(pet => !needle || pet.displayName.toLowerCase().includes(needle) || pet.slug.includes(needle))

  return (
    <div className="flex flex-col gap-2.5">
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search the gallery" aria-label="Search the gallery" className="glass-input h-8 w-64 rounded-lg px-2.5 text-[12.5px] outline-none" />
      {problem && <InlineNote tone="warn">{problem}</InlineNote>}
      <div className="flex flex-wrap gap-2">
        {matching.slice(0, shown).map(pet => (
          <PetCard
            key={pet.slug}
            slug={pet.slug}
            name={pet.displayName}
            url={pet.installed ? undefined : pet.spritesheetUrl}
            selected={pet.slug === active}
            busy={installing === pet.slug}
            action={pet.installed ? 'Use' : 'Install'}
            onPick={() => install(pet)}
            lazy
          />
        ))}
      </div>
      {matching.length > shown && (
        <div>
          <GlassButton size="sm" variant="ghost" onClick={() => setShown(count => count + PAGE)}>
            Show more ({matching.length - shown})
          </GlassButton>
        </div>
      )}
    </div>
  )
}

function useScaleDraft(scale: number, commit: (value: number) => void): [number, (value: number) => void] {
  const [draft, setDraft] = useState(scale)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => setDraft(scale), [scale])

  const change = (value: number) => {
    setDraft(value)

    if (timer.current) {
      clearTimeout(timer.current)
    }

    timer.current = setTimeout(() => commit(value), 450)
  }

  return [draft, change]
}

export function PetSection() {
  const t = useT()
  const info = useStore($petInfo)
  const prefs = useStore($petPrefs)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = info.enabled && Boolean(info.slug)

  const run = (key: string, work: Promise<unknown>) => {
    setBusy(key)
    setError(null)
    work.then(
      () => markSaved(),
      reason => setError(errorText(reason))
    ).finally(() => setBusy(null))
  }

  const [scale, setScale] = useScaleDraft(info.scale, value => run('scale', setPetScale(value)))
  const toggles = <K extends string>(group: 'reactions' | 'moods' | 'notes', rows: { key: K; label: string; description: string; icon: ReactNode }[]) =>
    rows.map(row => {
      const current = prefs[group] as Record<K, boolean>

      return (
        <SettingsRow key={row.key} icon={row.icon} label={row.label} description={row.description} keywords={`pet ${group}`}>
          <Toggle checked={current[row.key]} onChange={next => run(`${group}.${row.key}`, setPetPrefs({ [group]: { ...current, [row.key]: next } }))} label={row.label} />
        </SettingsRow>
      )
    })

  return (
    <>
      <SectionTitle title={t('settings.section.pet')} subtitle={t('settings.pet.subtitle')} />

      <SettingsGroup title="The pet">
        <SettingsRow
          icon={<IconPaw />}
          label="Show the pet"
          description={info.installed.length ? (on ? `${info.displayName ?? info.slug} is on, for every Hermes surface.` : 'Off, for every Hermes surface.') : 'No pet is installed yet: pick one from the gallery below.'}
          keywords="pet mascot petdex on off display.pet"
          below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
        >
          <Toggle checked={on} disabled={!info.installed.length || busy === 'enabled'} onChange={next => run('enabled', setPetEnabled(next))} label="Show the pet" />
        </SettingsRow>
        {info.installed.length > 0 && (
          <SettingsRow
            icon={<IconActivity />}
            label="Which pet"
            description="The installed pets; the one you pick shows in every Hermes surface."
            keywords="pet choose select installed"
            below={
              <div className="flex flex-wrap gap-2">
                {info.installed.map(pet => (
                  <PetCard key={pet.slug} slug={pet.slug} name={pet.displayName} selected={on && pet.slug === info.slug} busy={busy === `select.${pet.slug}`} action="Use" onPick={() => run(`select.${pet.slug}`, selectPet(pet.slug))} />
                ))}
              </div>
            }
          />
        )}
        <SettingsRow icon={<IconResize />} label="Size" description={`The pet's size everywhere Hermes shows it (Hermes starts at ${Math.round(PET_DEFAULT_SCALE * 100)}%).`} keywords="pet scale size bigger smaller">
          <input type="range" min={0.15} max={1.2} step={0.01} value={scale} disabled={!info.installed.length} aria-label="Pet size" onChange={event => setScale(Number(event.target.value))} className="w-40 accent-accent" />
          <span className="w-10 text-right text-[12px] text-fg-3 tabular-nums">{Math.round(scale * 100)}%</span>
        </SettingsRow>
        <SettingsRow icon={<IconEyeOff />} label="Put away for now" description={`For a screen share. ${petShortcutLabel()} or the paw in the menu bar does the same.`} keywords="pet hide screen share">
          <Toggle checked={prefs.hidden} onChange={next => run('hidden', setPetPrefs({ hidden: next }))} label="Put away for now" />
        </SettingsRow>
        <SettingsRow icon={<IconWalk />} label="Walk to Hermes's work" description="Sits by the Herald Docs, Sheets, Slides or Canvas window Hermes is working in." keywords="pet follow windows office canvas">
          <Toggle checked={prefs.followWindows} onChange={next => run('follow', setPetPrefs({ followWindows: next }))} label="Walk to Hermes's work" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Reactions">{toggles('reactions', REACTIONS)}</SettingsGroup>

      <SettingsGroup title="Moods and notes">{[...toggles('moods', MOODS), ...toggles('notes', NOTES)]}</SettingsGroup>

      <SettingsGroup title="Petdex gallery">
        <SettingsRow label="Find a pet" description="Install a pet from the public petdex gallery; Hermes keeps it in its pets folder for every Hermes surface." keywords="pet gallery petdex install browse" below={<Gallery active={on ? info.slug : null} onPicked={setError} />} />
      </SettingsGroup>
    </>
  )
}
