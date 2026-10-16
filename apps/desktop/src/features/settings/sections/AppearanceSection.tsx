import { useStore } from '@nanostores/react'
import { IconBrandGit, IconCode, IconDroplet, IconLayoutBottombar, IconPhoto, IconSparkles, IconTypography, IconWand } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { ThemeSummary } from '../../../../shared/theme.ts'
import { GlassButton, GlassCard, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $themes, applyTheme, generateTheme, installThemes, loadThemes } from '../../../store/themes.ts'
import { FlyoverRow } from './FlyoverRow.tsx'
import { MenuBarSettings } from './MenuBarSettings.tsx'
import { useT } from '../../../store/i18n.ts'
import { errorText, Filterable, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

const ACCENTS: { id: 'blue' | 'ice' | 'violet'; label: string; color: string }[] = [
  { id: 'blue', label: 'Blue', color: '#2f7dff' },
  { id: 'ice', label: 'Ice', color: '#4cc2ff' },
  { id: 'violet', label: 'Violet', color: '#7c6cff' }
]

export function AppearanceSection() {
  const t = useT()
  const prefs = useStore($prefs)

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: 'Could not save setting', body: errorText(error), level: 'error' })
    }
  }

  const chooseWallpaper = async () => {
    try {
      const [path] = await window.heraldOS.fs.pickFiles({ directory: false, multiple: false })

      if (path) {
        await save({ wallpaper: `file://${path}` })
      }
    } catch (error) {
      notify({ title: 'Could not choose wallpaper', body: errorText(error), level: 'error' })
    }
  }

  const wallpaperName = prefs.wallpaper ? decodeURIComponent(prefs.wallpaper.replace(/^file:\/\//, '')).split('/').pop() : null

  return (
    <>
      <SectionTitle title={t('settings.section.appearance')} subtitle={t('settings.appearance.subtitle')} />

      <ThemeGallery />
      <ThemeTools />

      <SettingsGroup title="Look">
        <SettingsRow icon={<IconDroplet />} label="Accent" description="The accent colour of the Ocean and Graphite themes (other themes bring their own)." keywords="colour color highlight">
          <div className="flex items-center gap-2" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map(accent => {
              const active = prefs.accent === accent.id

              return (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={accent.label}
                  onClick={() => void save({ accent: accent.id })}
                  className={cn('size-6 rounded-full border border-white/30 transition-transform', active ? 'scale-110 shadow-[0_0_0_2px_var(--color-bg),0_0_0_3.5px_var(--color-fg-3)]' : 'opacity-75 hover:opacity-100')}
                  style={{ background: accent.color }}
                />
              )
            })}
          </div>
        </SettingsRow>
        <SettingsRow icon={<IconPhoto />} label="Wallpaper" description={wallpaperName ? <span className="selectable">{wallpaperName}</span> : 'The living Hermes wallpaper.'} keywords="background image desktop">
          {prefs.wallpaper && (
            <GlassButton size="sm" variant="ghost" onClick={() => void save({ wallpaper: '' })} aria-label="Use Hermes wallpaper">
              Use Hermes wallpaper
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={() => void chooseWallpaper()} aria-label="Choose wallpaper image">
            Choose image…
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <FontSettings />

      <MenuBarSettings />

      <SettingsGroup title="Dock">
        <SettingsRow icon={<IconLayoutBottombar />} label="Automatically hide the Dock" description="The Dock slides away and returns when the cursor reaches the bottom edge." keywords="dock autohide hide show">
          <Toggle checked={prefs.dockAutoHide !== false} onChange={next => void save({ dockAutoHide: next })} label="Automatically hide the Dock" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Motion">
        <SettingsRow icon={<IconSparkles />} label="Reduce motion" description="Collapse non-essential animation across the shell." keywords="animation accessibility">
          <Toggle checked={prefs.reduceMotion} onChange={next => void save({ reduceMotion: next })} label="Reduce motion" />
        </SettingsRow>
        <FlyoverRow />
      </SettingsGroup>
    </>
  )
}

/** Every installed theme as a card of its own colours; choosing one restyles the whole environment. */
function ThemeGallery() {
  const themes = useStore($themes)
  const prefs = useStore($prefs)
  const current = prefs.themeName ?? `herald-${prefs.theme}`
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void loadThemes()
  }, [])

  const choose = async (theme: ThemeSummary) => {
    setBusy(theme.name)

    try {
      await applyTheme(theme.name)
      markSaved()
    } catch (error) {
      notify({ title: `Could not apply ${theme.label}`, body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (themes.length === 0) {
    return null
  }

  return (
    <Filterable label="Theme" description="Choose a theme" keywords="theme dark light colour color look">
      <section className="flex flex-col gap-1.5">
        <h3 className="px-0.5 text-[12.5px] font-medium text-fg-2">Theme</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5" role="radiogroup" aria-label="Theme">
          {themes.map(theme => {
            const active = theme.name === current

            return (
              <GlassCard
                key={theme.name}
                as="button"
                interactive
                selected={active}
                role="radio"
                aria-checked={active}
                aria-label={theme.label}
                data-os-target={`theme:${theme.name}`}
                onClick={() => void choose(theme)}
                className={cn('flex flex-col gap-2 p-2.5 text-left', busy === theme.name && 'opacity-60')}
              >
                <span className="flex h-12 overflow-hidden rounded-md border border-line" style={{ background: theme.colors.bg }} aria-hidden="true">
                  <span className="m-1.5 flex-1 rounded-sm" style={{ background: theme.colors.surface }}>
                    <span className="mx-1.5 mt-1.5 block h-1.5 w-8 rounded-full" style={{ background: theme.colors.fg }} />
                    <span className="mx-1.5 mt-1 block h-1.5 w-12 rounded-full" style={{ background: theme.colors.fg_dim }} />
                  </span>
                  <span className="my-1.5 mr-1.5 w-4 rounded-sm" style={{ background: theme.colors.accent }} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-fg">{theme.label}</span>
                  <span className="block truncate text-[11px] text-fg-3">
                    {theme.scheme === 'light' ? 'Light' : 'Dark'}
                    {theme.source === 'user' ? ' · yours' : ''}
                  </span>
                </span>
              </GlassCard>
            )
          })}
        </div>
      </section>
    </Filterable>
  )
}

function ThemeTools() {
  const prefs = useStore($prefs)
  const [repo, setRepo] = useState('')
  const [working, setWorking] = useState<'generate' | 'install' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const make = async (image?: string) => {
    setError(null)

    try {
      const source = image ?? (await window.heraldOS.fs.pickFiles({ directory: false, multiple: false }))[0]

      if (!source) {
        return
      }

      setWorking('generate')
      const name = await generateTheme({ image: source })
      markSaved()
      notify({ title: 'New theme', body: `${$themes.get().find(theme => theme.name === name)?.label ?? name} is ready and in use.`, level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  const install = async () => {
    setError(null)
    setWorking('install')

    try {
      const names = await installThemes(repo.trim())
      setRepo('')
      notify({ title: 'Themes installed', body: names.join(', '), level: 'success' })
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(null)
    }
  }

  return (
    <SettingsGroup title="Make it yours">
      <SettingsRow
        icon={<IconWand />}
        label="Make a theme from an image"
        description="Herald OS takes the colours of a photo or artwork, makes a complete theme from them, and uses the image as the wallpaper. You can also ask Hermes for one: “make me a calm green theme”."
        keywords="generate create custom wallpaper colours"
        below={error ? <InlineNote tone="danger">{error}</InlineNote> : undefined}
      >
        {prefs.wallpaper && (
          <GlassButton size="sm" variant="ghost" disabled={working !== null} onClick={() => void make(prefs.wallpaper)}>
            From the wallpaper
          </GlassButton>
        )}
        <GlassButton size="sm" disabled={working !== null} onClick={() => void make()}>
          {working === 'generate' ? 'Making…' : 'Choose image…'}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconBrandGit />} label="Install themes from git" description="Paste the https address of a theme repository. Only its colours and images are kept." keywords="download share community">
        <input
          value={repo}
          onChange={event => setRepo(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && repo.trim() && void install()}
          placeholder="https://github.com/…"
          aria-label="Theme repository address"
          className="glass-input h-8 w-56 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
        />
        <GlassButton size="sm" disabled={!repo.trim() || working !== null} onClick={() => void install()}>
          {working === 'install' ? 'Installing…' : 'Install'}
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconSparkles />} label="Follow Hermes skins" description="When you change Hermes's skin with /skin, Herald OS takes on its colours too. Herald's own themes always restyle Hermes." keywords="skin hermes cli tui sync">
        <Toggle
          checked={Boolean(prefs.followHermesSkin)}
          onChange={next => {
            void updatePrefs({ followHermesSkin: next }).then(markSaved)
          }}
          label="Follow Hermes skins"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

function FontSettings() {
  const prefs = useStore($prefs)
  const [families, setFamilies] = useState<string[]>([])

  const loadFamilies = () => {
    if (families.length === 0) {
      void window.heraldOS.fonts
        .list()
        .then(setFamilies)
        .catch(() => undefined)
    }
  }

  const set = (kind: 'ui' | 'mono', value: string) => {
    void updatePrefs({ fonts: { ...prefs.fonts, [kind]: value.trim() || undefined } }).then(markSaved)
  }

  const field = (kind: 'ui' | 'mono', label: string) => (
    <input
      key={`${kind}:${prefs.fonts?.[kind] ?? ''}`}
      defaultValue={prefs.fonts?.[kind] ?? ''}
      list="herald-font-families"
      onFocus={loadFamilies}
      onBlur={event => event.target.value.trim() !== (prefs.fonts?.[kind] ?? '') && set(kind, event.target.value)}
      onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
      placeholder="Default"
      aria-label={label}
      className="glass-input h-8 w-52 rounded-lg px-2.5 text-[12.5px] outline-none placeholder:text-fg-4"
    />
  )

  return (
    <SettingsGroup title="Fonts">
      <datalist id="herald-font-families">
        {families.map(family => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <SettingsRow icon={<IconTypography />} label="Interface font" description="Leave empty for the system font." keywords="font typeface text">
        {field('ui', 'Interface font')}
      </SettingsRow>
      <SettingsRow icon={<IconCode />} label="Code font" description="Used by the terminal and code views." keywords="font monospace terminal code">
        {field('mono', 'Code font')}
      </SettingsRow>
    </SettingsGroup>
  )
}
