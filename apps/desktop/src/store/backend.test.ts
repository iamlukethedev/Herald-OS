import { describe, expect, it } from 'vitest'
import type { HeraldOSPrefs, NotifyPrefs } from '../../shared/ipc.ts'

// A deferred promise per bridge call, so a test decides when main answers.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })

  return { promise, resolve, reject }
}

const bridge = {
  prefsGet: deferred<HeraldOSPrefs>(),
  adopt: deferred<HeraldOSPrefs>(),
  adopted: [] as Partial<NotifyPrefs>[]
}
const storage = new Map<string, string>([['herald-os.notify.approvals', 'false']])

Object.assign(globalThis, {
  window: {
    heraldOS: {
      backend: { onState: () => () => undefined, getState: () => new Promise(() => undefined) },
      window: { onState: () => () => undefined, getState: () => new Promise(() => undefined) },
      env: () => new Promise(() => undefined),
      prefs: {
        get: () => bridge.prefsGet.promise,
        adoptLegacyNotify: (flags: Partial<NotifyPrefs>) => {
          bridge.adopted.push(flags)

          return bridge.adopt.promise
        },
        onChanged: () => () => undefined
      }
    }
  },
  document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } },
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => void storage.delete(key) }
})

const { $prefs, $prefsLoaded, bindBackendStores } = await import('./backend.ts')

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the renderer prefs before main answers', () => {
  it('start with every Alerts switch on and alerts held back', () => {
    expect($prefs.get().notify).toEqual({ toolCompletions: true, approvals: true, taskUpdates: true, nativeWhenUnfocused: true })
    expect($prefsLoaded.get()).toBe(false)
  })
})

describe('loading the prefs', () => {
  it('marks them loaded only after the saved prefs are in and the old switches are migrated', async () => {
    bindBackendStores()
    const saved = { ...$prefs.get(), notify: { toolCompletions: true, approvals: true, taskUpdates: false, nativeWhenUnfocused: true } }

    bridge.prefsGet.resolve(saved)
    await settle()
    expect($prefs.get().notify.taskUpdates).toBe(false)
    expect(bridge.adopted).toEqual([{ approvals: false }])
    expect($prefsLoaded.get()).toBe(false)

    bridge.adopt.resolve({ ...saved, notify: { ...saved.notify, approvals: false } })
    await settle()
    expect($prefs.get().notify.approvals).toBe(false)
    expect(storage.has('herald-os.notify.approvals')).toBe(false)
    expect($prefsLoaded.get()).toBe(true)
  })

  it('still lets alerts through when the prefs cannot be read, so they are not held back for good', async () => {
    $prefsLoaded.set(false)
    bridge.prefsGet = deferred<HeraldOSPrefs>()
    const errors: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void errors.push(args)

    try {
      bindBackendStores()
      bridge.prefsGet.reject(new Error('no prefs'))
      await settle()
    } finally {
      console.error = error
    }

    expect($prefsLoaded.get()).toBe(true)
    expect(errors).toHaveLength(1)
  })
})
