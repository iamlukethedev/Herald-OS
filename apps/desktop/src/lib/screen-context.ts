// What is on screen, as one line for Hermes: the folder the Files page shows and the selected file,
// and the document in a viewer window in front. Spoken requests carry it, after the line about what
// Herald Office has open, so "this folder", "this file" and "this sheet" have a referent; typed ones
// can ask `os_ui action=state`. Pure, so it is tested in node.

export interface FilesView {
  /** The folder listed, or null on the Recent and Favorites views. */
  folder: string | null
  view: 'folder' | 'recent' | 'favorites'
  selected: string | null
}

export interface ScreenFacts {
  /** The Hermes window's page. */
  page: string
  /** What the Files page lists (whether or not it is the page in view). */
  files: FilesView | null
  /** The file shown in the viewer window in front, if one is focused. */
  viewerFile: string | null
}

export function describeScreen(facts: ScreenFacts): string | null {
  const parts: string[] = []

  if (facts.viewerFile) {
    parts.push(`the viewer in front shows the file ${facts.viewerFile}`)
  }

  if (facts.page === 'files' && facts.files) {
    const { folder, view, selected } = facts.files
    const listing = view === 'folder' && folder ? `the folder ${folder}` : view === 'recent' ? 'recent files' : 'favorites'

    parts.push(`the Files page shows ${listing}${selected ? `, with ${selected} selected` : ''}`)
  }

  return parts.length > 0 ? `Screen: ${parts.join('; ')}.` : null
}

/**
 * The spoken context the backend hands the model, never mixed into the person's words: the exchange,
 * then what Herald Office has open ("Office: in front is Budget.xlsx …"), then the screen line last.
 */
export function withScreenContext(voiceContext: string | undefined, screen: string | null, office: string | null = null): string | undefined {
  const lines = [voiceContext?.trim(), office?.trim(), screen].filter((line): line is string => Boolean(line))

  return lines.length > 0 ? lines.join('\n') : undefined
}
