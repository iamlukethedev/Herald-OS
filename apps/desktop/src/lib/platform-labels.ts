import { $env } from '../store/backend.ts'

/** Host platform of the shell; `darwin` until main reports (the boot value on macOS builds). */
export function hostPlatform(): NodeJS.Platform | 'darwin' {
  return ($env.get()?.platform as NodeJS.Platform | undefined) ?? 'darwin'
}

/** Name of the host file manager, for "Reveal in …" affordances. */
export function fileManagerName(): string {
  switch (hostPlatform()) {
    case 'darwin':
      return 'Finder'
    case 'win32':
      return 'Explorer'
    default:
      return 'Files'
  }
}

/** "Mac" on macOS, "computer" elsewhere, for copy such as "Everything on this Mac". */
export function deviceNoun(): string {
  return hostPlatform() === 'darwin' ? 'Mac' : 'computer'
}

export function revealLabel(): string {
  return hostPlatform() === 'darwin' ? 'Reveal in Finder' : `Show in ${fileManagerName()}`
}

/** A shell shortcut as the keyboard spells it: `⌘⇧A` on macOS, `Ctrl+Shift+A` elsewhere (the shell takes either). */
export function shortcutLabel(key: string, { shift = false } = {}): string {
  return hostPlatform() === 'darwin' ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/** What starts a voice conversation: the session's Super+V on Linux, the configured global hotkey elsewhere. */
export function voiceKeyLabel(hotkey: string): string | undefined {
  return hostPlatform() === 'linux' ? 'Super+V' : hotkey.trim() || undefined
}

/**
 * Who owns the sound devices. On Herald OS Linux the shell *is* the session, so its panel sets the
 * PipeWire default for the whole machine. Anywhere else Herald is one app among others, so a choice
 * made in its panel belongs to Herald alone and the system default is left to the system.
 */
export function audioScope(): 'system' | 'app' {
  return hostPlatform() === 'linux' ? 'system' : 'app'
}

/** True when the shell itself sets the machine's default device, rather than only its own. */
export function ownsSystemAudio(): boolean {
  return audioScope() === 'system'
}
