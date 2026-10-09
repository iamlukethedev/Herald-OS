import type { WebContents } from 'electron'

/*
 * What windows watch over IPC, by watch id. A watch ends when its window unwatches it or closes, and its
 * close listener goes with it either way: in desktop mode one web contents holds every app, so a listener
 * left behind for every watch would pile up over a session.
 */

interface Watch<T> {
  value: T
  owner: WebContents
  end: () => void
}

export class WindowWatches<T> {
  private readonly watches = new Map<string, Watch<T>>()

  /** Keep `value` for `owner` until it unwatches `id` or closes; `stop` runs once, when the watch ends. */
  add(id: string, owner: WebContents, value: T, stop: () => void): void {
    // A window that closed while its watch was being set up never sends 'destroyed' again.
    if (owner.isDestroyed()) {
      stop()

      return
    }

    const end = () => {
      stop()
      this.watches.delete(id)
      owner.off('destroyed', end)
    }

    this.watches.set(id, { value, owner, end })
    owner.once('destroyed', end)
  }

  /** End watch `id` if `owner` started it; another window's watch is left alone. */
  remove(id: string, owner: WebContents): void {
    const watch = this.watches.get(id)

    if (watch?.owner === owner) {
      watch.end()
    }
  }

  /** The value of a watch `owner` keeps that `matches`, if any. */
  find(owner: WebContents, matches: (value: T) => boolean): T | undefined {
    return [...this.watches.values()].find((watch) => watch.owner === owner && matches(watch.value))?.value
  }

  get size(): number {
    return this.watches.size
  }
}

/** Run `onClose` if `owner` closes before the work ends; the returned release takes the listener off when it does. */
export function whileOpen(owner: WebContents, onClose: () => void): () => void {
  if (owner.isDestroyed()) {
    onClose()

    return () => {}
  }

  owner.once('destroyed', onClose)

  return () => {
    owner.off('destroyed', onClose)
  }
}
