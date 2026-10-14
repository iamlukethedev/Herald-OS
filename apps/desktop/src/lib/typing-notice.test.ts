import { describe, expect, it } from 'vitest'
import { copiedNotice } from './typing-notice.ts'

describe('the notice for text left on the clipboard', () => {
  it('dictation: as before when no permission is to blame', () => {
    expect(copiedNotice('dictation', 'Hello there')).toEqual({ title: 'Dictation copied', body: 'Paste it where you want it: Hello there' })
  })

  it('dictation: shortens long text', () => {
    expect(copiedNotice('dictation', 'a'.repeat(100)).body).toBe(`Paste it where you want it: ${'a'.repeat(80)}…`)
  })

  it('dictation: names the missing permission and its pane', () => {
    expect(copiedNotice('dictation', 'Hello', 'accessibility').body).toBe(
      "Herald OS can't type into other apps without the Accessibility permission (System Settings > Privacy & Security > Accessibility). Paste it where you want it: Hello"
    )
    expect(copiedNotice('dictation', 'Hello', 'automation').body).toMatch(/^Herald OS can't type into other apps without the Automation permission for System Events \(System Settings > Privacy & Security > Automation\)\./)
  })

  it('emoji: says it is on the clipboard', () => {
    expect(copiedNotice('emoji', '🎉')).toEqual({ title: 'Copied 🎉', body: 'It could not be typed into the app, so it is on the clipboard. Paste it where you want it.' })
  })

  it('emoji: names the missing permission', () => {
    expect(copiedNotice('emoji', '🎉', 'automation')).toEqual({
      title: 'Copied 🎉',
      body: "Herald OS can't type into other apps without the Automation permission for System Events (System Settings > Privacy & Security > Automation). Paste it where you want it."
    })
  })
})
