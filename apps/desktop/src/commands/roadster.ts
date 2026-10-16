import { launchRoadster } from '../features/roadster/flight.ts'
import { ok, type OsCommand } from '../store/os-commands.ts'

/* The roadster flyover, the command bar's easter egg: a few seconds of a night scene, then gone. */

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
  }
]
