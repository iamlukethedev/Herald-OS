import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'
import type { NetworkStatus, SystemInfo, SystemStats } from '../../shared/ipc.ts'
import { logFailure } from '../lib/report.ts'

export const $systemStats = atom<SystemStats | null>(null)
export const $systemInfo = atom<SystemInfo | null>(null)
/** The last attempt to read `$systemInfo` failed; the System window says so and offers to try again. */
export const $systemInfoFailed = atom(false)

let subscribers = 0
let unsubscribe: (() => void) | null = null

/** Reference-counted live stats: the sampler in main runs only while a mounted component wants it. */
export function useSystemStats(): SystemStats | null {
  useEffect(() => {
    subscribers++

    if (subscribers === 1) {
      unsubscribe = window.heraldOS.system.subscribeStats(stats => $systemStats.set(stats))
    }

    return () => {
      subscribers--

      if (subscribers === 0 && unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    }
  }, [])

  return useStore($systemStats)
}

export const $network = atom<NetworkStatus | null>(null)
let networkTimer: ReturnType<typeof setInterval> | null = null
let networkUsers = 0

/** Network status polled every 30s while something displays it. */
export function useNetworkStatus(): NetworkStatus | null {
  useEffect(() => {
    networkUsers++
    const load = () => void window.heraldOS.system.network().then(value => $network.set(value)).catch(() => undefined)

    if (networkUsers === 1) {
      load()
      networkTimer = setInterval(load, 30_000)
    }

    return () => {
      networkUsers--

      if (networkUsers === 0 && networkTimer) {
        clearInterval(networkTimer)
        networkTimer = null
      }
    }
  }, [])

  return useStore($network)
}

let infoRequest: Promise<void> | null = null

/** Read the machine's name, system and processor, one request at a time. */
export function loadSystemInfo(): Promise<void> {
  infoRequest ??= window.heraldOS.system
    .info()
    .then(value => {
      $systemInfo.set(value)
      $systemInfoFailed.set(false)
    })
    .catch((error: unknown) => {
      $systemInfoFailed.set(true)
      logFailure('system.info')(error)
    })
    .finally(() => {
      infoRequest = null
    })

  return infoRequest
}

export function useSystemInfo(): SystemInfo | null {
  const info = useStore($systemInfo)

  useEffect(() => {
    if (!$systemInfo.get()) {
      void loadSystemInfo()
    }
  }, [])

  return info
}
