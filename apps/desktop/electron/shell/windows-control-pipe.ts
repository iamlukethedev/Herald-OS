import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const CLIENT_ACCESS = 0x12019b // File read/write WITHOUT FILE_CREATE_PIPE_INSTANCE (0x4).
const IO_PENDING = 997
const IO_INCOMPLETE = 996
const OPERATION_ABORTED = 995
const PIPE_CONNECTED = 535
const INVALID_HANDLE = 0xffffffffffffffffn
type Handle = bigint

class PipeError extends Error {
  constructor(readonly code: number) { super(`Windows control pipe failed (Windows error ${code})`) }
}

function nativeApi() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required for this control pipe')
  const root = process.env.SystemRoot
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('An absolute Windows system directory is required')
  // Load on Windows only. Koffi stays external to the Electron bundle and its native payload is unpacked.
  const ffi = require('koffi') as typeof import('koffi')
  const kernel = ffi.load(path.win32.join(root, 'System32', 'kernel32.dll'))
  const security = ffi.load(path.win32.join(root, 'System32', 'advapi32.dll'))
  const attributes = ffi.struct({ length: 'uint32_t', descriptor: 'void *', inherit: 'int32_t' })
  const overlapped = ffi.struct({ internal: 'uintptr_t', internalHigh: 'uintptr_t', offset: 'uint32_t', offsetHigh: 'uint32_t', event: 'void *' })
  const lastError = kernel.func('uint32_t __stdcall GetLastError()')
  const close = kernel.func('int __stdcall CloseHandle(void *handle)')
  const localFree = kernel.func('void * __stdcall LocalFree(void *memory)')
  const tokenOpen = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)')
  const tokenInfo = security.func('int __stdcall GetTokenInformation(void *token, int kind, void *data, uint32_t size, _Out_ uint32_t *needed)')
  const sidString = security.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)')
  const fromSddl = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)')
  const getDacl = security.func('int __stdcall GetSecurityDescriptorDacl(void *descriptor, _Out_ int *present, _Out_ void **acl, _Out_ int *defaulted)')
  const getControl = security.func('int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)')
  const getSecurity = security.func('uint32_t __stdcall GetSecurityInfo(void *handle, int kind, uint32_t requested, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)')
  const createPipe = kernel.func('CreateNamedPipeW', 'void *', ['str16', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', ffi.pointer(attributes)])
  const createEvent = kernel.func('void * __stdcall CreateEventW(void *security, int manual, int initial, void *name)')
  const connect = kernel.func('int __stdcall ConnectNamedPipe(void *pipe, void *overlapped)')
  const disconnect = kernel.func('int __stdcall DisconnectNamedPipe(void *pipe)')
  const read = kernel.func('int __stdcall ReadFile(void *handle, void *buffer, uint32_t length, void *count, void *overlapped)')
  const write = kernel.func('int __stdcall WriteFile(void *handle, void *buffer, uint32_t length, void *count, void *overlapped)')
  const result = kernel.func('int __stdcall GetOverlappedResult(void *handle, void *overlapped, _Out_ uint32_t *count, int wait)')
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)')
  const cancel = kernel.func('int __stdcall CancelIoEx(void *handle, void *overlapped)')

  const checked = (ok: unknown): void => { if (!ok) throw new PipeError(lastError()) }
  const sidText = (sid: Handle): string => {
    const text = [null]
    checked(sidString(sid, text))
    try { return ffi.decode(text[0], 'char16_t', -1) as string } finally { localFree(text[0]) }
  }
  const identity = (): { user: string; logon: string } => {
    const token = [null]
    checked(tokenOpen(INVALID_HANDLE, 8, token)) // GetCurrentProcess pseudo-handle.
    try {
      const get = (kind: number): { pointer: Handle; length: number } => {
        const needed = [0]
        tokenInfo(token[0], kind, null, 0, needed)
        if (needed[0]! <= 0 || needed[0]! > 1024 * 1024) throw new Error('Invalid process-token size')
        const pointer = ffi.alloc('uint8_t', needed[0]!) as Handle
        try { checked(tokenInfo(token[0], kind, pointer, needed[0]!, needed)) }
        catch (error) { ffi.free(pointer); throw error }
        return { pointer, length: needed[0]! }
      }
      const userInfo = get(1)
      let user: string
      try { user = sidText(ffi.decode(userInfo.pointer, 'void *')) } finally { ffi.free(userInfo.pointer) }
      const groups = get(2)
      let logon = ''
      try {
        const count = ffi.decode(groups.pointer, 'uint32_t') as number
        if (8 + count * 16 > groups.length) throw new Error('Invalid process-token groups')
        for (let index = 0; index < count; index++) {
          const offset = 8 + index * 16
          if (((ffi.decode(groups.pointer, offset + 8, 'uint32_t') as number) & 0xc0000000) >>> 0 === 0xc0000000) logon = sidText(ffi.decode(groups.pointer, offset, 'void *'))
        }
      } finally { ffi.free(groups.pointer) }
      if (!/^S-1-5-5-\d+-\d+$/.test(logon)) throw new Error('No interactive logon SID is available')
      return { user, logon }
    } finally { close(token[0]) }
  }
  const aclBytes = (descriptor: Handle): Buffer => {
    const present = [0], defaulted = [0], acl = [null]
    checked(getDacl(descriptor, present, acl, defaulted))
    if (!present[0] || !acl[0] || defaulted[0]) throw new Error('A protected explicit pipe DACL is required')
    const control = [0], revision = [0]
    checked(getControl(descriptor, control, revision))
    if (!(control[0]! & 0x1000)) throw new Error('Pipe DACL inheritance was not disabled')
    const length = ffi.decode(acl[0], 2, 'uint16_t') as number
    if (length < 8 || length > 4096) throw new Error('Invalid pipe DACL size')
    return Buffer.from(ffi.decode(acl[0], 'uint8_t', length))
  }
  const create = (endpoint: string, user: string, logon: string): Handle => {
    // OWNER RIGHTS prevents the owner's implicit WRITE_DAC right. Only this logon and SYSTEM
    // can exchange bytes; clients cannot create another server instance under this name.
    const sddl = `O:${user}D:P(A;;RC;;;OW)(A;;0x${CLIENT_ACCESS.toString(16)};;;${logon})(A;;0x1f01ff;;;SY)`
    const descriptor = [null]
    checked(fromSddl(sddl, 1, descriptor, null))
    let handle: Handle | null = null
    try {
      const expected = aclBytes(descriptor[0]!)
      handle = createPipe(endpoint, 0x40000000 | 0x00080000 | 3, 8, 1, 65536, 65536, 0,
        { length: ffi.sizeof(attributes), descriptor: descriptor[0], inherit: 0 }) as Handle
      if (!handle || handle === INVALID_HANDLE) { handle = null; throw new PipeError(lastError()) }
      const actual = [null], owner = [null]
      const code = getSecurity(handle, 6, 1 | 4, owner, null, null, null, actual)
      if (code) throw new PipeError(code)
      try {
        if (sidText(owner[0]!) !== user || !aclBytes(actual[0]!).equals(expected)) throw new Error('The created pipe security descriptor did not match the required identity and DACL')
      } finally { localFree(actual[0]) }
      return handle
    } catch (error) {
      if (handle) close(handle)
      throw error
    } finally { localFree(descriptor[0]) }
  }

  async function operation(handle: Handle, kind: 'connect' | 'read' | 'write', signal: AbortSignal, bytes?: Buffer): Promise<Buffer> {
    if (signal.aborted) throw new PipeError(OPERATION_ABORTED)
    const event = createEvent(null, 1, 0, null) as Handle
    if (!event) throw new PipeError(lastError())
    const state = ffi.alloc(overlapped, 1)
    const length = bytes?.length ?? 65536
    const buffer = kind === 'connect' ? null : ffi.alloc('uint8_t', length)
    ffi.encode(state, overlapped, { internal: 0, internalHigh: 0, offset: 0, offsetHigh: 0, event })
    if (bytes) ffi.encode(buffer, 'uint8_t', bytes, bytes.length)
    let pending = false
    let drained = false
    const abort = () => { if (pending && !drained) cancel(handle, state) }
    try {
      const ok = kind === 'connect' ? connect(handle, state) : kind === 'read' ? read(handle, buffer, length, null, state) : write(handle, buffer, length, null, state)
      const code = ok ? 0 : lastError()
      if (kind === 'connect' && code === PIPE_CONNECTED) { drained = true; return Buffer.alloc(0) }
      if (code && code !== IO_PENDING) { drained = true; throw new PipeError(code) }
      pending = true
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const count = [0]
      // Poll only a kernel event with zero wait. No blocking ReadFile/ConnectNamedPipe or libuv
      // worker is retained. Every simultaneous operation owns separate stable native memory.
      while (true) {
        const status = wait(event, 0)
        if (status === 0) break
        if (status !== 258) { abort(); throw new PipeError(lastError()) }
        await delay(4)
      }
      const completed = result(handle, state, count, 0)
      const completionError = completed ? 0 : lastError()
      drained = completionError !== IO_INCOMPLETE
      if (completionError) throw new PipeError(completionError)
      if (kind === 'write' && count[0] !== length) throw new Error('The control pipe write was incomplete')
      return kind === 'read' ? Buffer.from(ffi.decode(buffer, 'uint8_t', count[0]!)) : Buffer.alloc(0)
    } finally {
      signal.removeEventListener('abort', abort)
      // CancelIoEx is only a request. Never free or reuse OVERLAPPED/buffers until completion.
      if (pending && !drained) {
        cancel(handle, state)
        const count = [0]
        // Event failure is not completion. Query the I/O itself until it is no longer pending.
        while (!result(handle, state, count, 0)) {
          if (lastError() !== IO_INCOMPLETE) break
          await delay(4)
        }
      }
      if (buffer) ffi.free(buffer)
      ffi.free(state)
      close(event)
    }
  }
  return { identity, create, operation, disconnect, close }
}

/** The pipe this process serves, fixed before start() so main can hand it to the backend first. */
export function windowsControlPipeName(): string {
  return `\\\\.\\pipe\\herald-os-${process.pid}-${crypto.randomBytes(16).toString('hex')}`
}

let api: ReturnType<typeof nativeApi> | null = null
const native = () => api ??= nativeApi()

class PipeConnection extends Duplex {
  private readonly cancellation = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private reading = false
  constructor(private readonly handle: Handle) { super({ allowHalfOpen: false, highWaterMark: 65536 }) }
  private track<T>(work: Promise<T>): Promise<T> {
    this.operations.add(work)
    void work.then(() => this.operations.delete(work), () => this.operations.delete(work))
    return work
  }
  override _read(): void {
    if (this.reading || this.destroyed) return
    this.reading = true
    void this.track(native().operation(this.handle, 'read', this.cancellation.signal)).then(bytes => {
      this.reading = false
      if (this.destroyed) return
      if (!bytes.length) { this.push(null); return }
      if (this.push(bytes)) this._read()
    }, error => {
      this.reading = false
      if (error instanceof PipeError && [109, 232, 233, OPERATION_ABORTED].includes(error.code)) this.destroy()
      else this.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const work = (async () => {
      for (let offset = 0; offset < chunk.length; offset += 65536) await native().operation(this.handle, 'write', this.cancellation.signal, chunk.subarray(offset, offset + 65536))
    })()
    void this.track(work).then(() => callback(), error => callback(error instanceof Error ? error : new Error(String(error))))
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.cancellation.abort()
    void Promise.allSettled([...this.operations]).then(() => callback(error))
  }
}

/** One bounded connection; the secured first instance persists across clients until stop(). */
export class WindowsControlPipe {
  private handle: Handle | null = null
  private connection: PipeConnection | null = null
  private cancellation: AbortController | null = null
  private loop: Promise<void> | null = null
  private endpoint = ''
  securityVerified = false
  constructor(private readonly accept: (connection: Duplex) => void, private readonly requestedEndpoint?: string, private readonly failed?: (error: Error) => void) {}

  async start(): Promise<string> {
    if (this.handle && this.securityVerified) return this.endpoint
    if (this.loop) throw new Error('The control pipe must finish stopping before restart')
    const identity = native().identity()
    const prefix = `\\\\.\\pipe\\herald-os-${process.pid}-`
    const endpoint = this.requestedEndpoint ?? windowsControlPipeName()
    if (!endpoint.startsWith(prefix) || !/^[0-9a-f]{32}$/.test(endpoint.slice(prefix.length))) throw new Error('Invalid local Windows control pipe identity')
    this.handle = native().create(endpoint, identity.user, identity.logon)
    this.endpoint = endpoint
    this.securityVerified = true
    this.cancellation = new AbortController()
    this.loop = this.serve(this.handle, this.cancellation.signal).catch(error => {
      this.failed?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    })
    // stop() still observes and reports failures; do not leave a rejected background promise unhandled.
    void this.loop.catch(() => undefined)
    return endpoint
  }

  private async serve(handle: Handle, signal: AbortSignal): Promise<void> {
    try {
    while (!signal.aborted) {
      try {
        await native().operation(handle, 'connect', signal)
        if (signal.aborted) break
        const connection = new PipeConnection(handle)
        this.connection = connection
        const closed = new Promise<void>(resolve => connection.once('close', resolve))
        connection.on('error', () => undefined)
        this.accept(connection)
        await closed
        this.connection = null
        // A completed write is not proof the peer read it. Reuse only after the peer closes,
        // the protocol deadline destroys the stream, or stop() explicitly cancels it.
        native().disconnect(handle)
      } catch (error) {
        if (signal.aborted && error instanceof PipeError && error.code === OPERATION_ABORTED) break
        this.securityVerified = false
        this.cancellation?.abort()
        throw error
      }
    }
    } finally {
      this.securityVerified = false
      this.cancellation?.abort()
      const connection = this.connection
      if (connection && !connection.closed) {
        const closed = new Promise<void>(resolve => connection.once('close', resolve))
        connection.destroy()
        await closed
      }
      this.connection = null
      native().disconnect(handle)
      native().close(handle)
      if (this.handle === handle) this.handle = null
    }
  }

  async stop(): Promise<void> {
    this.cancellation?.abort()
    this.connection?.destroy()
    try { await this.loop } finally {
      this.loop = null
      this.cancellation = null
      this.securityVerified = false
    }
  }
}
