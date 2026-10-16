import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { hostPlatform } from '../platform/index.ts'
import { assertReadable } from './fs.ts'

const iconCache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

/** Icon extraction shells out (sips / qlmanage); keep a small bounded pool so an Apps grid mount does not fork 100 processes. */
const queue: Array<() => void> = []
let active = 0
const CONCURRENCY = 4

const runNext = () => {
  while (active < CONCURRENCY && queue.length > 0) {
    active++
    queue.shift()!()
  }
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task()
        .then(resolve, reject)
        .finally(() => {
          active--
          runNext()
        })
    })
    runNext()
  })
}

function iconFor(appPath: string): Promise<string> {
  const cached = iconCache.get(appPath)

  if (cached) {
    return Promise.resolve(cached)
  }

  const pending = inflight.get(appPath)

  if (pending) {
    return pending
  }

  const promise = enqueue(async () => {
    const png = await hostPlatform().appIcon(appPath)

    if (!png) {
      throw new Error('no icon')
    }

    const url = `data:image/png;base64,${png.toString('base64')}`
    iconCache.set(appPath, url)

    return url
  }).finally(() => inflight.delete(appPath))
  inflight.set(appPath, promise)

  return promise
}

export function registerAppsIpc(): void {
  ipcMain.handle(IPC.appsList, () => hostPlatform().listInstalledApps())
  ipcMain.handle(IPC.appsLaunch, async (_event, appPath: string) => hostPlatform().launchApp((await assertReadable(appPath)).real))
  ipcMain.handle(IPC.appsIcon, async (_event, appPath: string) => iconFor((await assertReadable(appPath)).real))
}
