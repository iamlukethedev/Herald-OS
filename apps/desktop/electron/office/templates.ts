import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { OfficeTemplate, OfficeTemplateInfo } from '../../shared/ipc.ts'
import { OFFICE_APPS, type OfficeApp } from '../../shared/office/files.ts'

/*
 * Templates the person saves from an Office app, in the Herald OS data folder: one JSON file each
 * in `office-templates/<app>/`, with the template's name, when it was saved and the document. A
 * template's id is a UUID that names its file, so nothing here reads or writes outside that folder.
 */

/** The largest template Herald saves, pictures and all. */
export const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024

const MAX_NAME = 120

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A template's name as typed, on one line and not too long; an empty one is refused. */
export function templateName(value: unknown): string {
  const name = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim()

  if (!name) {
    throw new Error('A template needs a name')
  }

  return name
}

interface TemplateFile {
  name: string
  savedAt: string
  model: unknown
}

export class OfficeTemplates {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private folder(app: unknown): string {
    if (!OFFICE_APPS.includes(app as OfficeApp)) {
      throw new Error(`${String(app)} is not a Herald Office app`)
    }

    return path.join(this.root, app as OfficeApp)
  }

  private file(app: unknown, id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) {
      throw new Error('There is no such template')
    }

    return path.join(this.folder(app), `${id}.json`)
  }

  /** The template in `file`, or null when it is not one (broken, or written by something else). */
  private async read(file: string, id: string): Promise<OfficeTemplate | null> {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<TemplateFile>

      if (typeof data.name !== 'string' || !data.name.trim() || !data.model || typeof data.model !== 'object') {
        return null
      }

      return { id, name: data.name, savedAt: typeof data.savedAt === 'string' ? data.savedAt : '', model: data.model }
    } catch {
      return null
    }
  }

  /** Written beside the file and renamed over it, so a template is never half written. */
  private async write(file: string, data: TemplateFile): Promise<void> {
    const text = JSON.stringify(data)

    if (Buffer.byteLength(text) > MAX_TEMPLATE_BYTES) {
      throw new Error(`A template can be at most ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB`)
    }

    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`

    try {
      await fs.writeFile(temporary, text, { mode: 0o600 })
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true })
      throw error
    }
  }

  /** The app's templates by name, with their documents; files that are not templates are passed over. */
  async list(app: OfficeApp): Promise<OfficeTemplate[]> {
    const folder = this.folder(app)
    const out: OfficeTemplate[] = []

    for (const entry of await fs.readdir(folder).catch(() => [] as string[])) {
      const id = entry.endsWith('.json') ? entry.slice(0, -5) : ''
      const template = ID.test(id) ? await this.read(path.join(folder, entry), id) : null

      if (template) {
        out.push(template)
      }
    }

    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.savedAt.localeCompare(b.savedAt))
  }

  /** Save `model` as a template called `name`: a new one, or over the template `id`. */
  async save(app: OfficeApp, name: unknown, model: unknown, id?: unknown): Promise<OfficeTemplateInfo> {
    const file = this.file(app, id ?? crypto.randomUUID())

    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw new Error('A template is a document')
    }

    const data = { name: templateName(name), savedAt: this.now().toISOString(), model }
    await this.write(file, data)

    return { id: path.basename(file, '.json'), name: data.name, savedAt: data.savedAt }
  }

  async rename(app: OfficeApp, id: unknown, name: unknown): Promise<OfficeTemplateInfo> {
    const file = this.file(app, id)
    const template = await this.read(file, String(id))

    if (!template) {
      throw new Error('There is no such template')
    }

    const data = { name: templateName(name), savedAt: template.savedAt, model: template.model }
    await this.write(file, data)

    return { id: template.id, name: data.name, savedAt: data.savedAt }
  }

  async remove(app: OfficeApp, id: unknown): Promise<void> {
    await fs.rm(this.file(app, id), { force: true })
  }
}
