import type { OfficeTemplateInfo } from '../../../../../shared/ipc.ts'
import { type DocJSON, hexColor, STYLE_NAMES, type StyleLook, type StyleLooks, type StyleName } from '../../../../../shared/office/document.ts'
import { docsSchema } from '../schema.ts'

/*
 * The templates the person saves from Herald Docs (File > Save as Template…), kept by main in
 * Herald's data folder: one file each, with its name, when it was saved and the document. A file
 * read back is checked against the schema, and its styles are made safe to become CSS.
 */

export interface SavedTemplate {
  id: string
  name: string
  savedAt: string
  doc: DocJSON
}

/** What a template keeps of a document: everything but what Herald holds of the Word file it came from. */
export const templateModel = (doc: DocJSON): DocJSON => ({ ...doc, attrs: { ...doc.attrs, kept: null } })

/** A style's look with a font name of letters only, a colour in hex, and numbers that are numbers. */
function safeLook(value: unknown): StyleLook {
  const look = (value ?? {}) as Record<string, unknown>
  const out: StyleLook = {}
  const font = typeof look.font === 'string' ? look.font.replace(/[^\p{L}\p{N} _-]/gu, '').trim() : ''
  const color = hexColor(look.color)

  if (font) {
    out.font = font
  }

  if (look.color !== undefined && color) {
    out.color = color
  }

  for (const key of ['size', 'spaceBefore', 'spaceAfter', 'lineHeight'] as const) {
    const amount = look[key]

    if (typeof amount === 'number' && Number.isFinite(amount)) {
      out[key] = amount
    }
  }

  for (const key of ['bold', 'italic'] as const) {
    if (typeof look[key] === 'boolean') {
      out[key] = look[key] as boolean
    }
  }

  return out
}

/** A saved template's document, if it is one Herald Docs can open. */
export function savedDocument(model: unknown): DocJSON | null {
  if (!model || typeof model !== 'object' || (model as DocJSON).type !== 'doc') {
    return null
  }

  try {
    const node = docsSchema().nodeFromJSON(model)
    node.check()
    const doc = node.toJSON() as DocJSON
    const styles = doc.attrs?.styles as StyleLooks | null | undefined
    const safe = styles && typeof styles === 'object' ? Object.fromEntries(Object.entries(styles).flatMap(([name, look]) => (STYLE_NAMES.includes(name as StyleName) ? [[name, safeLook(look)]] : []))) : null

    return { ...doc, attrs: { ...doc.attrs, styles: safe } }
  } catch {
    return null
  }
}

const office = () => window.heraldOS.office

/** The person's templates by name; none where main cannot list them (a window started before it could). */
export async function savedTemplates(): Promise<SavedTemplate[]> {
  if (typeof office().templates !== 'function') {
    return []
  }

  return (await office().templates('docs')).flatMap((entry) => {
    const doc = savedDocument(entry.model)

    return doc ? [{ id: entry.id, name: entry.name, savedAt: entry.savedAt, doc }] : []
  })
}

/** Save a document as a template called `name`: a new one, or over the template `id`. */
export const saveTemplate = async (name: string, doc: DocJSON, id?: string): Promise<OfficeTemplateInfo> => office().saveTemplate('docs', name, templateModel(doc), id)

export const renameTemplate = async (id: string, name: string): Promise<OfficeTemplateInfo> => office().renameTemplate('docs', id, name)

export const removeTemplate = async (id: string): Promise<void> => office().removeTemplate('docs', id)
