import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeraldOSPrefs, NotifyPrefs, PrefsPatch } from '../../shared/ipc.ts'
import { LEGACY_NOTIFY_KEYS, NOTIFY_DEFAULTS } from '../../shared/notify-prefs.ts'
import { emptyChat } from '../lib/chat-model.ts'

// Gateway handlers are captured so a test can play an event or a server request into the stores.
const gateway = vi.hoisted(() => ({
  events: new Map<string, (event: unknown) => void>(),
  any: [] as ((event: unknown) => void)[],
  requests: [] as ((request: unknown) => boolean)[]
}))

vi.mock('./gateway.ts', () => ({
  gatewayRequest: async () => ({}),
  isGatewayOpen: () => false,
  onGatewayEvent: (type: string, handler: (event: unknown) => void) => {
    gateway.events.set(type, handler)

    return () => gateway.events.delete(type)
  },
  onAnyGatewayEvent: (handler: (event: unknown) => void) => {
    gateway.any.push(handler)

    return () => undefined
  },
  onServerRequest: (handler: (request: unknown) => boolean) => {
    gateway.requests.push(handler)

    return () => undefined
  }
}))

// The preload bridge, faked: prefs writes are recorded and merged switch by switch, as main does.
const bridge = vi.hoisted(() => {
  const state = {
    native: [] as { title: string; body: string }[],
    saved: [] as PrefsPatch[],
    adopted: [] as Partial<NotifyPrefs>[],
    failWrite: false,
    prefs: null as HeraldOSPrefs | null
  }
  const merge = (patch: PrefsPatch): HeraldOSPrefs => {
    state.prefs = { ...state.prefs!, ...(patch as Partial<HeraldOSPrefs>), notify: { ...state.prefs!.notify, ...patch.notify } }

    return state.prefs
  }
  const heraldOS = {
    notifications: {
      native: async (title: string, body: string) => {
        state.native.push({ title, body })
      }
    },
    prefs: {
      set: async (patch: PrefsPatch) => {
        if (state.failWrite) {
          throw new Error('disk full')
        }

        state.saved.push(patch)

        return merge(patch)
      },
      adoptLegacyNotify: async (flags: Partial<NotifyPrefs>) => {
        if (state.failWrite) {
          throw new Error('disk full')
        }

        state.adopted.push(flags)

        return merge({ notify: flags })
      }
    }
  }
  Object.assign(globalThis, { window: { heraldOS }, document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } } })

  return state
})

const { $prefs, $prefsLoaded, $windowState, migrateLegacyNotifyFlags } = await import('./backend.ts')
const { $notifications, $toasts, bindNotificationEvents, dismissToast, notify, setNotifySwitch } = await import('./notifications.ts')
const { $pendingRequests, bindServerRequests } = await import('./requests.ts')
const { $activeChatId, $chats, bindChatEvents } = await import('./chat.ts')

bindNotificationEvents()
bindServerRequests()
bindChatEvents()

function alerts(patch: Partial<NotifyPrefs>, doNotDisturb = false) {
  $prefs.set({ ...$prefs.get(), doNotDisturb, notify: { ...NOTIFY_DEFAULTS, ...patch } })
  bridge.prefs = $prefs.get()
}

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries))

  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key)
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  $notifications.set([])
  $toasts.set([])
  $pendingRequests.set([])
  $windowState.set({ fullscreen: false, focused: false })
  bridge.native.length = 0
  bridge.saved.length = 0
  bridge.adopted.length = 0
  bridge.failWrite = false
  $prefsLoaded.set(true)
  alerts({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('notify and the Alerts switches', () => {
  it('toasts and raises a native notification for every category while the switches are at their defaults', () => {
    expect($prefs.get().notify).toEqual(NOTIFY_DEFAULTS)

    for (const category of ['toolCompletion', 'approval', 'taskUpdate'] as const) {
      notify({ title: category, native: true, category })
    }

    expect($toasts.get().map(t => t.title)).toEqual(['taskUpdate', 'approval', 'toolCompletion'])
    expect(bridge.native.map(n => n.title)).toEqual(['toolCompletion', 'approval', 'taskUpdate'])
  })

  it.each([
    ['toolCompletions', 'toolCompletion'],
    ['approvals', 'approval'],
    ['taskUpdates', 'taskUpdate']
  ] as const)('with %s off, keeps a %s notification in the bell without a toast or a native notification', (key, category) => {
    alerts({ [key]: false })

    const item = notify({ title: 'Quiet', native: true, category })

    expect($notifications.get()).toEqual([item])
    expect($toasts.get()).toEqual([])
    expect(bridge.native).toEqual([])
  })

  it('leaves the other categories, and untagged notifications, alerting when one switch is off', () => {
    alerts({ approvals: false })

    notify({ title: 'Done', native: true, category: 'toolCompletion' })
    notify({ title: 'Crash', native: true })

    expect($toasts.get().map(t => t.title)).toEqual(['Crash', 'Done'])
    expect(bridge.native.map(n => n.title)).toEqual(['Done', 'Crash'])
  })

  it('with native notifications off, still toasts but never calls the native bridge', () => {
    alerts({ nativeWhenUnfocused: false })

    notify({ title: 'Approval needed', native: true, category: 'approval' })
    notify({ title: 'Usage', native: true })

    expect($notifications.get()).toHaveLength(2)
    expect($toasts.get()).toHaveLength(2)
    expect(bridge.native).toEqual([])
  })

  it('still raises no native notification while the window is focused, and none at all under do not disturb', () => {
    $windowState.set({ fullscreen: false, focused: true })
    notify({ title: 'Focused', native: true, category: 'approval' })
    expect(bridge.native).toEqual([])

    $windowState.set({ fullscreen: false, focused: false })
    alerts({}, true)
    notify({ title: 'Quiet', native: true, category: 'approval' })
    expect(bridge.native).toEqual([])
    expect($toasts.get().map(t => t.title)).toEqual(['Focused'])
    expect($notifications.get()).toHaveLength(2)
  })
})

describe('alerts before the prefs are in', () => {
  it('shows uncategorized alerts, such as a crash or an error, at once', () => {
    $prefsLoaded.set(false)

    notify({ title: 'Crash', native: true, level: 'warn' })
    notify({ title: 'Could not save', level: 'error' })

    expect($toasts.get().map(t => t.title)).toEqual(['Could not save', 'Crash'])
    expect(bridge.native.map(n => n.title)).toEqual(['Crash'])
  })

  it('holds categorized alerts in the bell, then replays them once the prefs are in', () => {
    $prefsLoaded.set(false)

    notify({ title: 'Approval needed', native: true, category: 'approval' })
    notify({ title: 'Finished', category: 'toolCompletion' })

    expect($notifications.get()).toHaveLength(2)
    expect($toasts.get()).toEqual([])
    expect(bridge.native).toEqual([])

    $prefsLoaded.set(true)
    expect($toasts.get().map(t => t.title)).toEqual(['Finished', 'Approval needed'])
    expect(bridge.native.map(n => n.title)).toEqual(['Approval needed'])

    // Replayed once only.
    $prefsLoaded.set(false)
    $prefsLoaded.set(true)
    expect(bridge.native).toHaveLength(1)
  })

  it('replays held alerts as the loaded prefs allow', () => {
    $prefsLoaded.set(false)
    notify({ title: 'Approval needed', native: true, category: 'approval' })
    notify({ title: 'Question', native: true, category: 'approval' })
    notify({ title: 'Finished', category: 'toolCompletion' })

    // The saved prefs arrive with Approvals off and native notifications off.
    alerts({ approvals: false, nativeWhenUnfocused: false })
    $prefsLoaded.set(true)

    expect($toasts.get().map(t => t.title)).toEqual(['Finished'])
    expect(bridge.native).toEqual([])
  })

  it('replays a held approval as a toast only while the window is focused, and with no native notification under the native switch off', () => {
    $prefsLoaded.set(false)
    notify({ title: 'Approval needed', native: true, category: 'approval' })
    $windowState.set({ fullscreen: false, focused: true })
    $prefsLoaded.set(true)

    expect($toasts.get().map(t => t.title)).toEqual(['Approval needed'])
    expect(bridge.native).toEqual([])
  })

  it('does not replay a held alert that was read or dismissed meanwhile, nor one held back with toast: false', () => {
    $prefsLoaded.set(false)
    const read = notify({ title: 'Read', native: true, category: 'approval' })
    const gone = notify({ title: 'Dismissed', native: true, category: 'approval' })
    notify({ title: 'Quiet', category: 'taskUpdate', toast: false })
    $notifications.set($notifications.get().filter(n => n.id !== gone.id).map(n => (n.id === read.id ? { ...n, read: true } : n)))

    $prefsLoaded.set(true)

    expect($toasts.get()).toEqual([])
    expect(bridge.native).toEqual([])
  })
})

describe('the callers tagged with a category', () => {
  const request = (id: string, method: string, params: Record<string, unknown>) => {
    for (const handler of gateway.requests) {
      handler({ id, method, params })
    }
  }

  it('silences "Approval needed" and "Hermes has a question" with Approvals off, and keeps the cards waiting', () => {
    alerts({ approvals: false })

    request('r1', 'approval', { description: 'Move test.txt to Documents' })
    request('r2', 'clarify', { question: 'Which folder?' })

    expect($pendingRequests.get().map(entry => entry.kind)).toEqual(['approval', 'clarify'])
    expect($notifications.get().map(n => n.title)).toEqual(['Hermes has a question', 'Approval needed'])
    expect($toasts.get()).toEqual([])
    expect(bridge.native).toEqual([])
  })

  it('still alerts for approvals and questions with Approvals on', () => {
    request('r3', 'approval', { description: 'Move test.txt to Documents' })
    request('r4', 'clarify', { question: 'Which folder?' })

    expect($toasts.get().map(t => t.title)).toEqual(['Hermes has a question', 'Approval needed'])
    expect(bridge.native.map(n => n.title)).toEqual(['Approval needed', 'Hermes has a question'])
  })

  it('silences "Finished a turn in another session" with Finished turns off', () => {
    $chats.set({ s1: emptyChat('s1', 'stored-1') })
    $activeChatId.set('s2')
    const finish = () => gateway.any.forEach(handler => handler({ type: 'message.complete', session_id: 's1', payload: {} }))

    alerts({ toolCompletions: false })
    finish()
    expect($notifications.get().map(n => n.body)).toEqual(['Finished a turn in another session'])
    expect($toasts.get()).toEqual([])

    alerts({})
    finish()
    expect($toasts.get().map(t => t.body)).toEqual(['Finished a turn in another session'])
  })

  it('files scheduled-task changes under Task updates', () => {
    alerts({ taskUpdates: false })
    gateway.events.get('cron.changed')?.({ type: 'cron.changed', payload: {} })

    expect($notifications.get()).toMatchObject([{ title: 'Tasks updated', key: 'cron.changed', category: 'taskUpdate' }])
    expect($toasts.get()).toEqual([])
  })

  it('tags each caller with its own category, and leaves untagged ones without', () => {
    $chats.set({ s1: emptyChat('s1', 'stored-1') })
    $activeChatId.set('s2')
    request('r5', 'approval', { description: 'Move test.txt' })
    request('r6', 'clarify', { question: 'Which folder?' })
    gateway.any.forEach(handler => handler({ type: 'message.complete', session_id: 's1', payload: {} }))
    gateway.events.get('notification.show')?.({ type: 'notification.show', payload: { text: 'Credits are low', level: 'warn' } })

    expect($notifications.get().map(n => [n.title, n.category])).toEqual([
      ['Hermes', undefined],
      ['Hermes', 'toolCompletion'],
      ['Hermes has a question', 'approval'],
      ['Approval needed', 'approval']
    ])
  })
})

describe('saving the switches', () => {
  it('sends only the switch that changed, so a stale window cannot undo another window\'s switch', async () => {
    // Another window turned Task updates off; this window has not heard yet.
    bridge.prefs = { ...$prefs.get(), notify: { ...NOTIFY_DEFAULTS, taskUpdates: false } }

    await setNotifySwitch('approvals', false)

    expect(bridge.saved).toEqual([{ notify: { approvals: false } }])
    expect($prefs.get().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false, approvals: false })
  })

  it('hands every switch found in localStorage to main, takes its answer, and drops all four old keys', async () => {
    const storage = memoryStorage({
      [LEGACY_NOTIFY_KEYS.toolCompletions]: 'false',
      [LEGACY_NOTIFY_KEYS.approvals]: 'false',
      [LEGACY_NOTIFY_KEYS.taskUpdates]: 'true',
      [LEGACY_NOTIFY_KEYS.nativeWhenUnfocused]: 'false',
      'herald-os.other': 'kept'
    })

    await migrateLegacyNotifyFlags(storage)

    expect(bridge.adopted).toEqual([{ toolCompletions: false, approvals: false, taskUpdates: true, nativeWhenUnfocused: false }])
    expect(bridge.saved).toEqual([])
    expect($prefs.get().notify).toEqual({ toolCompletions: false, approvals: false, taskUpdates: true, nativeWhenUnfocused: false })
    expect([...storage.map.keys()]).toEqual(['herald-os.other'])

    await migrateLegacyNotifyFlags(storage)
    expect(bridge.adopted).toHaveLength(1)
  })

  it('keeps the localStorage switches for the next start when main cannot save them', async () => {
    const storage = memoryStorage({ [LEGACY_NOTIFY_KEYS.toolCompletions]: 'false' })
    bridge.failWrite = true

    await expect(migrateLegacyNotifyFlags(storage)).rejects.toThrow('disk full')

    expect(storage.map.get(LEGACY_NOTIFY_KEYS.toolCompletions)).toBe('false')
    expect($prefs.get().notify).toEqual(NOTIFY_DEFAULTS)
  })
})

describe('a toast raised again', () => {
  const shown = () => $toasts.get().map(t => t.title)

  it('stays its full six seconds from the second raise, not from the first', () => {
    notify({ title: 'Too fast', key: 'terminal.clipboard' })
    vi.advanceTimersByTime(5000)
    notify({ title: 'Too fast', key: 'terminal.clipboard' })

    vi.advanceTimersByTime(1500)
    expect(shown()).toEqual(['Too fast'])
    vi.advanceTimersByTime(4400)
    expect(shown()).toEqual(['Too fast'])
    vi.advanceTimersByTime(100)
    expect(shown()).toEqual([])
  })

  it('is not cut short by the removal of one dismissed before', () => {
    const first = notify({ title: 'Too fast', key: 'terminal.clipboard' })
    vi.advanceTimersByTime(1000)
    dismissToast(first.id)
    vi.advanceTimersByTime(2000)
    notify({ title: 'Too fast', key: 'terminal.clipboard' })

    vi.advanceTimersByTime(3500)
    expect(shown()).toEqual(['Too fast'])
    vi.advanceTimersByTime(2500)
    expect(shown()).toEqual([])
  })

  it('leaves other toasts to their own six seconds', () => {
    notify({ title: 'First' })
    vi.advanceTimersByTime(3000)
    notify({ title: 'Second' })
    vi.advanceTimersByTime(3000)

    expect(shown()).toEqual(['Second'])
    vi.advanceTimersByTime(3000)
    expect(shown()).toEqual([])
  })
})
