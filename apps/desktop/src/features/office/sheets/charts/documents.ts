/* The document each workbook on screen belongs to, so that a chart drawn inside Univer can open its document's panel. */

const documents = new Map<string, string>()

/** Workbook `unitId` is on screen as document `docKey`; gives what forgets it. */
export function bindDocument(unitId: string, docKey: string): () => void {
  documents.set(unitId, docKey)

  return () => {
    if (documents.get(unitId) === docKey) {
      documents.delete(unitId)
    }
  }
}

export const documentOf = (unitId: string | undefined): string | null => (unitId ? (documents.get(unitId) ?? null) : null)
