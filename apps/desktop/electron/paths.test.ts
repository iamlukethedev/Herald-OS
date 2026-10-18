import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { devServerUrl, isDev, isShellPage, rendererIndex, setPackaged } from './paths.ts'

const index = '/Applications/Herald OS.app/Contents/Resources/app.asar/dist/renderer/index.html'
const page = pathToFileURL(index).href

describe('isShellPage', () => {
  it('accepts the bundled renderer with any query or hash', () => {
    expect(isShellPage(page, index, undefined)).toBe(true)
    expect(isShellPage(`${page}?surface=dock`, index, undefined)).toBe(true)
    expect(isShellPage(`${page}#/settings`, index, undefined)).toBe(true)
  })

  it('refuses every other local file and remote page in a build', () => {
    expect(isShellPage('file:///Users/me/Downloads/page.html', index, undefined)).toBe(false)
    expect(isShellPage('https://example.com/', index, undefined)).toBe(false)
    expect(isShellPage('about:blank', index, undefined)).toBe(false)
    expect(isShellPage('not a url', index, undefined)).toBe(false)
  })

  it('refuses the renderer path on another host', () => {
    expect(isShellPage(page.replace('file:///', 'file://evil.example/'), index, undefined)).toBe(false)
  })

  it('accepts only the dev server origin in development', () => {
    const dev = 'http://127.0.0.1:5180'

    expect(isShellPage('http://127.0.0.1:5180/?surface=main', index, dev)).toBe(true)
    expect(isShellPage('http://127.0.0.1:51801/', index, dev)).toBe(false)
    expect(isShellPage(page, index, dev)).toBe(false)
  })
})

describe('isShellPage as main calls it', () => {
  const saved = { ...process.env }
  const shell = pathToFileURL(rendererIndex()).href

  beforeEach(() => {
    delete process.env.HERALD_OS_DEV_SERVER
    delete process.env.HERMES_OS_DEV_SERVER
    setPackaged(false)
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('accepts the renderer this build loads, and nothing else', () => {
    expect(isShellPage(shell)).toBe(true)
    expect(isShellPage(`${shell}?surface=terminal`)).toBe(true)
    expect(isShellPage(shell.replace('file:///', 'file://evil.example/'))).toBe(false)
    expect(isShellPage('about:blank')).toBe(false)
    expect(isShellPage('http://127.0.0.1:5180/')).toBe(false)
  })

  it('trusts a dev server named in the environment of a checkout', () => {
    process.env.HERALD_OS_DEV_SERVER = 'http://127.0.0.1:5180'

    expect(isShellPage('http://127.0.0.1:5180/')).toBe(true)
    expect(isDev()).toBe(true)
  })

  it('trusts none in an installed build, as main reports it', () => {
    process.env.HERALD_OS_DEV_SERVER = 'http://127.0.0.1:5180'
    setPackaged(true)

    expect(isShellPage('http://127.0.0.1:5180/')).toBe(false)
    expect(isShellPage(shell)).toBe(true)
  })
})

describe('devServerUrl', () => {
  const env = { HERALD_OS_DEV_SERVER: 'http://127.0.0.1:5180' }

  it('is the one the environment names, in a checkout', () => {
    expect(devServerUrl(env, false)).toBe('http://127.0.0.1:5180')
    expect(devServerUrl({ HERMES_OS_DEV_SERVER: 'http://127.0.0.1:5180' }, false)).toBe('http://127.0.0.1:5180')
  })

  it('is never trusted by an installed build', () => {
    expect(devServerUrl(env, true)).toBeUndefined()
  })
})

describe('before main says whether it is installed', () => {
  it('trusts no dev server', async () => {
    vi.resetModules()
    const fresh = await import('./paths.ts')

    expect(fresh.devServerUrl({ HERALD_OS_DEV_SERVER: 'http://127.0.0.1:5180' })).toBeUndefined()
  })
})
