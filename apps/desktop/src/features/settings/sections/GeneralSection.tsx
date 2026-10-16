import { useStore } from '@nanostores/react'
import { IconCoffee, IconDeviceDesktop, IconDeviceDesktopOff, IconFolder, IconKeyboard, IconLanguage, IconLock, IconMaximize, IconMessage, IconMicrophone, IconMoodSmile, IconMoon, IconPower, IconStack2, IconSunset2, IconTerminal2, IconZzz } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { LANGUAGES, type LanguageSetting } from '../../../../shared/i18n.ts'
import type { SwitchName } from '../../../../shared/ipc.ts'
import { COMMENT_NAME_MAX, normalizeCommentName } from '../../../../shared/office/comment-name.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { Kbd } from '../../../components/ui/primitives.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { logFailure } from '../../../lib/report.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $catalog, loadCatalog } from '../../../store/catalog.ts'
import { openEmojiPicker } from '../../../store/emoji.ts'
import { $systemLanguage, setLanguage, useT } from '../../../store/i18n.ts'
import { notify } from '../../../store/notifications.ts'
import { $spaces, spaceLabel } from '../../../store/spaces.ts'
import { $switches, setSwitch, switchLabel } from '../../../store/switches.ts'
import { $commentName, loadCommentName, setCommentName } from '../../office/comment-name.ts'
import { errorText, markSaved, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'

// Words for "language" in every language Herald has, so whoever is lost in another one can search for it.
const LANGUAGE_KEYWORDS =
  'language locale translation english chinese portuguese 语言 中文 简体中文 英文 idioma língua lingua tradução traducao inglês ingles chinês chines português portugues brasil'

export function GeneralSection() {
  const t = useT()
  const prefs = useStore($prefs)
  const spaces = useStore($spaces)
  const activeSpace = spaces.find(space => space.id === prefs.activeSpace) ?? spaces[0]

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: t('settings.saveFailed'), body: errorText(error), level: 'error' })
    }
  }

  const chooseFolder = async (key: 'defaultCwd' | 'projectsRoot' = 'defaultCwd') => {
    try {
      const [path] = await window.heraldOS.fs.pickFiles({ directory: true })

      if (path) {
        await save({ [key]: path })
      }
    } catch (error) {
      notify({ title: t('settings.general.chooseFolderFailed'), body: errorText(error), level: 'error' })
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.section.general')} subtitle={t('settings.general.subtitle')} />

      <LanguageGroup />

      <SettingsGroup title={t('settings.general.startup')}>
        <SettingsRow icon={<IconMaximize />} label={t('settings.general.fullscreen')} description={t('settings.general.fullscreenHint')} keywords="full screen start">
          <Toggle checked={prefs.fullscreenOnLaunch} onChange={next => void save({ fullscreenOnLaunch: next })} label={t('settings.general.fullscreen')} />
        </SettingsRow>
        <SettingsRow icon={<IconStack2 />} label={t('settings.general.defaultSpace')} description={t('settings.general.defaultSpaceHint')}>
          <MenuDropdown
            ariaLabel={t('settings.general.defaultSpace')}
            label={
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: activeSpace?.color }} />
                {activeSpace ? spaceLabel(activeSpace) : t('space.personal')}
              </span>
            }
            value={activeSpace?.id}
            items={spaces.map(space => ({
              id: space.id,
              label: (
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: space.color }} />
                  {spaceLabel(space)}
                </span>
              )
            }))}
            onSelect={id => void save({ activeSpace: id })}
          />
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t('settings.general.defaultFolder')} description={<span className="selectable font-mono text-[11.5px]">{prefs.defaultCwd || '~'}</span>} keywords="working directory cwd">
          <GlassButton size="sm" onClick={() => void chooseFolder()} aria-label={t('settings.general.chooseDefaultFolder')}>
            {t('settings.general.choose')}
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label={t('settings.general.projectsFolder')} description={<span className="selectable font-mono text-[11.5px]">{prefs.projectsRoot || '~/Projects'}</span>} keywords="build studio code website app">
          <GlassButton size="sm" onClick={() => void chooseFolder('projectsRoot')} aria-label={t('settings.general.chooseProjectsFolder')}>
            {t('settings.general.choose')}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <SwitchesGroup />
      {hostPlatform() === 'linux' && <IdleGroup />}
      <TypingGroup />
      <OfficeGroup />

      <SettingsGroup title={t('settings.general.session')}>
        {hostPlatform() === 'linux' ? (
          <SettingsRow icon={<IconPower />} label={t('settings.general.restart')} description={t('settings.general.restartHint')} keywords="exit close quit">
            <GlassButton size="sm" variant="danger" onClick={() => void window.heraldOS.window.quit().catch(logFailure('window.quit'))} aria-label={t('settings.general.restart')}>
              {t('settings.general.restartButton')}
            </GlassButton>
          </SettingsRow>
        ) : (
          <SettingsRow icon={<IconPower />} label={t('settings.general.quit')} description={t('settings.general.quitHint')} keywords="exit close">
            <GlassButton size="sm" variant="danger" onClick={() => void window.heraldOS.window.quit().catch(logFailure('window.quit'))} aria-label={t('settings.general.quit')}>
              {t('settings.general.quitButton')}
            </GlassButton>
          </SettingsRow>
        )}
      </SettingsGroup>
    </>
  )
}

/** Each language under its own name; following the system says which one that is now. */
function LanguageGroup() {
  const t = useT()
  const setting: LanguageSetting = useStore($prefs).language ?? 'system'
  const systemLanguage = useStore($systemLanguage)
  const system = LANGUAGES.find(language => language.id === systemLanguage)?.name ?? ''
  const items = [{ id: 'system' as const, label: t('language.system'), description: system }, ...LANGUAGES.map(language => ({ id: language.id, label: language.name }))]

  const choose = (next: LanguageSetting) =>
    void setLanguage(next)
      .then(markSaved)
      .catch(error => notify({ title: t('settings.saveFailed'), body: errorText(error), level: 'error' }))

  return (
    <SettingsGroup title={t('settings.language.group')}>
      <SettingsRow icon={<IconLanguage />} label={t('settings.language.label')} description={t('settings.language.hint')} keywords={LANGUAGE_KEYWORDS}>
        <MenuDropdown ariaLabel={t('settings.language.label')} label={setting === 'system' ? t('language.systemNow', { language: system }) : items.find(item => item.id === setting)?.label} value={setting} items={items} onSelect={choose} />
      </SettingsRow>
    </SettingsGroup>
  )
}

function SwitchesGroup() {
  const t = useT()
  const switches = useStore($switches)
  const prefs = useStore($prefs)

  const flip = (name: SwitchName, enabled: boolean) =>
    void setSwitch(name, enabled)
      .then(markSaved)
      .catch(error => notify({ title: t('settings.general.switchFailed', { name: switchLabel(name) }), body: errorText(error), level: 'error' }))

  return (
    <SettingsGroup title={t('settings.general.switches')}>
      <SettingsRow icon={<IconMoon />} label={switchLabel('doNotDisturb')} description={t('settings.general.doNotDisturbHint')} keywords="dnd quiet focus silence">
        <Toggle checked={switches.doNotDisturb} onChange={next => flip('doNotDisturb', next)} label={switchLabel('doNotDisturb')} />
      </SettingsRow>
      <SettingsRow icon={<IconCoffee />} label={switchLabel('stayAwake')} description={t('settings.general.stayAwakeHint')} keywords="caffeine inhibit idle sleep">
        <Toggle checked={switches.stayAwake} onChange={next => flip('stayAwake', next)} label={switchLabel('stayAwake')} />
      </SettingsRow>
      {switches.nightLight !== null && (
        <SettingsRow icon={<IconSunset2 />} label={switchLabel('nightLight')} description={t('settings.general.nightLightHint')} keywords="blue light warm wlsunset">
          <Toggle checked={switches.nightLight} onChange={next => flip('nightLight', next)} label={switchLabel('nightLight')} />
        </SettingsRow>
      )}
      <SettingsRow icon={<IconDeviceDesktop />} label={switchLabel('screensaver')} description={t('settings.general.screensaverHint')} keywords="screen saver idle clock">
        {switches.screensaver && (
          <Stepper value={prefs.screensaver?.afterMinutes ?? 5} min={1} max={60} label={t('settings.general.screensaverMinutes')} onChange={afterMinutes => void updatePrefs({ screensaver: { enabled: true, afterMinutes } }).then(markSaved)} />
        )}
        <Toggle checked={switches.screensaver} onChange={next => flip('screensaver', next)} label={switchLabel('screensaver')} />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Dictation and emoji in any app, and (Linux) the keymap niri runs with. */
function TypingGroup() {
  const t = useT()
  const prefs = useStore($prefs)
  const linux = hostPlatform() === 'linux'
  const mod = linux ? 'Super' : 'Cmd'
  const keymap = prefs.keymap === 'omarchy' ? 'omarchy' : 'herald'

  return (
    <SettingsGroup title={t('settings.general.typing')}>
      <SettingsRow icon={<IconMicrophone />} label={t('settings.general.dictation')} description={t('settings.general.dictationHint')} keywords="speech to text voice typing dictate">
        <Kbd>{mod}+Ctrl+X</Kbd>
      </SettingsRow>
      <SettingsRow icon={<IconMoodSmile />} label={t('settings.general.emoji')} description={linux ? t('settings.general.emojiHintLinux') : t('settings.general.emojiHintMac')} keywords="emoji picker smiley">
        <Kbd>{mod}+Ctrl+E</Kbd>
        <GlassButton size="sm" onClick={openEmojiPicker} aria-label={t('settings.general.openEmoji')}>
          {t('settings.general.open')}
        </GlassButton>
      </SettingsRow>
      {linux && <DefaultTerminalRow />}
      {linux && (
        <SettingsRow icon={<IconKeyboard />} label={t('settings.general.keymap')} description={t('settings.general.keymapHint')} keywords="keyboard shortcuts omarchy copy paste super hotkeys">
          <MenuDropdown
            ariaLabel={t('settings.general.keymap')}
            label={keymap === 'omarchy' ? 'Omarchy' : 'Herald'}
            value={keymap}
            items={[
              { id: 'herald', label: 'Herald' },
              { id: 'omarchy', label: 'Omarchy' }
            ]}
            onSelect={id => void updatePrefs({ keymap: id === 'omarchy' ? 'omarchy' : 'herald' }).then(markSaved)}
          />
        </SettingsRow>
      )}
    </SettingsGroup>
  )
}

/** Herald Docs and Sheets: the name on the comments and notes the person adds. */
function OfficeGroup() {
  const t = useT()
  const saved = useStore($commentName)
  const [name, setName] = useState(saved)

  useEffect(() => setName(saved), [saved])

  useEffect(() => {
    loadCommentName().catch(() => undefined)
  }, [])

  const save = (value: string) => {
    if (normalizeCommentName(value) !== saved) {
      setCommentName(value)
        .then(markSaved)
        .catch(error => notify({ title: t('settings.saveFailed'), body: errorText(error), level: 'error' }))
    }
  }

  return (
    <SettingsGroup title={t('settings.general.office')}>
      <SettingsRow
        icon={<IconMessage />}
        label={t('settings.general.commentName')}
        description={t('settings.general.commentNameHint')}
        keywords="author comments notes replies docs sheets slides office name"
      >
        {saved && (
          <GlassButton size="sm" variant="ghost" onClick={() => save('')}>
            {t('settings.general.clear')}
          </GlassButton>
        )}
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={() => save(name)}
          onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
          maxLength={COMMENT_NAME_MAX}
          placeholder={t('settings.general.notSet')}
          aria-label={t('settings.general.commentName')}
          className="glass-input h-8 w-[200px] rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Herald OS Linux: what Super+Return opens; terminals installed from Software join the list. */
function DefaultTerminalRow() {
  const t = useT()
  const prefs = useStore($prefs)
  const catalog = useStore($catalog)

  useEffect(() => {
    if (!catalog.loaded) {
      void loadCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const installed = catalog.groups.flatMap(group => group.entries).filter(entry => entry.terminalApp && entry.installed)
  const items = [{ id: 'herald', label: t('settings.general.heraldTerminal') }, { id: 'foot', label: 'Foot' }, ...installed.map(entry => ({ id: entry.terminalApp as string, label: entry.label }))]
  const current = prefs.defaultTerminal ?? 'herald'

  return (
    <SettingsRow icon={<IconTerminal2 />} label={t('settings.general.terminal')} description={t('settings.general.terminalHint')} keywords="terminal default ghostty kitty alacritty foot">
      <MenuDropdown ariaLabel={t('settings.general.terminal')} label={items.find(item => item.id === current)?.label ?? current} value={current} items={items} onSelect={id => void updatePrefs({ defaultTerminal: id }).then(markSaved)} />
    </SettingsRow>
  )
}

/** Herald OS Linux: the idle timings swayidle runs with. */
function IdleGroup() {
  const t = useT()
  const prefs = useStore($prefs)
  const idle = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0, ...prefs.idle }
  const set = (patch: Partial<typeof idle>) => void updatePrefs({ idle: { ...idle, ...patch } }).then(markSaved)

  return (
    <SettingsGroup title={t('settings.general.away')}>
      <SettingsRow icon={<IconLock />} label={t('settings.general.lockAfter')} description={t('settings.general.lockHint')} keywords="lock idle timeout">
        <Stepper value={idle.lockAfter} min={1} max={120} label={t('settings.general.lockMinutes')} onChange={lockAfter => set({ lockAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconDeviceDesktopOff />} label={t('settings.general.screenOffAfter')} description={t('settings.general.screenOffHint')} keywords="display off power idle">
        <Stepper value={idle.screenOffAfter} min={1} max={180} label={t('settings.general.screenOffMinutes')} onChange={screenOffAfter => set({ screenOffAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconZzz />} label={t('settings.general.sleepAfter')} description={idle.suspendAfter ? t('settings.general.sleepHint') : t('settings.general.neverSleep')} keywords="suspend sleep idle">
        <Stepper value={idle.suspendAfter || null} min={0} max={240} label={t('settings.general.sleepMinutes')} onChange={suspendAfter => set({ suspendAfter })} />
      </SettingsRow>
    </SettingsGroup>
  )
}
