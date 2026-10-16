// The whole spoken-output chain: the configured provider (switched to the free Edge voice when it is
// not set up, see provider-fallback.ts), then the computer's own voice (system-voice.ts). When the
// system voice stands in, or nothing can speak, one plain notice a session says so; the technical
// detail goes to the shell window's console, which main copies into herald-os.log.
import { t } from '../../store/i18n.ts'
import { deviceNoun, hostPlatform } from '../platform-labels.ts'
import { currentProvider, failedProvider, withProviderFallback } from './provider-fallback.ts'
import { type PlaybackTicket, playbackTicket, playClip, synthesizeOnce } from './speak-stream.ts'
import { SystemVoiceError, speakWithSystemVoice } from './system-voice.ts'

/** Who said a line. */
export type SpeechOutcome =
  /** Hermes's voice: the configured provider, or the free one it was just switched to. */
  | { spokenBy: 'provider'; provider: string | null }
  /** Hermes's voice failed (`failed` is its provider, when known) and the computer's own voice said the line. */
  | { spokenBy: 'system'; failed: string | null }
  /** Nothing could say it: the computer has no voice for the person's language, or that failed too. */
  | { spokenBy: 'none'; failed: string | null; system: 'missing' | 'failed' }
  /** Nothing to say, or barge-in, the stop button or the end of the conversation silenced it first. */
  | { spokenBy: 'skipped' }

export type FallbackOutcome = Extract<SpeechOutcome, { spokenBy: 'system' | 'none' }>

export interface SpeakOptions {
  signal?: { stopped: boolean }
  /** The configured provider was not set up, and the free one speaks from now on. */
  onSwitched?: (from: string | null, to: string) => void
  /** Posts the session's notice; without it the caller reports the outcome itself, and that counts as the notice. */
  notify?: (title: string, body: string, level: 'info' | 'warn') => void
}

const PROVIDER_NAMES: Record<string, string> = {
  nous: 'Nous',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  neutts: 'NeuTTS',
  kittentts: 'KittenTTS',
  piper: 'Piper',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  gemini: 'Gemini',
  xai: 'xAI',
  deepinfra: 'DeepInfra'
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A provider's voice, to begin a sentence: Microsoft's free voice for Edge, Hermes's when the provider is not known. */
function voiceName(provider: string | null): string {
  if (provider === 'edge') {
    return t('voice.name.edge')
  }

  return provider ? t('voice.name.provider', { provider: PROVIDER_NAMES[provider] ?? provider }) : t('voice.name.hermes')
}

/** The computer's own voice, inside a sentence. */
function systemVoiceName(): string {
  return hostPlatform() === 'darwin' ? t('voice.name.mac') : t('voice.name.system')
}

/** What usually brings the failed voice back: a newer Hermes for Edge, another choice for the rest. */
function remedy(provider: string | null): string {
  if (provider === 'edge') {
    return t('voice.fallback.updateHermes')
  }

  return provider ? t('voice.fallback.pickAnother') : ''
}

const withRemedy = (text: string, provider: string | null): string => [text, remedy(provider)].filter(Boolean).join(' ')

/** The notice for a line the system voice said in place of Hermes's voice, or that nothing could say. */
export function fallbackNotice(outcome: FallbackOutcome): string {
  const voice = voiceName(outcome.failed)
  const system = systemVoiceName()

  if (outcome.spokenBy === 'system') {
    return withRemedy(t('voice.fallback.usingSystem', { voice, system }), outcome.failed)
  }

  return withRemedy(outcome.system === 'missing' ? t('voice.fallback.noSystemVoice', { voice, device: deviceNoun() }) : t('voice.fallback.systemFailed', { voice, system }), outcome.failed)
}

/** What Settings > Voice > Say hello reports: which voice said hello, and why when it was not Hermes's. */
export function helloReport(outcome: SpeechOutcome): { tone: 'info' | 'warn' | 'danger'; text: string } | null {
  switch (outcome.spokenBy) {
    case 'provider':
      return { tone: 'info', text: t('voice.test.provider', { voice: voiceName(outcome.provider) }) }
    case 'system':
      return { tone: 'warn', text: withRemedy(t('voice.test.usedSystem', { voice: voiceName(outcome.failed), system: systemVoiceName() }), outcome.failed) }
    case 'none':
      return {
        tone: 'danger',
        text: withRemedy(
          outcome.system === 'missing' ? t('voice.test.noSystemVoice', { voice: voiceName(outcome.failed), device: deviceNoun() }) : t('voice.test.systemFailed', { voice: voiceName(outcome.failed), system: systemVoiceName() }),
          outcome.failed
        )
      }
    default:
      return null
  }
}

const noticed = new Set<FallbackOutcome['spokenBy']>()

function noticeOnce(outcome: FallbackOutcome, notify: SpeakOptions['notify']): void {
  if (noticed.has(outcome.spokenBy)) {
    return
  }

  noticed.add(outcome.spokenBy)
  notify?.(t('voice.fallback.title'), fallbackNotice(outcome), outcome.spokenBy === 'system' ? 'info' : 'warn')
}

/** Hermes's voice failed: say the line with the computer's own voice, or say once that nothing can. */
async function standIn(text: string, error: unknown, ticket: PlaybackTicket, options: SpeakOptions): Promise<SpeechOutcome> {
  // The configured name ("nous") is the one the person knows; the error's ("openai") when Hermes cannot be asked.
  const failed = (await currentProvider('tts')) ?? failedProvider(error)
  console.warn(`[voice] speech from ${failed ?? 'Hermes'} failed, so the system voice is standing in: ${messageOf(error)}`)

  try {
    const heard = await speakWithSystemVoice(text, ticket, () => noticeOnce({ spokenBy: 'system', failed }, options.notify))

    return heard ? { spokenBy: 'system', failed } : { spokenBy: 'skipped' }
  } catch (systemError) {
    const outcome: FallbackOutcome = { spokenBy: 'none', failed, system: systemError instanceof SystemVoiceError ? systemError.reason : 'failed' }
    console.warn(`[voice] the system voice could not say it either (${outcome.system}): ${messageOf(systemError)}`)
    noticeOnce(outcome, options.notify)

    return outcome
  }
}

/**
 * Say a line however it can be said: Hermes's configured voice (switched to the free one when it
 * is not set up), else the computer's own. Rejects only when Hermes's voice made the line and it
 * could not be played.
 */
export async function speakWithFallbacks(text: string, options: SpeakOptions = {}): Promise<SpeechOutcome> {
  const ticket = playbackTicket()
  const silenced = () => !ticket() || Boolean(options.signal?.stopped)
  let clip: Awaited<ReturnType<typeof synthesizeOnce>>

  try {
    clip = await withProviderFallback('tts', () => synthesizeOnce(text), options.onSwitched)
  } catch (error) {
    return silenced() ? { spokenBy: 'skipped' } : standIn(text, error, ticket, options)
  }

  if (!clip || silenced()) {
    return { spokenBy: 'skipped' }
  }

  await playClip(clip.src, ticket)

  return { spokenBy: 'provider', provider: clip.provider }
}

/** Test seam: a new session, whose notices have not been shown. */
export function resetSpeakFallback(): void {
  noticed.clear()
}
