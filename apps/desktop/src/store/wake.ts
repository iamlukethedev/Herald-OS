import { atom } from 'nanostores'
import { MicrophoneUnavailableError, subscribeMicrophone } from '../lib/voice/audio-capture.ts'
import { earcons } from '../lib/voice/earcons.ts'
import { FrameSlicer, int16ToBase64, TARGET_SAMPLE_RATE } from '../lib/voice/pcm.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { $gatewayReady, gatewayRequest, onGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { isMainSurface } from './shell.ts'
import { startVoice } from './voice.ts'

export interface WakeSnapshot {
  /** The backend detector is armed and receiving our audio. */
  listening: boolean
  /** Armed but muted while a conversation runs. */
  paused: boolean
  phrase: string
  /** `client` when this window streams the audio, `local` when the backend opened the host mic itself. */
  capture: string
  /** Why the detector could not be armed, if it could not. */
  error: string | null
}

export const $wake = atom<WakeSnapshot>({ listening: false, paused: false, phrase: 'hey hermes', capture: 'client', error: null })

const DEFAULT_FRAME_LENGTH = 1280

let desired = false
let armed = false
let paused = false
let stopFeed: (() => void) | null = null
let arming: Promise<void> | null = null
let feedInFlight = 0
/** The error the microphone failure set, so frames resuming clear that one and no other. */
let microphoneError: string | null = null

function patch(next: Partial<WakeSnapshot>): void {
  $wake.set({ ...$wake.get(), ...next })
}

async function startFeeding(frameLength: number): Promise<void> {
  stopFeeding()
  const slicer = new FrameSlicer(frameLength)
  stopFeed = await subscribeMicrophone(
    frame => {
      // Frames again after a failed reopen: the detector hears once more. Only the microphone's own
      // error goes; one set since (another client owns the wake word, say) is still true.
      if (microphoneError !== null) {
        if ($wake.get().error === microphoneError) {
          patch({ error: null })
        }

        microphoneError = null
      }

      if (paused || !armed) {
        return
      }

      for (const chunk of slicer.push(frame.pcm)) {
        // Never let a slow backend pile up requests: drop frames when more than a few are in flight.
        if (feedInFlight > 6) {
          continue
        }

        feedInFlight++
        gatewayRequest('wake.feed', { pcm_b64: int16ToBase64(chunk), sample_rate: TARGET_SAMPLE_RATE }, 5000)
          .catch(() => undefined)
          .finally(() => {
            feedInFlight--
          })
      }
    },
    // The feed stays subscribed and resumes on the next device change or pick; until then the
    // wake word cannot hear, and Settings says why.
    error => {
      microphoneError = `Wake word cannot hear: ${error.message}`
      patch({ error: microphoneError })
    }
  )
}

function stopFeeding(): void {
  stopFeed?.()
  stopFeed = null
}

async function arm(): Promise<void> {
  if (armed || arming) {
    return arming ?? undefined
  }

  arming = (async () => {
    let result = await gatewayRequest('wake.start', { surface: 'gui', client_capture: true, persist: true })

    // A previous renderer (reload, crash) may still be recorded as owner until the backend notices
    // its transport is gone; give it a moment and try again before reporting the conflict.
    for (let attempt = 0; !result.started && result.reason === 'owned' && attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      result = await gatewayRequest('wake.start', { surface: 'gui', client_capture: true, persist: true })
    }

    if (!result.started) {
      const reason = result.reason ?? 'unavailable'
      const hint = result.hint || ''
      const message =
        reason === 'owned'
          ? `Another Hermes client (${result.owner_surface ?? 'unknown'}) owns the wake word.`
          : reason === 'disabled_for_surface'
            ? 'wake_word.surface in config.yaml excludes GUI clients.'
            : `Wake word unavailable${hint ? `: ${hint}` : ''}`
      patch({ listening: false, error: message })

      return
    }

    armed = true
    paused = false
    patch({ listening: true, paused: false, phrase: result.phrase ?? 'hey hermes', error: null, capture: result.capture ?? 'client' })

    // `local`: the backend opened the host microphone itself (older runtimes, or wake_word.capture
    // pinned in config); feeding our frames would be ignored, so only stream when asked to.
    if (result.capture && result.capture !== 'client' && result.capture !== 'remote' && result.capture !== 'external') {
      return
    }

    try {
      await startFeeding(result.frame_length ?? DEFAULT_FRAME_LENGTH)
    } catch (error) {
      armed = false
      await gatewayRequest('wake.stop', {}).catch(() => undefined)
      const message = error instanceof MicrophoneUnavailableError ? error.message : `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`
      patch({ listening: false, error: message })
      notify({ title: 'Wake word', body: message, level: 'warn' })
    }
  })().finally(() => {
    arming = null
  })

  return arming
}

async function disarm(persist: boolean): Promise<void> {
  stopFeeding()

  if (armed) {
    armed = false
    await gatewayRequest('wake.stop', { persist }).catch(() => undefined)
  }

  paused = false
  patch({ listening: false, paused: false })
}

/** Mute the detector while a conversation runs (the mic stays open for the engine). */
export async function pauseWake(): Promise<void> {
  if (!armed || paused) {
    return
  }

  paused = true
  patch({ paused: true })
  await gatewayRequest('wake.pause', {}).catch(() => undefined)
}

/** Re-arm after a conversation; falls back to a fresh `wake.start` when the pause lapsed. */
export async function resumeWake(): Promise<void> {
  if (!desired) {
    return
  }

  if (!armed) {
    await arm()

    return
  }

  const result = await gatewayRequest('wake.resume', {}).catch(() => ({ resumed: false }))
  paused = false
  patch({ paused: false })

  if (!result.resumed) {
    armed = false
    stopFeeding()
    await arm()
  }
}

function reconcile(): void {
  const prefs = $prefs.get().voice
  const ready = Boolean($gatewayReady.get())
  const want = ready && prefs.enabled && prefs.wakeWord

  if (want && !desired) {
    desired = true
    void arm()
  } else if (!want && desired) {
    desired = false
    void disarm(!prefs.wakeWord)
  } else if (!ready && armed) {
    // Backend went away: the detector is gone with it.
    stopFeeding()
    armed = false
    paused = false
    patch({ listening: false, paused: false })
  } else if (want && desired && ready && !armed && !arming) {
    void arm()
  }
}

let bound = false

export function bindWake(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const offPrefs = $prefs.subscribe(reconcile)
  const offReady = $gatewayReady.subscribe(reconcile)
  const offDetected = onGatewayEvent('wake.detected', () => {
    if (!armed || paused) {
      return
    }

    earcons.wake()
    void startVoice('wake')
  })

  return () => {
    offPrefs()
    offReady()
    offDetected()
    bound = false
  }
}

/** Settings toggle: persist the preference; `reconcile` arms or disarms. */
export function setWakeWordEnabled(enabled: boolean): Promise<void> {
  const prefs = $prefs.get().voice

  return updatePrefs({ voice: { ...prefs, wakeWord: enabled, enabled: enabled ? true : prefs.enabled } })
}
