import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvInfo } from '../../shared/ipc.ts'
import { loadMemory, parse, serialize } from '../features/memory/memory-store.ts'
import { $env } from '../store/backend.ts'
import type { CommandContext } from '../store/os-commands.ts'
import { memoryCommands } from './memory.ts'

const AGENT: CommandContext = { source: 'agent' }
const HOME = '/home/sam/.hermes'
const MEMORY = `${HOME}/memories/MEMORY.md`

// The Electron file bridge, backed by a map from path to file text; showing the page reads the viewport and motion settings.
const files = vi.hoisted(() => {
  const files = new Map<string, string>()
  Object.assign(globalThis, {
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      heraldOS: {
        fs: {
          readDir: async (dir: string) => [...files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => ({ name: path.slice(dir.length + 1), path, isDirectory: false, size: 0, modifiedAt: 1 })),
          readFile: async (path: string) => ({ path, kind: 'text', size: 0, content: files.get(path) ?? '' }),
          writeText: async (path: string, content: string) => {
            files.set(path, content)
          },
          mkdir: async () => undefined
        }
      },
      matchMedia: () => ({ matches: false }),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    },
    document: { documentElement: { dataset: {} } }
  })

  return files
})

const command = (id: string) => memoryCommands.find(c => c.id === id)!

describe('memory commands', () => {
  beforeEach(async () => {
    $env.set({ hermesHome: HOME } as EnvInfo)
    files.set(MEMORY, serialize(['Sam prefers short answers.']))
    await loadMemory(HOME)
    files.set(MEMORY, serialize(['Sam prefers short answers.', 'Deploys go out on Fridays.']))
  })

  it('find an entry Hermes saved after the Memory page loaded, to forget it', async () => {
    const result = await command('memory.forget').run({ match: 'deploys go out on fridays' }, AGENT)

    expect(result.ok).toBe(true)
    expect(parse(files.get(MEMORY)!)).toEqual(['Sam prefers short answers.'])
  })

  it('find an entry Hermes saved after the Memory page loaded, to update it', async () => {
    const result = await command('memory.update').run({ match: 'deploys go out on fridays', text: 'Deploys go out on Thursdays.' }, AGENT)

    expect(result.ok).toBe(true)
    expect(parse(files.get(MEMORY)!)).toEqual(['Sam prefers short answers.', 'Deploys go out on Thursdays.'])
  })
})
