import type { TypingPermission } from '../../shared/ipc.ts'

const PERMISSION: Record<TypingPermission, string> = {
  accessibility: 'Accessibility permission (System Settings > Privacy & Security > Accessibility)',
  automation: 'Automation permission for System Events (System Settings > Privacy & Security > Automation)'
}

const preview = (text: string) => `${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`

/** The notice for dictation or an emoji that ended up on the clipboard, naming the macOS permission that was missing. */
export function copiedNotice(what: 'dictation' | 'emoji', text: string, missing?: TypingPermission): { title: string; body: string } {
  const why = missing ? `Herald OS can't type into other apps without the ${PERMISSION[missing]}. ` : ''

  if (what === 'emoji') {
    return { title: `Copied ${text}`, body: `${why || 'It could not be typed into the app, so it is on the clipboard. '}Paste it where you want it.` }
  }

  return { title: 'Dictation copied', body: `${why}Paste it where you want it: ${preview(text)}` }
}
