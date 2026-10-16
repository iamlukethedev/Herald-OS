import { useStore } from '@nanostores/react'
import { lazy, Suspense } from 'react'
import { $roadsterFlight, landRoadster } from './flight.ts'

const RoadsterFlight = lazy(() => import('./RoadsterFlight.tsx').then(m => ({ default: m.RoadsterFlight })))

/** The flight `roadster.fly` starts, over the whole window; nothing is mounted, and nothing loaded, until one does. */
export function RoadsterHost() {
  const flight = useStore($roadsterFlight)

  if (!flight) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <RoadsterFlight key={flight} onDone={() => landRoadster(flight)} />
    </Suspense>
  )
}
