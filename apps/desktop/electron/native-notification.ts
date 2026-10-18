import * as dbus from 'dbus-next'
import { Notification } from 'electron'
import { log } from './log.ts'
import { nodeSocketAddress } from './shell/notification-daemon.ts'

const BUS_NAME = 'org.freedesktop.Notifications'
const OBJECT_PATH = '/org/freedesktop/Notifications'
const APP_NAME = 'Herald OS'
/** The longest wait for a notification server; the alert is optional and the Herald bell already has it. */
export const NOTIFY_TIMEOUT_MS = 5000

export interface NativeNotice {
  title: string
  body: string
}

export interface NativeNotifierOptions {
  platform?: NodeJS.Platform
  /** Herald's own notification server owns the bus name (panels mode), so Herald already shows the alert. */
  shellServes: () => boolean
  /** Linux: hand the notice to the session's notification server. */
  sendDesktop?: (notice: NativeNotice) => Promise<void>
  /** macOS and Windows, where Electron's notifications do not wait on the main thread. */
  showElectron?: (notice: NativeNotice) => void
}

/**
 * A system notification for a renderer's `notifications.native`. On Linux Electron's Notification
 * waits on the main thread for libnotify's D-Bus calls, and every Herald window stalls until they
 * return; in panels mode the server they wait on is this same thread, so they only end by timing
 * out. Linux notices therefore go out as one asynchronous D-Bus call, or not at all when Herald's
 * own server would receive them.
 */
export function nativeNotifier({ platform = process.platform, shellServes, sendDesktop = notice => desktopNotifyClient().notify(notice), showElectron = showElectronNotification }: NativeNotifierOptions): (title: string, body: string) => Promise<void> {
  return async (title, body) => {
    const notice = { title: String(title).slice(0, 120), body: String(body).slice(0, 400) }

    if (platform !== 'linux') {
      showElectron(notice)

      return
    }

    if (shellServes()) {
      return
    }

    try {
      await sendDesktop(notice)
    } catch (error) {
      log('notify', `native notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function showElectronNotification(notice: NativeNotice): void {
  if (!Notification.isSupported()) {
    return
  }

  const notification = new Notification({ ...notice, silent: true })
  // macOS only shows notifications from code-signed apps; unsigned builds fail here.
  notification.on('failed', (_event, error) => log('notify', `native notification failed: ${error}`))
  notification.show()
}

/** The `Notify` call of the Desktop Notifications spec for one notice, without sound. */
export function notifyMessage({ title, body }: NativeNotice): dbus.Message {
  return new dbus.Message({
    destination: BUS_NAME,
    path: OBJECT_PATH,
    interface: BUS_NAME,
    member: 'Notify',
    signature: 'susssasa{sv}i',
    body: [APP_NAME, 0, '', title, body, [], { 'suppress-sound': new dbus.Variant('b', true) }, -1]
  })
}

/** One session-bus connection for Herald's own notices, opened on first use and again after a failure. */
export class DesktopNotifyClient {
  private bus: dbus.MessageBus | null = null

  constructor(
    private readonly connect: () => dbus.MessageBus = () => dbus.sessionBus({ busAddress: nodeSocketAddress(process.env.DBUS_SESSION_BUS_ADDRESS) }),
    private readonly timeoutMs = NOTIFY_TIMEOUT_MS
  ) {}

  /** Resolves once the server answered; rejects on an error or after `timeoutMs`, and the next notice reconnects. */
  async notify(notice: NativeNotice): Promise<void> {
    const bus = this.open()
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([bus.call(notifyMessage(notice)), new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${this.timeoutMs} ms`)), this.timeoutMs)))])
    } catch (error) {
      this.close(bus)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private open(): dbus.MessageBus {
    if (!this.bus) {
      const bus = this.connect()
      // An 'error' event nobody listens to would throw in the main process.
      bus.on('error', error => {
        log('notify', `session bus error: ${error instanceof Error ? error.message : String(error)}`)
        this.close(bus)
      })
      this.bus = bus
    }

    return this.bus
  }

  private close(bus: dbus.MessageBus): void {
    if (this.bus !== bus) {
      return
    }

    this.bus = null

    try {
      bus.disconnect()
    } catch {
      // The connection may never have opened.
    }
  }
}

let client: DesktopNotifyClient | null = null

function desktopNotifyClient(): DesktopNotifyClient {
  client ??= new DesktopNotifyClient()

  return client
}
