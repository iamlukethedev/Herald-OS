import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { localeTag } from '../../shared/i18n.ts'
import type { SystemSpeech } from '../../shared/ipc.ts'
import { MISSING_BINARY, run } from './exec.ts'

/*
 * The computer's own voice, the last resort when Hermes cannot speak (Microsoft's free voice refused,
 * the network down). A line is rendered to a WAV file and handed to the renderer, which plays it on
 * the player Hermes's own speech uses: echo cancellation only removes what Chromium plays, so a voice
 * the system played itself would reach the microphone and interrupt itself. The text reaches the
 * program on stdin, never on its command line.
 */

/** Longest text rendered at once; the renderer sends a reply a few sentences at a time. */
export const MAX_SYSTEM_SPEECH_CHARS = 1000
/** `say` takes a second or two to start, then renders about five times faster than it speaks. */
export const RENDER_TIMEOUT_MS = 30_000
/** Far more than a capped line makes, so a bigger file is not that line. */
const MAX_CLIP_BYTES = 16 * 1024 * 1024
/** A reply renders one part ahead of the one playing; this leaves room for an announcement as well. */
const MAX_RENDERS = 4

let rendering = 0

/** One way to render speech: the program, and its arguments for the WAV file it writes. */
export interface SpeechCommand {
  command: string
  args: (wav: string) => string[]
}

/** macOS's `say`, in the voice chosen under System Settings > Accessibility > Spoken Content. */
export const MAC_SPEECH: readonly SpeechCommand[] = [{ command: '/usr/bin/say', args: wav => ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@22050'] }]

/** The languages to ask espeak-ng for, most specific first: `pt_BR.UTF-8` gives `pt-br`, then `pt`. None for `C` or `POSIX`. */
export function espeakLanguages(locale: string): string[] {
  const tag = localeTag(locale)?.toLowerCase() ?? ''
  const base = tag.split('-')[0]

  if (!/^[a-z]{2,3}$/.test(base) || base === 'und') {
    return []
  }

  return tag === base ? [tag] : [tag, base]
}

/**
 * Linux's voices, best first: espeak-ng (or the older espeak) in the person's language, then in its
 * default one; then flite, which speaks only English, so only for an English locale.
 */
export function linuxSpeech(locale: string): SpeechCommand[] {
  const languages = espeakLanguages(locale)
  const espeak = ['espeak-ng', 'espeak'].flatMap(command => [
    ...languages.map(language => ({ command, args: (wav: string) => ['-v', language, '--stdin', '-w', wav] })),
    { command, args: (wav: string) => ['--stdin', '-w', wav] }
  ])
  const english = languages.length === 0 || languages.at(-1) === 'en'

  return english ? [...espeak, { command: 'flite', args: wav => ['-voice', 'slt', '-o', wav] }] : espeak
}

/** `text` on one line, at most MAX_SYSTEM_SPEECH_CHARS long, cut at a word when one ends late enough. */
export function cappedText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  if (flat.length <= MAX_SYSTEM_SPEECH_CHARS) {
    return flat
  }

  const cut = flat.slice(0, MAX_SYSTEM_SPEECH_CHARS)
  const space = cut.lastIndexOf(' ')

  return (space > MAX_SYSTEM_SPEECH_CHARS / 2 ? cut.slice(0, space) : cut).trim()
}

const isWav = (bytes: Buffer): boolean => bytes.length > 44 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE'

/** Why one program made no clip, for the log. */
function failure(name: string, code: number, stderr: string, tookMs: number): string {
  if (code === 0) {
    return `${name} wrote no usable audio`
  }

  if (tookMs >= RENDER_TIMEOUT_MS) {
    return `${name} took longer than ${RENDER_TIMEOUT_MS / 1000} s`
  }

  const reason = stderr.trim().split('\n')[0]?.slice(0, 200)

  return `${name} exited with ${code}${reason ? `: ${reason}` : ''}`
}

/** Say `text` with the first of `commands` this computer has, as a WAV clip; `missing` when it has none of them. */
export async function renderSystemSpeech(text: string, commands: readonly SpeechCommand[]): Promise<SystemSpeech> {
  const line = cappedText(text)
  const programs = [...new Set(commands.map(({ command }) => path.basename(command)))]

  if (!line) {
    return { ok: false, reason: 'failed', detail: 'there was nothing to say' }
  }

  if (programs.length === 0) {
    return { ok: false, reason: 'missing', detail: `no system voice is known on ${process.platform}` }
  }

  if (rendering >= MAX_RENDERS) {
    return { ok: false, reason: 'failed', detail: 'the system voice is busy with other lines' }
  }

  rendering++
  const missing = new Set<string>()
  let detail = ''
  let dir: string | null = null

  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-os-voice-'))
    const wav = path.join(dir, 'speech.wav')

    for (const { command, args } of commands) {
      if (missing.has(command)) {
        continue
      }

      const started = Date.now()
      const result = await run(command, args(wav), RENDER_TIMEOUT_MS, line)

      if (result.code === MISSING_BINARY) {
        missing.add(command)
        continue
      }

      const audio = result.code === 0 ? await fs.readFile(wav).catch(() => null) : null

      if (audio && isWav(audio) && audio.length <= MAX_CLIP_BYTES) {
        return { ok: true, audio: new Uint8Array(audio), mimeType: 'audio/wav' }
      }

      detail = failure(path.basename(command), result.code, result.stderr, Date.now() - started)
      await fs.rm(wav, { force: true })
    }
  } catch (error) {
    detail = `the system voice could not run: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    rendering--

    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (!detail) {
    return { ok: false, reason: 'missing', detail: `${programs.join(', ')} ${programs.length === 1 ? 'is' : 'are'} not installed` }
  }

  return { ok: false, reason: 'failed', detail }
}
