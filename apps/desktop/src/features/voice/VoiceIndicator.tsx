import { useStore } from '@nanostores/react'
import { IconMicrophone } from '@tabler/icons-react'
import { cn } from '../../lib/cn.ts'
import { $micOpen } from '../../lib/voice/audio-capture.ts'
import { $prefs } from '../../store/backend.ts'
import { useT } from '../../store/i18n.ts'
import { isMainSurface, relayToMain } from '../../store/shell.ts'
import { $voice, toggleVoice } from '../../store/voice.ts'
import { $wake } from '../../store/wake.ts'

/**
 * Menu-bar microphone: the privacy indicator (lit whenever the mic is open) and a one-click way
 * to start or end a conversation. In panels mode the bar is another window, so it relays.
 */
export function VoiceIndicator() {
  const t = useT()
  const prefs = useStore($prefs)
  const voice = useStore($voice)
  const wake = useStore($wake)
  const micOpen = useStore($micOpen)

  if (!prefs.voice.enabled && !micOpen) {
    return null
  }

  const active = voice.state !== 'off' && voice.state !== 'armed'
  const title = active ? t('menuBar.voiceEnd') : wake.listening ? t('menuBar.voiceListening', { phrase: wake.phrase }) : wake.error ? t('menuBar.voiceError', { error: wake.error }) : t('menuBar.voiceStart')
  const onClick = () => {
    if (isMainSurface) {
      void toggleVoice('button')
    } else {
      relayToMain({ type: 'voice', args: ['toggle'] })
    }
  }

  return (
    <button type="button" aria-label={title} title={title} onClick={onClick} className={cn('relative flex size-6 items-center justify-center rounded-md hover:bg-white/10', active && 'bg-white/10')}>
      <IconMicrophone size={15} className={cn(micOpen ? 'text-accent-strong' : wake.error ? 'text-warn' : undefined)} />
      {micOpen && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warn" title={t('menuBar.micOpen')} />}
    </button>
  )
}
