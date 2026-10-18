import { BrowserWindow, ipcMain } from 'electron'
import * as dbus from 'dbus-next'
import { type IncomingNotification, IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { PanelShell } from './panels.ts'

/**
 * The session bus address for dbus-next through Node's own sockets. For `unix:path=` addresses
 * dbus-next prefers the optional `usocket` module when it is installed, and usocket calls
 * `util.isError`, which current Node no longer has: the first write throws in the main process.
 * `unix:socket=` (dbus-next's own form) always uses `net`.
 */
export function nodeSocketAddress(address: string | undefined): string | undefined {
  const raw = address?.split(';')[0]?.trim()
  const uid = process.getuid?.() ?? 1000
  const path = raw ? /^unix:path=([^,]+)/.exec(raw)?.[1] : `/run/user/${uid}/bus`
  const abstract = raw ? /^unix:abstract=([^,]+)/.exec(raw)?.[1] : undefined

  if (path) {
    return `unix:socket=${path}`
  }

  // Linux abstract sockets: a leading NUL byte in the path, which net understands too.
  return abstract ? `unix:socket=\u0000${abstract}` : raw
}

/**
 * Call `listener` once `bus` is gone. dbus-next passes a connection's errors on to the bus, but not a
 * clean close: the connection emits 'end' when the bus daemon ends the stream, and its socket 'close'.
 */
export function onBusClosed(bus: dbus.MessageBus, listener: (reason: string) => void): void {
  const connection = (bus as unknown as { _connection?: NodeJS.EventEmitter & { stream?: NodeJS.EventEmitter } })._connection

  bus.on('error', error => listener(error instanceof Error ? error.message : String(error)))
  connection?.on('end', () => listener('the session bus closed the connection'))
  connection?.stream?.on('close', () => listener('the connection to the session bus closed'))
}

const BUS_NAME = 'org.freedesktop.Notifications'
const OBJECT_PATH = '/org/freedesktop/Notifications'
const CONNECT_TIMEOUT_MS = 5000

/** Reasons for the `NotificationClosed` signal (Desktop Notifications spec 1.2). */
const CLOSED_EXPIRED = 1
const CLOSED_DISMISSED = 2
const CLOSED_BY_CALL = 3

type Hints = Record<string, dbus.Variant | undefined>

/** What the D-Bus interface forwards to the daemon; keeps the interface class free of shell logic. */
interface NotificationHandler {
  notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Hints,
    expireTimeout: number
  ): number
  close(id: number): void
}

/**
 * The exported `org.freedesktop.Notifications` interface. Member functions with the signal names
 * return the signal arguments; `configureMembers` wraps them so calling them emits on the bus.
 */
class NotificationsInterface extends dbus.interface.Interface {
  constructor(private readonly handler: NotificationHandler) {
    super(BUS_NAME)
  }

  GetCapabilities(): string[] {
    return ['body', 'actions', 'body-markup', 'persistence']
  }

  GetServerInformation(): [string, string, string, string] {
    return ['Herald OS', 'Herald OS', '0.1', '1.2']
  }

  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Hints,
    expireTimeout: number
  ): number {
    return this.handler.notify(appName, replacesId, appIcon, summary, body, actions, hints, expireTimeout)
  }

  CloseNotification(id: number): void {
    this.handler.close(id)
  }

  NotificationClosed(id: number, reason: number): [number, number] {
    return [id, reason]
  }

  ActionInvoked(id: number, actionKey: string): [number, string] {
    return [id, actionKey]
  }
}

NotificationsInterface.configureMembers({
  methods: {
    GetCapabilities: { outSignature: 'as' },
    GetServerInformation: { outSignature: 'ssss' },
    Notify: { inSignature: 'susssasa{sv}i', outSignature: 'u' },
    CloseNotification: { inSignature: 'u' }
  },
  signals: {
    NotificationClosed: { signature: 'uu' },
    ActionInvoked: { signature: 'us' }
  }
})

function urgencyOf(hints: Hints): IncomingNotification['urgency'] {
  const raw = hints.urgency?.value

  if (raw === 0) {
    return 'low'
  }

  if (raw === 2) {
    return 'critical'
  }

  return 'normal'
}

function iconOf(appIcon: string, hints: Hints): string | undefined {
  if (appIcon) {
    return appIcon
  }

  const imagePath = hints['image-path']?.value ?? hints.image_path?.value

  return typeof imagePath === 'string' && imagePath ? imagePath : undefined
}

/** The flat `actions` array alternates key, label, key, label, ... */
function pairActions(actions: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []

  for (let i = 0; i + 1 < actions.length; i += 2) {
    pairs.push([String(actions[i]), String(actions[i + 1])])
  }

  return pairs
}

/**
 * A freedesktop notification server living in the Electron main process, so notifications from
 * other Linux applications (browsers, GTK apps, `notify-send`) land in the Herald OS shell instead
 * of a separate daemon. Only one server may own the bus name; when another daemon already does, this
 * one logs and stays idle.
 */
export class NotificationDaemon {
  private bus: dbus.MessageBus | null = null
  private iface: NotificationsInterface | null = null
  private nextId = 1
  private readonly expiry = new Map<number, NodeJS.Timeout>()
  private readonly active = new Set<number>()
  private handlingActions = false

  constructor(private readonly shell: PanelShell) {}

  /** Never throws: a missing session bus or a foreign daemon only disables the service. */
  async start(): Promise<void> {
    if (this.bus) {
      return
    }

    let bus: dbus.MessageBus

    try {
      bus = dbus.sessionBus({ busAddress: nodeSocketAddress(process.env.DBUS_SESSION_BUS_ADDRESS) })
    } catch (error) {
      log('notifications', `session bus unavailable: ${(error as Error).message}`)

      return
    }

    this.bus = bus
    // A connection failure surfaces here rather than through the pending name request.
    const firstError = new Promise<never>((_resolve, reject) => bus.once('error', reject))
    // A dropped or closed connection no longer owns the name: stop claiming to serve it.
    onBusClosed(bus, reason => {
      if (this.bus === bus) {
        log('notifications', `bus gone: ${reason}`)
      }

      this.dropBus(bus)
    })

    const iface = new NotificationsInterface({
      notify: (...args) => this.notify(...args),
      close: id => this.closeNotification(id, CLOSED_BY_CALL)
    })

    try {
      bus.export(OBJECT_PATH, iface)
      const reply = await Promise.race([
        bus.requestName(BUS_NAME, 0),
        firstError,
        new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error('timed out connecting to the session bus')), CONNECT_TIMEOUT_MS))
      ])

      if (reply !== dbus.RequestNameReply.PRIMARY_OWNER && reply !== dbus.RequestNameReply.ALREADY_OWNER) {
        log('notifications', `${BUS_NAME} is owned by another notification daemon (reply ${reply}); not serving`)
        this.dropBus(bus)

        return
      }
    } catch (error) {
      log('notifications', `could not claim ${BUS_NAME}: ${(error as Error).message}`)
      this.dropBus(bus)

      return
    }

    if (this.bus !== bus) {
      return
    }

    this.iface = iface
    this.registerActionHandler()
    log('notifications', `serving ${BUS_NAME} at ${OBJECT_PATH}`)
  }

  /** Whether this process owns the bus name, so a notification sent to the session bus would come back here. */
  serving(): boolean {
    return this.iface !== null
  }

  stop(): void {
    if (this.handlingActions) {
      ipcMain.removeHandler(IPC.notificationsAction)
      this.handlingActions = false
    }

    for (const timer of this.expiry.values()) {
      clearTimeout(timer)
    }

    this.expiry.clear()
    this.active.clear()
    this.teardown()
  }

  /** Tear down `bus` only while it is still this daemon's, never one a later start opened. */
  private dropBus(bus: dbus.MessageBus): void {
    if (this.bus === bus) {
      this.teardown()
    }
  }

  private teardown(): void {
    const bus = this.bus
    this.bus = null
    this.iface = null

    if (!bus) {
      return
    }

    try {
      bus.disconnect()
    } catch {
      // The connection may never have opened.
    }
  }

  private registerActionHandler(): void {
    if (this.handlingActions) {
      return
    }

    this.handlingActions = true
    ipcMain.handle(IPC.notificationsAction, (_event, id: number, actionKey: string) => {
      const key = String(actionKey)

      if (key === 'dismissed') {
        this.closeNotification(Number(id), CLOSED_DISMISSED)

        return
      }

      this.invokeAction(Number(id), key)
      this.closeNotification(Number(id), CLOSED_BY_CALL)
    })
  }

  private allocateId(replacesId: number): number {
    if (replacesId > 0) {
      return replacesId
    }

    const id = this.nextId
    // Ids are uint32 and must never be 0.
    this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1

    return id
  }

  private notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Hints,
    expireTimeout: number
  ): number {
    const id = this.allocateId(Number(replacesId) || 0)
    const notification: IncomingNotification = {
      id,
      appName: String(appName ?? ''),
      summary: String(summary ?? ''),
      body: String(body ?? ''),
      icon: iconOf(String(appIcon ?? ''), hints ?? {}),
      actions: pairActions(Array.isArray(actions) ? actions : []),
      urgency: urgencyOf(hints ?? {}),
      expireTimeout: Number.isFinite(Number(expireTimeout)) ? Number(expireTimeout) : -1
    }

    this.active.add(id)
    this.scheduleExpiry(id, notification.expireTimeout)

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.notificationsIncoming, notification)
      }
    }

    // The renderer turns the structured event into a toast (with app name and actions); make sure
    // the Hermes window exists so nothing is lost while it is closed.
    if (!this.shell.mainWindow()) {
      this.shell.open('main')
    }

    log('notifications', `#${id} from ${notification.appName || '?'}: ${notification.summary.slice(0, 80)}`)

    return id
  }

  private scheduleExpiry(id: number, expireTimeout: number): void {
    const previous = this.expiry.get(id)

    if (previous) {
      clearTimeout(previous)
      this.expiry.delete(id)
    }

    // 0 means never expire; -1 leaves the choice to the shell, which the renderer handles.
    if (expireTimeout > 0) {
      this.expiry.set(id, setTimeout(() => this.closeNotification(id, CLOSED_EXPIRED), expireTimeout))
    }
  }

  private invokeAction(id: number, actionKey: string): void {
    if (!this.iface || !this.active.has(id)) {
      return
    }

    try {
      this.iface.ActionInvoked(id, actionKey)
    } catch (error) {
      log('notifications', `ActionInvoked failed: ${(error as Error).message}`)
    }
  }

  private closeNotification(id: number, reason: number): void {
    const timer = this.expiry.get(id)

    if (timer) {
      clearTimeout(timer)
      this.expiry.delete(id)
    }

    if (!this.active.delete(id) || !this.iface) {
      return
    }

    try {
      this.iface.NotificationClosed(id, reason)
    } catch (error) {
      log('notifications', `NotificationClosed failed: ${(error as Error).message}`)
    }
  }
}
