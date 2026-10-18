import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { devServerUrl, isPackaged, isShellPage, rendererIndex } from './paths.ts'

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

describe('isPackaged', () => {
  it('knows an installed build by its app.asar', () => {
    expect(isPackaged('/Applications/Herald OS.app/Contents/Resources/app.asar/dist/electron/main.mjs')).toBe(true)
    expect(isPackaged('/usr/share/herald-os/app/resources/app.asar/dist/electron/main.mjs')).toBe(true)
    expect(isPackaged('C:\\Program Files\\Herald OS\\resources\\app.asar\\dist\\electron\\main.mjs')).toBe(true)
  })

  it('and a checkout by its absence', () => {
    expect(isPackaged('/Users/sam/Herald-OS/apps/desktop/dist/electron/main.mjs')).toBe(false)
    expect(isPackaged()).toBe(false)
  })
})
