import { beforeEach, describe, expect, it } from 'vitest'
import { $commandLog, defineCommands, listCommands, ok, remapArgNames, resetCommands, runCommand, validateArgs } from './os-commands.ts'

beforeEach(() => {
  resetCommands()
  defineCommands([
    {
      id: 'test.echo',
      title: 'Echo',
      description: 'Echo the text',
      tier: 'read',
      args: [
        { name: 'text', type: 'string', description: 'text', required: true },
        { name: 'times', type: 'number', description: 'repeat' },
        { name: 'loud', type: 'boolean', description: 'shout' },
        { name: 'mode', type: 'string', description: 'mode', enum: ['fast', 'slow'] }
      ],
      run: args => ok(`${String(args.text)}${args.loud ? '!' : ''} x${String(args.times ?? 1)} ${String(args.mode)}`)
    },
    { id: 'test.boom', title: 'Boom', description: '', tier: 'act', args: [], hidden: true, run: () => Promise.reject(new Error('kaboom')) }
  ])
})

describe('validateArgs', () => {
  it('requires required args and coerces types', () => {
    const command = { id: 'test.echo', args: listCommands({ includeHidden: true })[1].args }
    expect(validateArgs(command, {})).toEqual({ error: 'test.echo needs "text" (text)' })
    expect(validateArgs(command, { text: 'hi', times: '3', loud: 'yes' })).toEqual({ args: { text: 'hi', times: 3, loud: true, mode: 'fast' } })
    expect(validateArgs(command, { text: 'hi', mode: 'SLOW' })).toEqual({ args: { text: 'hi', mode: 'slow' } })
    expect(validateArgs(command, { text: 'hi', mode: 'medium' })).toMatchObject({ error: expect.stringContaining('must be one of') })
    expect(validateArgs(command, { text: 'hi', nope: 1 })).toMatchObject({ error: expect.stringContaining('unknown argument') })
  })
})

describe('remapArgNames', () => {
  const pageOpen = { args: [{ name: 'name', type: 'string' as const, description: 'page', required: true }] }
  const windowClose = { args: [{ name: 'name', type: 'string' as const, description: 'window' }] }

  it('moves a single mis-named argument onto the missing one', () => {
    expect(remapArgNames(pageOpen, { page: 'missions' })).toEqual({ name: 'missions' })
    expect(remapArgNames(windowClose, { window: 'terminal' })).toEqual({ name: 'terminal' })
    expect(validateArgs({ id: 'page.open', args: pageOpen.args }, { page: 'missions' })).toEqual({ args: { name: 'missions' } })
  })

  it('leaves ambiguous input alone', () => {
    expect(remapArgNames(pageOpen, { name: 'memory' })).toEqual({ name: 'memory' })
    expect(remapArgNames(pageOpen, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
  })
})

describe('runCommand', () => {
  it('runs, logs and reports results', async () => {
    const result = await runCommand('test.echo', { text: 'hello', loud: true }, { source: 'voice' })
    expect(result).toMatchObject({ ok: true, summary: 'hello! x1 fast' })
    expect($commandLog.get()[0]).toMatchObject({ command: 'test.echo', source: 'voice', args: { text: 'hello', loud: true, mode: 'fast' } })
  })

  it('never throws', async () => {
    expect(await runCommand('test.boom', {}, { source: 'agent' })).toMatchObject({ ok: false, error: 'kaboom' })
    expect(await runCommand('nope.nothing', {}, { source: 'agent' })).toMatchObject({ ok: false, error: 'Unknown command "nope.nothing"' })
  })

  it("reports main's error without the IPC prefix", async () => {
    defineCommands([{ id: 'test.ipc', title: 'IPC', description: '', tier: 'act', args: [], hidden: true, run: () => Promise.reject(new Error("Error invoking remote method 'herald-os:capture:region': Error: Herald OS needs Screen Recording permission. Turn it on.")) }])
    expect(await runCommand('test.ipc', {}, { source: 'agent' })).toMatchObject({ ok: false, error: 'Herald OS needs Screen Recording permission. Turn it on.' })
  })

  it('lists commands without hidden ones by default and rejects bad ids', () => {
    expect(listCommands().map(c => c.id)).toEqual(['test.echo'])
    expect(listCommands({ includeHidden: true }).map(c => c.id)).toEqual(['test.boom', 'test.echo'])
    expect(() => defineCommands([{ id: 'Bad Id', title: '', description: '', tier: 'read', args: [], run: () => ok('') }])).toThrow()
  })
})

describe('defineCommands', () => {
  it('leaves out only the command with a bad id and names it', () => {
    const define = () =>
      defineCommands([
        { id: 'toolSearch.set', title: '', description: '', tier: 'mutate', args: [], run: () => ok('') },
        { id: 'test.after', title: '', description: '', tier: 'read', args: [], run: () => ok('') }
      ])

    expect(define).toThrow('invalid command id toolSearch.set')
    expect(listCommands().map(c => c.id)).toEqual(['test.after', 'test.echo'])
  })
})
