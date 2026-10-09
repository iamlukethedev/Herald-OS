import { atom } from 'nanostores'

const STORAGE_KEY = 'herald-docs.navigation-pane'

/** Whether the navigation pane shows beside the documents of this window; a window opened later starts as the last one changed was left. */
export const $navigationPane = atom<boolean>(globalThis.localStorage?.getItem(STORAGE_KEY) === 'on')

export function showNavigationPane(show: boolean): void {
  $navigationPane.set(show)
  globalThis.localStorage?.setItem(STORAGE_KEY, show ? 'on' : 'off')
}
