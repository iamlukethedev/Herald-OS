import { ok, type OsCommand } from '../store/os-commands.ts'

/* Herald Office as a whole: what is open across Herald Docs, Sheets and Slides, and what is in front. */

const office = () => import('../features/office/agent.ts')

export const officeCommands: readonly OsCommand[] = [
  {
    id: 'office.list',
    title: 'What is open in Herald Office',
    description: 'Every document open in Herald Docs, Sheets and Slides: app, name, path, unsaved edits, which one is in front, and what is selected in each (text in a document, a range in a workbook, a slide). Use it to work across documents in one request.',
    tier: 'read',
    args: [],
    run: async () => {
      const { openEntries, officeContextLine } = await office()
      const entries = await openEntries()

      return ok((await officeContextLine()) ?? 'Nothing is open in Herald Office', { data: { documents: entries.map(({ key: _key, ...entry }) => entry) } })
    }
  }
]
