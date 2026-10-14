/** The Privacy & Security pane of macOS System Settings, as `open` and `shell.openExternal` take it. */
export const PRIVACY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'

/** The permissions Herald OS asks for, by the anchor of their list inside Privacy & Security. */
export const PRIVACY_PANES = {
  microphone: 'Privacy_Microphone',
  camera: 'Privacy_Camera',
  calendars: 'Privacy_Calendars',
  screen: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  automation: 'Privacy_Automation'
} as const

export type PrivacyPane = keyof typeof PRIVACY_PANES

export const PRIVACY_PANE_NAMES = Object.keys(PRIVACY_PANES) as PrivacyPane[]

export function isPrivacyPane(name: unknown): name is PrivacyPane {
  return typeof name === 'string' && Object.hasOwn(PRIVACY_PANES, name)
}

export function privacyPaneUrl(pane: PrivacyPane): string {
  return `${PRIVACY_SETTINGS_URL}?${PRIVACY_PANES[pane]}`
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const PRIVACY_PANE_URL = new RegExp(`^${escapeRegExp(PRIVACY_SETTINGS_URL)}(\\?(${Object.values(PRIVACY_PANES).map(escapeRegExp).join('|')}))?$`)

/**
 * True for Privacy & Security itself, or one of the lists in `PRIVACY_PANES`, and nothing else: no
 * other System Settings pane or list, and no extra query or fragment that would hand System Settings
 * more to act on.
 */
export function isPrivacyPaneUrl(url: string): boolean {
  return PRIVACY_PANE_URL.test(url)
}
