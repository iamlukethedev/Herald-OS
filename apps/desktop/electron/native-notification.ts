import * as dbus from 'dbus-next'
import { Notification } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ShellMode } from '../shared/ipc.ts'
import { log } from './log.ts'
import { nodeSocketAddress, onBusClosed } from './shell/notification-daemon.ts'

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
  /** Linux: the .desktop id the notices name (`desktopEntryFor`), for the server's icon and grouping. */
  desktopEntry?: string | null
  /** Linux: hand the notice to the session's notification server. */
  sendDesktop?: (notice: NativeNotice, entry: string | null) => Promise<void>
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
export function nativeNotifier({ platform = process.platform, shellServes, desktopEntry = null, sendDesktop = (notice, entry) => desktopNotifyClient().notify(notice, entry), showElectron = showElectronNotification }: NativeNotifierOptions): (title: string, body: string) => Promise<void> {
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
      await sendDesktop(notice, desktopEntry)
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

/** Where .desktop files are looked up, most personal first (XDG Base Directory spec). */
export function applicationDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS?.trim() || '/usr/local/share:/usr/share').split(':').filter(Boolean)

  return [dataHome, ...dataDirs].map(dir => path.join(dir, 'applications'))
}

/**
 * The .desktop id of the running Herald: the session's `herald-os` in panels mode; in app mode
 * (`herald-os-app` inside Hyprland or Omarchy) `herald-os-app`, which `herald-os omarchy install`
 * writes, or else the `herald-os` entry the tarball and the packages install for the same launcher.
 * The first id with an installed entry wins, as the server needs one for the icon; with none, the
 * mode's own id. Read once at startup, from a few local paths.
 */
export function desktopEntryFor(mode: ShellMode, dirs: readonly string[] = applicationDirs(), exists: (file: string) => boolean = fs.existsSync): string {
  const ids = mode === 'panels' ? ['herald-os'] : ['herald-os-app', 'herald-os']

  return ids.find(id => dirs.some(dir => exists(path.join(dir, `${id}.desktop`)))) ?? ids[0]
}

/**
 * The `Notify` call of the Desktop Notifications spec for one notice, without sound. The
 * `desktop-entry` and `sender-pid` hints are the ones Electron's libnotify path sent, which GNOME
 * and KDE use for the icon and grouping; a server that is not running is not started for it.
 */
export function notifyMessage({ title, body }: NativeNotice, { entry = null, pid = process.pid }: { entry?: string | null; pid?: number } = {}): dbus.Message {
  const hints: Record<string, dbus.Variant> = { 'suppress-sound': new dbus.Variant('b', true), 'sender-pid': new dbus.Variant('x', pid) }

  if (entry) {
    hints['desktop-entry'] = new dbus.Variant('s', entry)
  }

  return new dbus.Message({
    destination: BUS_NAME,
    path: OBJECT_PATH,
    interface: BUS_NAME,
    member: 'Notify',
    signature: 'susssasa{sv}i',
    flags: dbus.MessageFlag.NO_AUTO_START,
    body: [APP_NAME, 0, '', title, body, [], hints, -1]
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
  async notify(notice: NativeNotice, entry: string | null = null): Promise<void> {
    const bus = this.open()
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      await Promise.race([bus.call(notifyMessage(notice, { entry })), new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${this.timeoutMs} ms`)), this.timeoutMs)))])
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
      // An 'error' event nobody listens to would throw in the main process; a clean close ends it too.
      onBusClosed(bus, reason => {
        if (this.bus === bus) {
          log('notify', `session bus gone: ${reason}`)
        }

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
