import { atom } from 'nanostores'
import { rest } from '../lib/rest.ts'
import { subscribeMicrophone } from '../lib/voice/audio-capture.ts'
import { parseDictationText } from '../lib/voice/dictation.ts'
import { bytesToBase64, concatInt16, encodeWav, TARGET_SAMPLE_RATE } from '../lib/voice/pcm.ts'
import { withProviderFallback } from '../lib/voice/provider-fallback.ts'
import { DEFAULT_ENDPOINTER, Endpointer } from '../lib/voice/vad.ts'
import { notify } from './notifications.ts'
import { isMainSurface, isPanels, onShellCommand, surface } from './shell.ts'
import { $voiceActive } from './voice.ts'

/*
 * Dictation into any app: one key starts listening, a pause (or the key again) ends it, Hermes's
 * speech-to-text turns it into words with spoken punctuation applied, and main types them into
 * whatever field has focus. Nothing goes to the model; this is transcription only.
 */

export type DictationPhase = 'idle' | 'listening' | 'transcribing'

export const $dictation = atom<{ phase: DictationPhase }>({ phase: 'idle' })

/** Longer pauses than a conversation: people think between sentences when they dictate. */
const DICTATION_ENDPOINTER = { ...DEFAULT_ENDPOINTER, silenceMs: 1500, maxWaitMs: 8000, maxSpeechMs: 120_000 }
/** Less than this much audio is a key press, not speech. */
const MIN_SAMPLES = TARGET_SAMPLE_RATE * 0.3

interface TranscribeResult {
  transcript?: string
}

let stopMic: (() => void) | null = null
let frames: Int16Array[] = []
let heard = false

async function transcribe(pcm: Int16Array): Promise<string> {
  const wav = encodeWav(pcm)
  const body = { data_url: `data:audio/wav;base64,${bytesToBase64(wav)}`, mime_type: 'audio/wav' }
  const result = await withProviderFallback('stt', () => rest.post<TranscribeResult>('/api/audio/transcribe', body))

  return (result?.transcript ?? '').trim()
}

export async function startDictation(): Promise<void> {
  if ($dictation.get().phase !== 'idle') {
    return
  }

  if ($voiceActive.get()) {
    notify({ title: 'Dictation', body: 'End the voice conversation first; Hermes would hear the dictation too.', level: 'warn' })

    return
  }

  frames = []
  heard = false
  const endpointer = new Endpointer(DICTATION_ENDPOINTER)
  $dictation.set({ phase: 'listening' })

  try {
    stopMic = await subscribeMicrophone(frame => {
      frames.push(frame.pcm)
      const event = endpointer.feed(frame.level, frame.ms)

      if (event === 'speech-start') {
        heard = true
      } else if (event === 'speech-end' || event === 'timeout') {
        void finishDictation()
      }
    })
  } catch (error) {
    $dictation.set({ phase: 'idle' })
    notify({ title: 'Dictation needs the microphone', body: error instanceof Error ? error.message : String(error), level: 'error' })
  }
}

/**
 * The Herald Docs page, Sheets cell or Slides text box in front takes the words itself, one step to
 * undo and the clipboard untouched. Dictation goes to the app in front, so only while Herald is that
 * app; anything that fails leaves the words to main.
 */
async function typedIntoOffice(text: string, submit: boolean): Promise<boolean> {
  if (!isMainSurface || !document.hasFocus()) {
    return false
  }

  try {
    const { typeIntoOffice } = await import('../features/office/typing.ts')

    return (await typeIntoOffice(text, { submit })) !== null
  } catch {
    return false
  }
}

export async function finishDictation(): Promise<void> {
  if ($dictation.get().phase !== 'listening') {
    return
  }

  stopMic?.()
  stopMic = null
  const pcm = concatInt16(frames)
  frames = []

  if (!heard || pcm.length < MIN_SAMPLES) {
    $dictation.set({ phase: 'idle' })

    return
  }

  $dictation.set({ phase: 'transcribing' })

  try {
    const { text, submit } = parseDictationText(await transcribe(pcm))

    if (!text && !submit) {
      notify({ title: 'Dictation', body: 'No words came through. Try again a little closer to the microphone.', level: 'info' })

      return
    }

    if (await typedIntoOffice(text, submit)) {
      return
    }

    const result = await window.heraldOS.dictation.type(text, { submit })

    if (result.copied) {
      notify({ title: 'Dictation copied', body: `Paste it where you want it: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`, level: 'info' })
    }
  } catch (error) {
    notify({ title: 'Dictation failed', body: error instanceof Error ? error.message : String(error), level: 'error' })
  } finally {
    $dictation.set({ phase: 'idle' })
  }
}

export function toggleDictation(): void {
  if ($dictation.get().phase === 'listening') {
    void finishDictation()
  } else {
    void startDictation()
  }
}

let bound = false

/** The Hermes window owns the microphone; hotkeys reach it as a `dictate` ShellCommand. */
export function bindDictation(): () => void {
  if (bound) {
    return () => undefined
  }

  // Panels-mode menu bar: mirror the Hermes window's state for the "Dictating" indicator. Only
  // there: a handler registered early on every surface would swallow the commands that open
  // overlays and panels, which wait in a queue until their window's own handler mounts.
  if (!isMainSurface) {
    if (surface !== 'menubar') {
      return () => undefined
    }

    bound = true

    return onShellCommand(command => {
      const phase = command.args?.[0]

      if (command.type === 'dictation-state' && (phase === 'idle' || phase === 'listening' || phase === 'transcribing')) {
        $dictation.set({ phase })
      }
    })
  }

  bound = true
  const off = onShellCommand(command => {
    if (command.type === 'dictate') {
      toggleDictation()
    }
  })
  // Panels mode: the menu bar is another window; it shows "Listening" from this relay.
  const offRelay = isPanels ? $dictation.listen(state => void window.heraldOS.shell.relay('menubar', { type: 'dictation-state', args: [state.phase] }).catch(() => undefined)) : () => undefined

  return () => {
    off()
    offRelay()
    bound = false
  }
}
