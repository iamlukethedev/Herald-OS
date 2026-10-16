import { launchRoadster } from '../features/roadster/flight.ts'
import { updatePrefs } from '../store/backend.ts'
import { ok, type OsCommand } from '../store/os-commands.ts'

/* The roadster flyover, the command bar's easter egg: a few seconds of a night scene, then gone; and the switch for the flyovers nobody asked for. */

export const roadsterCommands: readonly OsCommand[] = [
  {
    id: 'roadster.fly',
    title: 'Fly the roadster',
    description: 'A few seconds of fun: a white roadster lifts off on jets of cold vapor, flips backwards over a truck and flies off. Any key or click ends it early.',
    tier: 'read',
    args: [],
    phrases: ['fly the roadster', 'take the roadster for a flight', 'roadster flyover'],
    run: () => {
      launchRoadster()

      return ok('The roadster took off', { spoken: 'Off it goes.' })
    }
  },
  {
    id: 'roadster.flyovers.set',
    title: 'Flyover animations',
    description: 'Turn on or off the roadster flying over the Pet Room when a helper’s work completes and over the screensaver now and then. "Fly the roadster" still flies it either way.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to let the roadster fly over the Pet Room and the screensaver', required: true }],
    phrases: [
      { phrase: 'turn on flyover animations', args: { enabled: true } },
      { phrase: 'turn on flyovers', args: { enabled: true } },
      { phrase: 'turn off flyover animations', args: { enabled: false } },
      { phrase: 'turn off flyovers', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ flyovers: Boolean(enabled) })

      return ok(`Flyover animations ${enabled ? 'on' : 'off'}`, { highlight: { kind: 'setting', id: 'appearance' } })
    }
  }
]
