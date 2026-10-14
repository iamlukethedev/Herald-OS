import { type PrivacyPane, privacyPaneUrl } from '../../shared/privacy-panes.ts'
import type { NotificationAction } from '../store/notifications.ts'
import { hostPlatform } from './platform-labels.ts'

export type { PrivacyPane } from '../../shared/privacy-panes.ts'

/** Only macOS has System Settings panes to open; elsewhere the permission messages stay text. */
export function canOpenPrivacyPanes(): boolean {
  return hostPlatform() === 'darwin'
}

/** Open the list in System Settings > Privacy & Security where Herald OS's switch for `pane` is. */
export function openPrivacyPane(pane: PrivacyPane): Promise<void> {
  return window.heraldOS.shell.openExternal(privacyPaneUrl(pane))
}

/** The "Open System Settings" button for a notification about `pane`, or none off macOS. */
export function privacyPaneActions(pane: PrivacyPane): NotificationAction[] | undefined {
  return canOpenPrivacyPanes() ? [{ label: 'Open System Settings', command: 'privacy.openPane', args: { pane } }] : undefined
}
