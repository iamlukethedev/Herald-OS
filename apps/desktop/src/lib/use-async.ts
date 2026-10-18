import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { $connectionEpoch } from '../store/gateway.ts'
import { errorText } from './error-text.ts'

export interface AsyncState<T> {
  data: T | null
  /** What went wrong, never blank, so `error &&` holds whenever the loader failed. */
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Load backend-owned data; refetch on every (re)connect. Stale responses never overwrite newer
 * ones (generation guard), and `deps` re-run the loader.
 */
export function useBackendData<T>(loader: () => Promise<T>, deps: readonly unknown[] = [], options: { enabled?: boolean } = {}): AsyncState<T> {
  const epoch = useStore($connectionEpoch)
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const enabled = options.enabled ?? true

  useEffect(() => {
    if (!enabled || epoch === 0) {
      return
    }

    const mine = ++generation.current
    setLoading(true)
    loader()
      .then(value => {
        if (mine === generation.current) {
          setData(value)
          setError(null)
        }
      })
      .catch(err => {
        if (mine === generation.current) {
          setError(errorText(err))
        }
      })
      .finally(() => {
        if (mine === generation.current) {
          setLoading(false)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, tick, enabled, ...deps])

  const reload = useCallback(() => setTick(t => t + 1), [])

  return { data, error, loading, reload }
}

/** Same shape for machine-owned data that does not depend on the backend. */
export function useLocalData<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const mine = ++generation.current
    setLoading(true)
    loader()
      .then(value => {
        if (mine === generation.current) {
          setData(value)
          setError(null)
        }
      })
      .catch(err => {
        if (mine === generation.current) {
          setError(errorText(err))
        }
      })
      .finally(() => {
        if (mine === generation.current) {
          setLoading(false)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])

  const reload = useCallback(() => setTick(t => t + 1), [])

  return { data, error, loading, reload }
}
