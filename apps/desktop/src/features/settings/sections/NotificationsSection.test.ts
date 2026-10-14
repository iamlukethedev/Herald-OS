import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeraldOSPrefs, PrefsPatch } from '../../../../shared/ipc.ts'
import { NOTIFY_DEFAULTS } from '../../../../shared/notify-prefs.ts'

// Each switch the section renders, by label; `click` does what the real Toggle's button does.
const toggles = vi.hoisted(() => new Map<string, { checked: boolean; click: () => void }>())

vi.mock('../../../components/ui/glass.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../components/ui/glass.tsx')>()

  return {
    ...actual,
    Toggle: (props: Parameters<typeof actual.Toggle>[0]) => {
      toggles.set(props.label, { checked: props.checked, click: () => props.onChange(!props.checked) })

      return actual.Toggle(props)
    }
  }
})

const bridge = vi.hoisted(() => {
  const state = { saved: [] as PrefsPatch[], prefs: null as HeraldOSPrefs | null }
  Object.assign(globalThis, {
    window: {
      heraldOS: {
        prefs: {
          set: async (patch: PrefsPatch) => {
            state.saved.push(patch)
            state.prefs = { ...state.prefs!, notify: { ...state.prefs!.notify, ...patch.notify } }

            return state.prefs
          }
        }
      }
    },
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined, removeProperty: () => undefined } } }
  })

  return state
})

const { $prefs } = await import('../../../store/backend.ts')
const { NotificationsSection } = await import('./NotificationsSection.tsx')

function render(notify: Partial<HeraldOSPrefs['notify']>) {
  $prefs.set({ ...$prefs.get(), notify: { ...NOTIFY_DEFAULTS, ...notify } })
  bridge.prefs = $prefs.get()
  toggles.clear()

  return renderToStaticMarkup(createElement(NotificationsSection))
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  bridge.saved.length = 0
})

describe('Settings > Notifications > Alerts', () => {
  it('shows each switch as it is saved in the prefs, with Finished turns for tool completions', () => {
    const html = render({ approvals: false, nativeWhenUnfocused: false })

    expect([...toggles].map(([label, toggle]) => [label, toggle.checked])).toEqual([
      ['Finished turns', true],
      ['Approvals', false],
      ['Native notifications when unfocused', false],
      ['Offer to explain crashes', true]
    ])
    expect(html).toContain('A toast when Hermes finishes a turn in a session you are not looking at.')
    expect(html).not.toContain('Tool completions')
  })

  it('has no Task updates row while nothing raises a task-result alert, and keeps a saved value for it untouched', async () => {
    const html = render({ taskUpdates: false })

    expect(html).not.toContain('Task updates')
    expect(html).not.toContain('Scheduled tasks that ran')

    toggles.get('Approvals')!.click()
    await flush()
    expect($prefs.get().notify).toEqual({ ...NOTIFY_DEFAULTS, taskUpdates: false, approvals: false })
  })

  it('saves the new value of only the switch that was clicked', async () => {
    render({})
    toggles.get('Approvals')!.click()
    await flush()
    expect(bridge.saved).toEqual([{ notify: { approvals: false } }])
    expect($prefs.get().notify).toEqual({ ...NOTIFY_DEFAULTS, approvals: false })

    render({ approvals: false, toolCompletions: false })
    toggles.get('Finished turns')!.click()
    toggles.get('Native notifications when unfocused')!.click()
    await flush()
    expect(bridge.saved.slice(1)).toEqual([{ notify: { toolCompletions: true } }, { notify: { nativeWhenUnfocused: false } }])
  })
})
