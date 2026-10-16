import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Behaviour = 'speaks' | 'fails' | 'missing' | 'silent' | 'hangs'

// The programs as this computer has them: each one speaks, fails, writes nothing, hangs or is not installed.
const programs = vi.hoisted(() => ({
  behaviour: (_command: string, _args: string[]): Behaviour => 'speaks',
  calls: [] as Array<{ command: string; args: string[]; input?: string; timeoutMs?: number }>,
  hung: [] as Array<() => void>
}))

vi.mock('./exec.ts', async () => {
  const fsp = await import('node:fs/promises')
  const wav = Buffer.concat([Buffer.from('RIFF\u0024\u0000\u0000\u0000WAVEfmt ', 'latin1'), Buffer.alloc(64)])

  return {
    MISSING_BINARY: 127,
    run: async (command: string, args: string[], timeoutMs?: number, input?: string) => {
      programs.calls.push({ command, args, input, timeoutMs })
      const behaviour = programs.behaviour(command, args)
      const out = args[args.findIndex(arg => arg === '-o' || arg === '-w') + 1]

      switch (behaviour) {
        case 'missing':
          return { code: 127, stdout: '', stderr: '' }
        case 'fails':
          return { code: 1, stdout: '', stderr: 'Error: The specified espeak-ng voice does not exist.\nmore\n' }
        case 'silent':
          return { code: 0, stdout: '', stderr: '' }
        case 'hangs':
          await new Promise<void>(resolve => programs.hung.push(resolve))
          await fsp.writeFile(out, wav)

          return { code: 0, stdout: '', stderr: '' }
        default:
          await fsp.writeFile(out, wav)

          return { code: 0, stdout: '', stderr: '' }
      }
    }
  }
})

const { cappedText, espeakLanguages, linuxSpeech, MAC_SPEECH, MAX_SYSTEM_SPEECH_CHARS, RENDER_TIMEOUT_MS, renderSystemSpeech } = await import('./system-voice.ts')

const wavPath = (call: { args: string[] }) => call.args[call.args.findIndex(arg => arg === '-o' || arg === '-w') + 1]
const shape = (commands: ReturnType<typeof linuxSpeech>) => commands.map(({ command, args }) => [command, ...args('<wav>')].join(' '))

beforeEach(() => {
  programs.behaviour = () => 'speaks'
  programs.calls.length = 0
  programs.hung.length = 0
})

describe('the system voice on macOS', () => {
  it('renders with say, the text on stdin and never on its command line, and leaves no file behind', async () => {
    const result = await renderSystemSpeech('Hello. This is Hermes, speaking from Herald OS.', MAC_SPEECH)

    expect(result.ok).toBe(true)
    expect(result.ok && Buffer.from(result.audio).toString('latin1', 0, 4)).toBe('RIFF')
    expect(result.ok && result.mimeType).toBe('audio/wav')
    expect(programs.calls).toHaveLength(1)

    const [call] = programs.calls
    expect(call.command).toBe('/usr/bin/say')
    expect(call.args).toEqual(['-o', wavPath(call), '--file-format=WAVE', '--data-format=LEI16@22050'])
    expect(call.input).toBe('Hello. This is Hermes, speaking from Herald OS.')
    expect(call.args.join(' ')).not.toContain('Hermes')
    expect(call.timeoutMs).toBe(RENDER_TIMEOUT_MS)
    expect(fs.existsSync(path.dirname(wavPath(call)))).toBe(false)
  })

  it('says why it failed, and still cleans up', async () => {
    programs.behaviour = () => 'fails'

    expect(await renderSystemSpeech('Hello.', MAC_SPEECH)).toEqual({ ok: false, reason: 'failed', detail: 'say exited with 1: Error: The specified espeak-ng voice does not exist.' })
    expect(fs.existsSync(path.dirname(wavPath(programs.calls[0])))).toBe(false)
  })

  it('fails a run that wrote no audio', async () => {
    programs.behaviour = () => 'silent'

    expect(await renderSystemSpeech('Hello.', MAC_SPEECH)).toEqual({ ok: false, reason: 'failed', detail: 'say wrote no usable audio' })
  })

  it('reports missing when the program is not there', async () => {
    programs.behaviour = () => 'missing'

    expect(await renderSystemSpeech('Hello.', MAC_SPEECH)).toEqual({ ok: false, reason: 'missing', detail: 'say is not installed' })
  })
})

describe('the system voice on Linux', () => {
  it('asks espeak-ng for the locale, then its language, then the default voice; flite only for English', () => {
    expect(shape(linuxSpeech('pt_BR.UTF-8'))).toEqual([
      'espeak-ng -v pt-br --stdin -w <wav>',
      'espeak-ng -v pt --stdin -w <wav>',
      'espeak-ng --stdin -w <wav>',
      'espeak -v pt-br --stdin -w <wav>',
      'espeak -v pt --stdin -w <wav>',
      'espeak --stdin -w <wav>'
    ])
    expect(shape(linuxSpeech('en-US')).at(-1)).toBe('flite -voice slt -o <wav>')
    expect(shape(linuxSpeech('C')).at(-1)).toBe('flite -voice slt -o <wav>')
    expect(shape(linuxSpeech('zh-CN')).some(command => command.startsWith('flite'))).toBe(false)
  })

  it('reads the language out of glibc and BCP 47 locales', () => {
    expect(espeakLanguages('pt_BR.UTF-8')).toEqual(['pt-br', 'pt'])
    expect(espeakLanguages('en')).toEqual(['en'])
    expect(espeakLanguages('zh-Hans-CN')).toEqual(['zh-hans-cn', 'zh'])
    expect(espeakLanguages('C')).toEqual([])
    expect(espeakLanguages('POSIX')).toEqual([])
    expect(espeakLanguages('')).toEqual([])
  })

  it('moves on to the language and then the next program when one fails or is missing', async () => {
    programs.behaviour = (command, args) => (command === 'espeak-ng' ? 'missing' : args.includes('pt-br') ? 'fails' : 'speaks')

    const result = await renderSystemSpeech('Olá, aqui é o Hermes.', linuxSpeech('pt-BR'))

    expect(result.ok).toBe(true)
    expect(programs.calls.map(call => [call.command, ...call.args.slice(0, 2)].join(' '))).toEqual(['espeak-ng -v pt-br', 'espeak -v pt-br', 'espeak -v pt'])
    expect(programs.calls.every(call => call.input === 'Olá, aqui é o Hermes.')).toBe(true)
  })

  it('stands in with flite on the Herald OS image, which has no espeak-ng', async () => {
    programs.behaviour = command => (command === 'flite' ? 'speaks' : 'missing')

    const result = await renderSystemSpeech('Hello there.', linuxSpeech('en-US'))

    expect(result.ok).toBe(true)
    expect(programs.calls.map(call => call.command)).toEqual(['espeak-ng', 'espeak', 'flite'])
  })

  it('reports missing when none of the programs is installed', async () => {
    programs.behaviour = () => 'missing'

    expect(await renderSystemSpeech('Hello there.', linuxSpeech('en-US'))).toEqual({ ok: false, reason: 'missing', detail: 'espeak-ng, espeak, flite are not installed' })
    expect(await renderSystemSpeech('Olá.', linuxSpeech('pt-BR'))).toEqual({ ok: false, reason: 'missing', detail: 'espeak-ng, espeak are not installed' })
  })

  it('reports missing where no voice is known at all', async () => {
    expect(await renderSystemSpeech('Hello there.', [])).toMatchObject({ ok: false, reason: 'missing' })
    expect(programs.calls).toHaveLength(0)
  })
})

describe('limits', () => {
  it('cuts long text at a word and says nothing for blank text', async () => {
    const long = 'word '.repeat(600)

    expect(cappedText(long).length).toBeLessThanOrEqual(MAX_SYSTEM_SPEECH_CHARS)
    expect(cappedText(long).endsWith('word')).toBe(true)
    expect(cappedText('one\n\ntwo   three')).toBe('one two three')

    await renderSystemSpeech(long, MAC_SPEECH)
    expect(programs.calls[0].input?.length).toBeLessThanOrEqual(MAX_SYSTEM_SPEECH_CHARS)

    expect(await renderSystemSpeech('  \n ', MAC_SPEECH)).toEqual({ ok: false, reason: 'failed', detail: 'there was nothing to say' })
    expect(programs.calls).toHaveLength(1)
  })

  it('refuses a fifth line while four are rendering', async () => {
    programs.behaviour = () => 'hangs'
    const running = [1, 2, 3, 4].map(() => renderSystemSpeech('Hello.', MAC_SPEECH))
    await vi.waitFor(() => expect(programs.hung).toHaveLength(4))

    expect(await renderSystemSpeech('Hello.', MAC_SPEECH)).toEqual({ ok: false, reason: 'failed', detail: 'the system voice is busy with other lines' })

    for (const release of programs.hung) {
      release()
    }

    expect((await Promise.all(running)).every(result => result.ok)).toBe(true)
    programs.behaviour = () => 'speaks'
    expect((await renderSystemSpeech('Hello.', MAC_SPEECH)).ok).toBe(true)
  })
})
