import { useStore } from '@nanostores/react'
import { IconBellRinging, IconBolt, IconClockPause, IconCoin, IconEar, IconEye, IconHourglass, IconKeyboard, IconLanguage, IconListDetails, IconMicrophone, IconPlayerPlay, IconSpeakerphone, IconVolume, IconWaveSine } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { MicPermission, VoiceEngine, VoicePrefs } from '../../../../shared/ipc.ts'
import { GlassButton, Pill, Toggle } from '../../../components/ui/glass.tsx'
import { Meter } from '../../../components/ui/primitives.tsx'
import { describeDeviceChoice } from '../../../lib/audio-devices.ts'
import { audioScope, deviceNoun } from '../../../lib/platform-labels.ts'
import { rest } from '../../../lib/rest.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $inputDevices } from '../../../lib/voice/audio-capture.ts'
import { LOCAL_STT_MODELS } from '../../../lib/voice/stt-tuning.ts'
import { $inputChoice, $micHeldElsewhere, $micLevelPercent, $microphoneTest, chooseInputDevice, startMicrophoneTest, stopMicrophoneTest, watchAudioDevices } from '../../../store/audio-devices.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { $voice, $voiceActive, LIVE_RATE_PER_MINUTE, liveSecondsToday, speakWithFreeFallback, startVoice } from '../../../store/voice.ts'
import { fetchLiveStatus, type LiveStatus } from '../../../store/voice-live-status.ts'
import { $wake, setWakeWordEnabled } from '../../../store/wake.ts'
import { errorText, focusSettings, InlineNote, markSaved, MenuDropdown, type MenuItem, RadioCard, SectionTitle, SettingsGroup, SettingsRow, Stepper } from './shared.tsx'

/*
 * Voice: the two engines (free chained pipeline, paid GPT-Live), how a conversation starts (wake
 * word, hotkey), the speech providers Hermes uses (written to the runtime's config.yaml through
 * PUT /api/config), and the Live cost controls. See docs/VOICE.md.
 */

interface HermesConfig {
  stt?: { provider?: string; local?: { model?: string }; [key: string]: unknown }
  tts?: { provider?: string; [key: string]: unknown }
  [key: string]: unknown
}

const STT_PROVIDERS = [
  { id: 'nous', label: 'Nous subscription', description: 'OpenAI transcription through the Nous gateway; no extra cost' },
  { id: 'local', label: 'On this device (faster-whisper)', description: 'Free and private; slower on long utterances' },
  { id: 'openai', label: 'OpenAI', description: 'gpt-4o-mini-transcribe with your OPENAI_API_KEY' },
  { id: 'groq', label: 'Groq Whisper', description: 'GROQ_API_KEY' },
  { id: 'mistral', label: 'Mistral Voxtral', description: 'MISTRAL_API_KEY' },
  { id: 'elevenlabs', label: 'ElevenLabs Scribe', description: 'ELEVENLABS_API_KEY' }
] as const

const TTS_PROVIDERS = [
  { id: 'nous', label: 'Nous subscription', description: 'gpt-4o-mini-tts through the Nous gateway; no extra cost' },
  { id: 'edge', label: 'Edge neural voices', description: 'Free, no key; whole sentences at a time' },
  { id: 'openai', label: 'OpenAI', description: 'gpt-4o-mini-tts, streams sentence by sentence' },
  { id: 'elevenlabs', label: 'ElevenLabs', description: 'Most expressive; streams; paid' },
  { id: 'neutts', label: 'NeuTTS (local)', description: 'Runs on this device; needs the neutts extra' },
  { id: 'kittentts', label: 'KittenTTS (local)', description: 'Tiny local model' },
  { id: 'piper', label: 'Piper (local)', description: 'Fast local voices' }
] as const

const IDLE_OPTIONS = [20, 30, 45, 60, 120, 300]
const CAP_OPTIONS = [0, 15, 30, 60, 120, 240]

/** The picker entry that means "follow the system"; prefixed so it can never be a device id. */
const AUTOMATIC_DEVICE = '__automatic__'

export function VoiceSection() {
  const prefs = useStore($prefs)
  const voice = prefs.voice
  const wake = useStore($wake)
  const live = useStore($voice).live
  const active = useStore($voiceActive)
  const config = useBackendData(() => rest.get<HermesConfig>('/api/config'))
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(live.status)
  const [mic, setMic] = useState<MicPermission>('unknown')
  const [hotkeyDraft, setHotkeyDraft] = useState(voice.hotkey)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void fetchLiveStatus().then(setLiveStatus)
    void window.heraldOS.voice.microphoneStatus().then(setMic)
  }, [])

  useEffect(() => setHotkeyDraft(voice.hotkey), [voice.hotkey])

  const save = async (patch: Partial<VoicePrefs>) => {
    try {
      await updatePrefs({ voice: { ...$prefs.get().voice, ...patch } })
      markSaved()
    } catch (error) {
      notify({ title: 'Could not save setting', body: errorText(error), level: 'error' })
    }
  }

  const saveConfig = async (section: 'stt' | 'tts', provider: string) => {
    try {
      await rest.put('/api/config', { config: { [section]: { provider } } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: 'Could not update Hermes config', body: errorText(error), level: 'error' })
    }
  }

  const setEngine = async (engine: VoiceEngine) => {
    if (engine === 'live' && liveStatus && !liveStatus.available) {
      notify({ title: 'Live is not available', body: liveStatus.reason ?? 'GPT-Live cannot start on this runtime.', level: 'warn' })

      return
    }

    await save({ engine })
  }

  const requestMic = async () => {
    try {
      setMic(await window.heraldOS.voice.requestMicrophone())
    } catch (error) {
      notify({ title: 'Microphone', body: errorText(error), level: 'error' })
    }
  }

  const sayHello = async () => {
    setTesting(true)

    try {
      await speakWithFreeFallback('Hello. This is Hermes, speaking from Herald OS.')
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: 'Speech test failed', body: errorText(error), level: 'error' })
    } finally {
      setTesting(false)
    }
  }

  const saveLocalModel = async (model: string) => {
    try {
      await rest.put('/api/config', { config: { stt: { local: { model } } } })
      await updatePrefs({ voice: { ...$prefs.get().voice, sttTuned: true } })
      config.reload()
      markSaved()
    } catch (error) {
      notify({ title: 'Could not update Hermes config', body: errorText(error), level: 'error' })
    }
  }

  const sttProvider = config.data?.stt?.provider ?? 'local'
  const localModel = config.data?.stt?.local?.model ?? 'base'
  const ttsProvider = config.data?.tts?.provider ?? 'edge'
  const todayMinutes = Math.round(liveSecondsToday(voice) / 60)
  const todayCost = ((liveSecondsToday(voice) / 60) * LIVE_RATE_PER_MINUTE).toFixed(2)

  // Audio devices: Herald keeps its own microphone where it is one app among others, and the Sound
  // panel in the menu bar shows the same control. Herald OS Linux sets the machine's devices instead.
  const micDevices = useStore($inputDevices)
  const micChoice = useStore($inputChoice)
  const micLevel = useStore($micLevelPercent)
  const testingMic = useStore($microphoneTest)
  const micHeldElsewhere = useStore($micHeldElsewhere)

  useEffect(() => watchAudioDevices(), [])

  const automaticMic = micDevices.devices.find(device => device.isSystem)
  const chosenMic = voice.inputDevice
  const selectedMic = chosenMic && micDevices.devices.some(device => device.id === chosenMic.id) ? chosenMic.id : AUTOMATIC_DEVICE
  const micItems: readonly MenuItem[] = [
    { id: AUTOMATIC_DEVICE, label: 'Automatic', description: automaticMic ? `Follow the system: ${automaticMic.label}` : 'Follow the system' },
    ...micDevices.devices.map(device => ({ id: device.id, label: device.label, description: device.isSystem ? 'The system default right now' : undefined }))
  ]
  const micLabel = micDevices.devices.find(device => device.id === selectedMic)?.label ?? 'Automatic'

  const selectMicrophone = async (id: string) => {
    const device = micDevices.devices.find(one => one.id === id)

    await chooseInputDevice(id === AUTOMATIC_DEVICE || !device ? null : { id: device.id, label: device.label })
    markSaved()
  }

  return (
    <>
      <SectionTitle title="Voice" subtitle="Talk to Hermes and hear it answer. Hermes stays the brain in every mode; only the audio path changes." />

      <SettingsGroup title="Voice">
        <SettingsRow icon={<IconMicrophone />} label="Enable voice" description="Shows the microphone in the menu bar and composers, and registers the hotkey. Off means the mic is never opened." keywords="talk speak jarvis">
          <Toggle checked={voice.enabled} onChange={next => void save({ enabled: next, wakeWord: next ? voice.wakeWord : false })} label="Enable voice" />
        </SettingsRow>
        <SettingsRow
          icon={<IconMicrophone />}
          label="Microphone access"
          description={mic === 'granted' ? 'Granted.' : mic === 'denied' || mic === 'restricted' ? 'Denied. Allow Herald OS under System Settings > Privacy & Security > Microphone.' : 'Not asked yet; the first conversation asks.'}
          keywords="permission privacy"
        >
          {mic !== 'granted' && (
            <GlassButton size="sm" onClick={() => void requestMic()} aria-label="Request microphone access">
              Request access
            </GlassButton>
          )}
        </SettingsRow>
        <SettingsRow icon={<IconListDetails />} label="What you can say" description='Every voice command, with examples. You can also say "what can I say".' keywords="commands help list">
          <GlassButton size="sm" onClick={() => focusSettings({ section: 'commands' })} aria-label="Show voice commands">
            Show commands
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlayerPlay />} label="Try it" description="Hear the configured voice, or start a conversation right here.">
          <GlassButton size="sm" onClick={() => void sayHello()} disabled={testing} aria-label="Play a test sentence">
            <IconVolume />
            {testing ? 'Speaking…' : 'Say hello'}
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void startVoice('button')} disabled={active} aria-label="Start a voice conversation">
            {active ? 'Listening…' : 'Start talking'}
          </GlassButton>
        </SettingsRow>
      </SettingsGroup>

      {audioScope() === 'app' && (
        <SettingsGroup title="Audio devices">
          <SettingsRow
            icon={<IconMicrophone />}
            label="Microphone"
            description={describeDeviceChoice(micChoice, 'input')}
            keywords="microphone input device airpods bluetooth headset usb audio"
            below={
              voice.enabled ? (
                <div className="flex items-center gap-2">
                  <Meter value={micLevel} className="flex-1" />
                  <GlassButton
                    size="sm"
                    onClick={() => (testingMic ? stopMicrophoneTest() : void startMicrophoneTest())}
                    disabled={micHeldElsewhere}
                    title={micHeldElsewhere ? 'The microphone is already open' : 'Hear the microphone for a few seconds'}
                    aria-label={testingMic ? 'Stop the microphone test' : 'Test the microphone'}
                  >
                    {testingMic ? 'Stop' : 'Test'}
                  </GlassButton>
                </div>
              ) : undefined
            }
          >
            <MenuDropdown
              ariaLabel="Microphone"
              label={micLabel}
              items={micItems}
              value={selectedMic}
              onSelect={id => void selectMicrophone(String(id))}
              disabled={!voice.enabled}
            />
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsGroup title="Engine">
        <SettingsRow
          label="Conversation engine"
          description="Free: your mic is transcribed, Hermes answers, and the reply is spoken as it streams (about 2 s per turn). Live: OpenAI's full-duplex voice model talks with you and delegates to Hermes (under 1 s, natural interruptions)."
          keywords="chained gpt-live realtime cost"
          below={
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <RadioCard icon={<IconWaveSine />} label="Free" description="No extra cost; STT and TTS providers below" selected={voice.engine === 'chained'} onSelect={() => void setEngine('chained')} />
                <RadioCard
                  icon={<IconBolt />}
                  label="Live"
                  description={liveStatus?.available ? `$${LIVE_RATE_PER_MINUTE.toFixed(2)} per minute while talking` : 'Needs an OpenAI key and Hermes 0.21.3+'}
                  selected={voice.engine === 'live'}
                  onSelect={() => void setEngine('live')}
                  disabled={liveStatus ? !liveStatus.available : false}
                />
              </div>
              {liveStatus && !liveStatus.available && <InlineNote tone="info">Live unavailable: {liveStatus.reason}</InlineNote>}
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Starting a conversation">
        <SettingsRow
          icon={<IconEar />}
          label={`Wake word: “${wake.phrase}”`}
          description={
            wake.listening
              ? `Listening${wake.capture === 'local' ? ' (Hermes opened the mic itself)' : ''}.`
              : wake.error
                ? wake.error
                : `Runs the on-device openWakeWord detector inside Hermes; nothing leaves this ${deviceNoun()} until you speak to it.`
          }
          keywords="hey hermes always listening"
        >
          {wake.listening && <Pill tone="ok" dot>Armed</Pill>}
          <Toggle checked={voice.wakeWord} onChange={next => void setWakeWordEnabled(next).then(markSaved)} label="Wake word" />
        </SettingsRow>
        <SettingsRow icon={<IconKeyboard />} label="Global hotkey" description="Toggles a conversation from any app (Electron accelerator syntax, e.g. Alt+Space or CommandOrControl+Shift+H)." keywords="shortcut push to talk">
          <input
            value={hotkeyDraft}
            onChange={event => setHotkeyDraft(event.target.value)}
            onBlur={() => hotkeyDraft.trim() !== voice.hotkey && void save({ hotkey: hotkeyDraft.trim() })}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
            aria-label="Global voice hotkey"
            spellCheck={false}
            className="glass-input h-8 w-[200px] rounded-lg px-2.5 font-mono text-[12px] text-fg outline-none"
          />
        </SettingsRow>
        <SettingsRow icon={<IconHourglass />} label="Follow-up window" description="Seconds the mic keeps listening after Hermes finishes speaking." keywords="continue listening">
          <Stepper value={voice.followUpSeconds} min={0} max={30} onChange={next => void save({ followUpSeconds: next })} label="follow-up seconds" />
        </SettingsRow>
        <SettingsRow icon={<IconEye />} label="Follow Hermes" description="Show what Hermes changes as it works (a new memory, a paused automation, a written file) even when you are not in a voice conversation. Voice conversations always follow." keywords="watch show work">
          <Toggle checked={voice.followHermes} onChange={next => void save({ followHermes: next })} label="Follow Hermes" />
        </SettingsRow>
        <SettingsRow icon={<IconBellRinging />} label="Speak notifications" description="Read Hermes notifications aloud (missions, reminders) while voice is enabled and no conversation is running." keywords="announce read aloud">
          <Toggle checked={voice.announceNotifications} onChange={next => void save({ announceNotifications: next })} label="Speak notifications" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Speech providers (free engine)">
        <SettingsRow icon={<IconLanguage />} label="Speech to text" description={config.error ? `Could not read Hermes config: ${config.error}` : 'Which service turns your voice into text. Stored in Hermes config.yaml (stt.provider).'} keywords="stt transcribe whisper">
          <MenuDropdown ariaLabel="Speech-to-text provider" label={STT_PROVIDERS.find(p => p.id === sttProvider)?.label ?? sttProvider} value={sttProvider} items={STT_PROVIDERS} onSelect={id => void saveConfig('stt', id)} disabled={!config.data} />
        </SettingsRow>
        {sttProvider === 'local' && (
          <SettingsRow icon={<IconWaveSine />} label="Transcription model" description="Larger models hear short commands and names better but take longer per sentence. Accurate (small.en) is recommended; the first use downloads it." keywords="whisper accuracy model local">
            <MenuDropdown ariaLabel="Local transcription model" label={LOCAL_STT_MODELS.find(m => m.id === localModel)?.label ?? localModel} value={localModel} items={LOCAL_STT_MODELS} onSelect={id => void saveLocalModel(id)} disabled={!config.data} />
          </SettingsRow>
        )}
        <SettingsRow icon={<IconSpeakerphone />} label="Text to speech" description="Which voice speaks Hermes's replies. Stored in Hermes config.yaml (tts.provider); voices and speed follow `hermes tools`." keywords="tts voice speak">
          <MenuDropdown ariaLabel="Text-to-speech provider" label={TTS_PROVIDERS.find(p => p.id === ttsProvider)?.label ?? ttsProvider} value={ttsProvider} items={TTS_PROVIDERS} onSelect={id => void saveConfig('tts', id)} disabled={!config.data} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Live cost controls">
        <SettingsRow icon={<IconClockPause />} label="Close after silence" description="A Live session bills per second while open; it is closed after this much quiet." keywords="idle timeout">
          <MenuDropdown ariaLabel="Live idle timeout" label={`${voice.liveIdleSeconds} s`} value={String(voice.liveIdleSeconds)} items={IDLE_OPTIONS.map(s => ({ id: String(s), label: `${s} seconds` }))} onSelect={id => void save({ liveIdleSeconds: Number(id) })} />
        </SettingsRow>
        <SettingsRow icon={<IconCoin />} label="Daily cap" description={`Today: ${todayMinutes} min of Live, about $${todayCost}. New Live sessions are refused past the cap; the free engine keeps working.`} keywords="budget limit spend">
          <MenuDropdown ariaLabel="Live daily cap" label={voice.liveDailyCapMinutes ? `${voice.liveDailyCapMinutes} min` : 'No cap'} value={String(voice.liveDailyCapMinutes)} items={CAP_OPTIONS.map(m => ({ id: String(m), label: m ? `${m} minutes (≈ $${(m * LIVE_RATE_PER_MINUTE).toFixed(2)})` : 'No cap' }))} onSelect={id => void save({ liveDailyCapMinutes: Number(id) })} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
