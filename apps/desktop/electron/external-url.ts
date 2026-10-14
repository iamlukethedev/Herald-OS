import { isPrivacyPaneUrl } from '../shared/privacy-panes.ts'

/**
 * What the renderer may hand to `shell.openExternal`: web pages anywhere, and on macOS the Privacy &
 * Security panes of System Settings, so a permission message can open the switch it talks about.
 * Every other scheme (file:, other apps' URL handlers, other System Settings panes) stays refused.
 */
export function mayOpenExternally(url: unknown, platform: NodeJS.Platform = process.platform): url is string {
  if (typeof url !== 'string') {
    return false
  }

  if (/^https?:\/\//i.test(url)) {
    return true
  }

  return platform === 'darwin' && isPrivacyPaneUrl(url)
}
