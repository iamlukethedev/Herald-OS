/*
 * How the renderer reports a fault: one `console.error` line tagged `[herald-os]`, carrying the
 * error's message and stack. DevTools shows it, and Electron main copies each shell window's
 * warnings and errors into ~/.hermes/logs/herald-os.log (electron/renderer-console.ts), so the line
 * is still there once DevTools is gone. A call nothing waits on names itself with `logFailure`;
 * `catchUncaught` reports the errors and rejections that nothing caught.
 */

const TAG = '[herald-os]'
const NET_FLAG = '__heraldOSUncaught'

const isError = (value: unknown): value is Error => value instanceof Error || Object.prototype.toString.call(value) === '[object Error]'

/** An error as text for the log: `Name: message` and its stack's frames; any other value as it prints. Never throws. */
export function describeError(error: unknown): string {
  try {
    if (isError(error)) {
      const head = [error.name, error.message].filter(Boolean).join(': ') || 'Error'
      // The stack's first line holds the message as it was when the error was made.
      const frames = typeof error.stack === 'string' ? error.stack.split('\n').filter(line => /^\s+at /.test(line)) : []

      return [head, ...frames].join('\n')
    }

    if (typeof error === 'object' && error !== null) {
      return JSON.stringify(error) ?? String(error)
    }

    return String(error)
  } catch {
    return 'an error that could not be read'
  }
}

/** A rejection handler for a call nothing waits on, naming the call in the report: `.catch(logFailure('system.info'))`. */
export function logFailure(call: string): (error: unknown) => void {
  return error => console.error(`${TAG} ${call} failed: ${describeError(error)}`)
}

/** An uncaught error event as text: the error and its stack, or for a thrown value without one, what it says and where. */
function uncaughtText({ error, message, filename, lineno, colno }: ErrorEvent): string {
  const text = error === undefined || error === null ? message.replace(/^Uncaught /, '') : describeError(error)

  return text.includes('\n') || !filename ? text : `${text} (${filename}:${lineno}:${colno})`
}

/** Chromium's note that ResizeObserver held notifications over to the next frame: no fault, and it can come every frame. */
const isResizeObserverNote = ({ error, message }: ErrorEvent): boolean => (error === undefined || error === null) && typeof message === 'string' && message.startsWith('ResizeObserver loop')

/** Report an event in place of Chromium's own console line, or with no text silence it; when that fails, Chromium's line stands. */
function reportInstead(event: Event, describe: () => string | null): void {
  try {
    const text = describe()

    if (text !== null) {
      console.error(`${TAG} ${text}`)
    }

    event.preventDefault()
  } catch {
    // Left uncancelled, the event gets Chromium's own report.
  }
}

/**
 * Report this window's uncaught errors and unhandled rejections, with their stacks. Installed once
 * per window: the mark is kept on the window, which outlives a module evaluated again by dev HMR.
 */
export function catchUncaught(target: Window): void {
  const marks = target as unknown as Record<string, unknown>

  if (marks[NET_FLAG]) {
    return
  }

  marks[NET_FLAG] = true
  target.addEventListener('error', event => reportInstead(event, () => (isResizeObserverNote(event) ? null : `uncaught exception: ${uncaughtText(event)}`)))
  target.addEventListener('unhandledrejection', event => reportInstead(event, () => `unhandled rejection: ${describeError(event.reason)}`))
}

// Imported first by main.tsx, so that a module throwing while the app loads is reported too.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  catchUncaught(window)
}
