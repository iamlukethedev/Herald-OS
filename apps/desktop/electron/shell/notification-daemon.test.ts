import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const buses = vi.hoisted(() => ({ next: null as unknown }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../log.ts', () => ({ log: vi.fn() }))
vi.mock('dbus-next', async importOriginal => {
  const actual = await importOriginal<typeof import('dbus-next')>()

  return { ...actual, sessionBus: () => buses.next }
})

const dbus = await import('dbus-next')
const { NotificationDaemon, nodeSocketAddress } = await import('./notification-daemon.ts')

describe('nodeSocketAddress', () => {
  it('keeps dbus-next on Node sockets for path addresses', () => {
    expect(nodeSocketAddress('unix:path=/run/user/1000/bus')).toBe('unix:socket=/run/user/1000/bus')
    expect(nodeSocketAddress('unix:path=/run/user/1000/bus,guid=abc;unix:abstract=/tmp/x')).toBe('unix:socket=/run/user/1000/bus')
  })

  it('maps abstract sockets to a NUL-prefixed path', () => {
    expect(nodeSocketAddress('unix:abstract=/tmp/dbus-XYZ,guid=1')).toBe('unix:socket=\u0000/tmp/dbus-XYZ')
  })

  it('falls back to the runtime-dir bus, and leaves other transports alone', () => {
    expect(nodeSocketAddress(undefined)).toMatch(/^unix:socket=\/run\/user\/\d+\/bus$/)
    expect(nodeSocketAddress('tcp:host=127.0.0.1,port=1234')).toBe('tcp:host=127.0.0.1,port=1234')
  })
})

/** A bus as dbus-next builds it: errors on the bus, a clean close on its connection ('end') and socket ('close'). */
class FakeBus extends EventEmitter {
  export = vi.fn()
  disconnect = vi.fn()
  _connection = Object.assign(new EventEmitter(), { stream: new EventEmitter() })
  constructor(readonly reply: number | Promise<number>) {
    super()
  }
  requestName = vi.fn(async () => this.reply)
}

const shell = { mainWindow: () => null, open: vi.fn() } as never

describe('NotificationDaemon.serving', () => {
  beforeEach(() => {
    buses.next = null
  })

  it('serves once it owns the bus name', async () => {
    buses.next = new FakeBus(dbus.RequestNameReply.PRIMARY_OWNER)
    const daemon = new NotificationDaemon(shell)

    expect(daemon.serving()).toBe(false)
    await daemon.start()
    expect(daemon.serving()).toBe(true)
  })

  it('does not serve while another daemon owns the name', async () => {
    const bus = new FakeBus(dbus.RequestNameReply.EXISTS)
    buses.next = bus
    const daemon = new NotificationDaemon(shell)

    await daemon.start()

    expect(daemon.serving()).toBe(false)
    expect(bus.disconnect).toHaveBeenCalled()
  })

  it('stops serving when its bus drops, so notices go to the session bus again', async () => {
    const bus = new FakeBus(dbus.RequestNameReply.PRIMARY_OWNER)
    buses.next = bus
    const daemon = new NotificationDaemon(shell)
    await daemon.start()

    bus.emit('error', new Error('connection closed'))

    expect(daemon.serving()).toBe(false)
    expect(bus.disconnect).toHaveBeenCalled()
  })

  it.each([
    ['end', (bus: FakeBus) => bus._connection.emit('end')],
    ['close', (bus: FakeBus) => bus._connection.stream.emit('close')]
  ])("stops serving at once when the bus closes cleanly ('%s')", async (_event, closeIt) => {
    const bus = new FakeBus(dbus.RequestNameReply.PRIMARY_OWNER)
    buses.next = bus
    const daemon = new NotificationDaemon(shell)
    await daemon.start()

    closeIt(bus)

    expect(daemon.serving()).toBe(false)
    expect(bus.disconnect).toHaveBeenCalled()
  })

  it('does not serve from a bus that dropped while it was still asking for the name', async () => {
    let grant: (reply: number) => void = () => undefined
    const bus = new FakeBus(new Promise<number>(resolve => (grant = resolve)))
    buses.next = bus
    const daemon = new NotificationDaemon(shell)
    const starting = daemon.start()

    bus._connection.emit('end')
    grant(dbus.RequestNameReply.PRIMARY_OWNER)
    await starting

    expect(daemon.serving()).toBe(false)
  })

  it('serves again from a new bus after a drop, and an old bus erroring later leaves it alone', async () => {
    const first = new FakeBus(dbus.RequestNameReply.PRIMARY_OWNER)
    const second = new FakeBus(dbus.RequestNameReply.PRIMARY_OWNER)
    const daemon = new NotificationDaemon(shell)
    buses.next = first
    await daemon.start()
    first.emit('error', new Error('connection closed'))
    buses.next = second
    await daemon.start()

    first.emit('error', new Error('late'))

    expect(daemon.serving()).toBe(true)
    expect(second.disconnect).not.toHaveBeenCalled()
  })
})
