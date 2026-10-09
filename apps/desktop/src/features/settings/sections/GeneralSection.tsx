import { useStore } from '@nanostores/react'
import { IconCoffee, IconDeviceDesktop, IconDeviceDesktopOff, IconFolder, IconKeyboard, IconLock, IconMaximize, IconMessage, IconMicrophone, IconMoodSmile, IconMoon, IconPower, IconStack2, IconSunset2, IconTerminal2, IconZzz } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { SwitchName } from '../../../../shared/ipc.ts'
import { COMMENT_NAME_MAX, normalizeCommentName } from '../../../../shared/office/comment-name.ts'
import { GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { Kbd } from '../../../components/ui/primitives.tsx'
import { hostPlatform } from '../../../lib/platform-labels.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $catalog, loadCatalog } from '../../../store/catalog.ts'
import { openEmojiPicker } from '../../../store/emoji.ts'
import { notify } from '../../../store/notifications.ts'
import { $spaces } from '../../../store/spaces.ts'
import { $switches, setSwitch, SWITCH_LABELS } from '../../../store/switches.ts'
import { $commentName, loadCommentName, setCommentName } from '../../office/comment-name.ts'
import { errorText, markSaved, MenuDropdown, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'

export function GeneralSection() {
  const prefs = useStore($prefs)
  const spaces = useStore($spaces)
  const activeSpace = spaces.find(space => space.id === prefs.activeSpace) ?? spaces[0]

  const save = async (patch: Parameters<typeof updatePrefs>[0]) => {
    try {
      await updatePrefs(patch)
      markSaved()
    } catch (error) {
      notify({ title: 'Could not save setting', body: errorText(error), level: 'error' })
    }
  }

  const chooseFolder = async (key: 'defaultCwd' | 'projectsRoot' = 'defaultCwd') => {
    try {
      const [path] = await window.heraldOS.fs.pickFiles({ directory: true })

      if (path) {
        await save({ [key]: path })
      }
    } catch (error) {
      notify({ title: 'Could not choose folder', body: errorText(error), level: 'error' })
    }
  }

  return (
    <>
      <SectionTitle title="General" subtitle="How Herald OS starts and where it works." />

      <SettingsGroup title="Startup">
        <SettingsRow icon={<IconMaximize />} label="Launch fullscreen" description="Herald OS takes over the screen when it starts. Cmd+Ctrl+F toggles at any time." keywords="full screen start">
          <Toggle checked={prefs.fullscreenOnLaunch} onChange={next => void save({ fullscreenOnLaunch: next })} label="Launch fullscreen" />
        </SettingsRow>
        <SettingsRow icon={<IconStack2 />} label="Default Space" description="The Space Herald OS opens in.">
          <MenuDropdown
            ariaLabel="Default Space"
            label={
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: activeSpace?.color }} />
                {activeSpace?.name ?? 'Personal'}
              </span>
            }
            value={activeSpace?.id}
            items={spaces.map(space => ({
              id: space.id,
              label: (
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: space.color }} />
                  {space.name}
                </span>
              )
            }))}
            onSelect={id => void save({ activeSpace: id })}
          />
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label="Default folder" description={<span className="selectable font-mono text-[11.5px]">{prefs.defaultCwd || '~'}</span>} keywords="working directory cwd">
          <GlassButton size="sm" onClick={() => void chooseFolder()} aria-label="Choose default folder">
            Choose…
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconFolder />} label="Projects folder" description={<span className="selectable font-mono text-[11.5px]">{prefs.projectsRoot || '~/Projects'}</span>} keywords="build studio code website app">
          <GlassButton size="sm" onClick={() => void chooseFolder('projectsRoot')} aria-label="Choose projects folder">
            Choose…
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      <SwitchesGroup />
      {hostPlatform() === 'linux' && <IdleGroup />}
      <TypingGroup />
      <OfficeGroup />


      <SettingsGroup title="Session">
        {hostPlatform() === 'linux' ? (
          <SettingsRow icon={<IconPower />} label="Restart Herald OS" description="Stops the Hermes backend this shell started and starts a fresh session." keywords="exit close quit">
            <GlassButton size="sm" variant="danger" onClick={() => void window.heraldOS.window.quit()} aria-label="Restart Herald OS">
              Restart
            </GlassButton>
          </SettingsRow>
        ) : (
          <SettingsRow icon={<IconPower />} label="Quit Herald OS" description="Stops the Hermes backend this shell started and returns to macOS." keywords="exit close">
            <GlassButton size="sm" variant="danger" onClick={() => void window.heraldOS.window.quit()} aria-label="Quit Herald OS">
              Quit
            </GlassButton>
          </SettingsRow>
        )}
      </SettingsGroup>
    </>
  )
}

function SwitchesGroup() {
  const switches = useStore($switches)
  const prefs = useStore($prefs)

  const flip = (name: SwitchName, enabled: boolean) =>
    void setSwitch(name, enabled)
      .then(markSaved)
      .catch(error => notify({ title: `Could not change ${SWITCH_LABELS[name].toLowerCase()}`, body: errorText(error), level: 'error' }))

  return (
    <SettingsGroup title="Switches">
      <SettingsRow icon={<IconMoon />} label="Do not disturb" description="Notifications collect in the bell without popping up, sounding or being read aloud." keywords="dnd quiet focus silence">
        <Toggle checked={switches.doNotDisturb} onChange={next => flip('doNotDisturb', next)} label="Do not disturb" />
      </SettingsRow>
      <SettingsRow icon={<IconCoffee />} label="Stay awake" description="Keep the screens on; nothing locks or sleeps on its own until you turn this off." keywords="caffeine inhibit idle sleep">
        <Toggle checked={switches.stayAwake} onChange={next => flip('stayAwake', next)} label="Stay awake" />
      </SettingsRow>
      {switches.nightLight !== null && (
        <SettingsRow icon={<IconSunset2 />} label="Night light" description="Warmer colours that are easier on the eyes in the evening." keywords="blue light warm wlsunset">
          <Toggle checked={switches.nightLight} onChange={next => flip('nightLight', next)} label="Night light" />
        </SettingsRow>
      )}
      <SettingsRow icon={<IconDeviceDesktop />} label="Screensaver" description="After a few idle minutes, the living wallpaper and a large clock." keywords="screen saver idle clock">
        {switches.screensaver && (
          <Stepper value={prefs.screensaver?.afterMinutes ?? 5} min={1} max={60} label="Minutes before the screensaver" onChange={afterMinutes => void updatePrefs({ screensaver: { enabled: true, afterMinutes } }).then(markSaved)} />
        )}
        <Toggle checked={switches.screensaver} onChange={next => flip('screensaver', next)} label="Screensaver" />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Dictation and emoji in any app, and (Linux) the keymap niri runs with. */
function TypingGroup() {
  const prefs = useStore($prefs)
  const linux = hostPlatform() === 'linux'
  const mod = linux ? 'Super' : 'Cmd'
  const keymap = prefs.keymap === 'omarchy' ? 'omarchy' : 'herald'

  return (
    <SettingsGroup title="Typing">
      <SettingsRow icon={<IconMicrophone />} label="Dictation" description='Speak in any app and the words are typed where the cursor is; it stops after a pause. Say "comma", "new line" or "press enter".' keywords="speech to text voice typing dictate">
        <Kbd>{mod}+Ctrl+X</Kbd>
      </SettingsRow>
      <SettingsRow icon={<IconMoodSmile />} label="Emoji" description={linux ? 'Search and insert an emoji into the app you are typing in.' : 'The picker inside Herald OS; Ctrl+Cmd+Space opens the macOS one anywhere else.'} keywords="emoji picker smiley">
        <Kbd>{mod}+Ctrl+E</Kbd>
        <GlassButton size="sm" onClick={openEmojiPicker} aria-label="Open the emoji picker">
          Open
        </GlassButton>
      </SettingsRow>
      {linux && <DefaultTerminalRow />}
      {linux && (
        <SettingsRow icon={<IconKeyboard />} label="Keymap" description="Omarchy: Super+C, X and V copy, cut and paste in every app, terminals included; voice moves to Super+Shift+V and centring a column to Super+Ctrl+C." keywords="keyboard shortcuts omarchy copy paste super hotkeys">
          <MenuDropdown
            ariaLabel="Keymap"
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

/** Herald Docs, Sheets and Slides: the name on the comments and notes the person adds. */
function OfficeGroup() {
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
        .catch(error => notify({ title: 'Could not save setting', body: errorText(error), level: 'error' }))
    }
  }

  return (
    <SettingsGroup title="Herald Office">
      <SettingsRow
        icon={<IconMessage />}
        label="Name on comments"
        description="Shown on the comments and notes you add in Docs, Sheets and Slides and saved in those files; clear it to be asked again."
        keywords="author comments notes replies docs sheets slides office name"
      >
        {saved && (
          <GlassButton size="sm" variant="ghost" onClick={() => save('')}>
            Clear
          </GlassButton>
        )}
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          onBlur={() => save(name)}
          onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
          maxLength={COMMENT_NAME_MAX}
          placeholder="Not set"
          aria-label="Name on comments"
          className="glass-input h-8 w-[200px] rounded-lg px-2.5 text-[12.5px] outline-none"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/** Herald OS Linux: what Super+Return opens; terminals installed from Software join the list. */
function DefaultTerminalRow() {
  const prefs = useStore($prefs)
  const catalog = useStore($catalog)

  useEffect(() => {
    if (!catalog.loaded) {
      void loadCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const installed = catalog.groups.flatMap(group => group.entries).filter(entry => entry.terminalApp && entry.installed)
  const items = [{ id: 'herald', label: 'Herald OS Terminal' }, { id: 'foot', label: 'Foot' }, ...installed.map(entry => ({ id: entry.terminalApp as string, label: entry.label }))]
  const current = prefs.defaultTerminal ?? 'herald'

  return (
    <SettingsRow icon={<IconTerminal2 />} label="Terminal" description="What Super+Return opens. Install Ghostty, Alacritty or Kitty from Software to add them here." keywords="terminal default ghostty kitty alacritty foot">
      <MenuDropdown ariaLabel="Terminal" label={items.find(item => item.id === current)?.label ?? current} value={current} items={items} onSelect={id => void updatePrefs({ defaultTerminal: id }).then(markSaved)} />
    </SettingsRow>
  )
}

/** Herald OS Linux: the idle timings swayidle runs with. */
function IdleGroup() {
  const prefs = useStore($prefs)
  const idle = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0, ...prefs.idle }
  const set = (patch: Partial<typeof idle>) => void updatePrefs({ idle: { ...idle, ...patch } }).then(markSaved)

  return (
    <SettingsGroup title="When you step away">
      <SettingsRow icon={<IconLock />} label="Lock the screen after" description="Minutes without input (only when your account has a password)." keywords="lock idle timeout">
        <Stepper value={idle.lockAfter} min={1} max={120} label="Minutes before locking" onChange={lockAfter => set({ lockAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconDeviceDesktopOff />} label="Turn the screens off after" description="Minutes without input." keywords="display off power idle">
        <Stepper value={idle.screenOffAfter} min={1} max={180} label="Minutes before the screens turn off" onChange={screenOffAfter => set({ screenOffAfter })} />
      </SettingsRow>
      <SettingsRow icon={<IconZzz />} label="Sleep after" description={idle.suspendAfter ? 'Minutes without input.' : 'Never: the computer only sleeps when you ask.'} keywords="suspend sleep idle">
        <Stepper value={idle.suspendAfter || null} min={0} max={240} label="Minutes before sleeping" onChange={suspendAfter => set({ suspendAfter })} />
      </SettingsRow>
    </SettingsGroup>
  )
}
