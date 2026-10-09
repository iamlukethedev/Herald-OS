import type { WmState, WmWindow } from '../../shared/ipc.ts'

/**
 * The windows that last had the keys, newest first, leaving out the menu bar, dock and overlays.
 * When the focused window closes (a file dialog, a print dialog), niri hands the keys to the next
 * floating window, which is the menu bar or the dock, where typing goes nowhere. niri may report
 * the close before or after the focus change.
 */
export class FocusHistory {
  private order: number[] = []
  /** The window that had the keys last, before any panel took them. */
  private held: number | null = null

  constructor(
    private readonly isPanel: (win: WmWindow) => boolean,
    private readonly size = 8
  ) {}

  /** Take in a compositor state; returns the window to give the keys back to, or null. */
  follow(state: WmState): number | null {
    const present = new Set(state.windows.map(w => w.id))
    this.order = this.order.filter(id => present.has(id))
    const focused = state.windows.find(w => w.id === state.focusedWindowId)

    if (!focused) {
      return null
    }

    if (!this.isPanel(focused)) {
      this.held = focused.id
      this.order = [focused.id, ...this.order.filter(id => id !== focused.id)].slice(0, this.size)

      return null
    }

    if (this.held === null || present.has(this.held)) {
      return null
    }

    this.held = null

    return this.back(state)
  }

  /** The newest window in the history that is still on the active workspace. */
  back(state: WmState): number | null {
    const active = state.workspaces.find(ws => ws.focused)?.id

    for (const id of this.order) {
      const win = state.windows.find(w => w.id === id)

      if (win && win.workspaceId === active) {
        return win.id
      }
    }

    return null
  }
}
