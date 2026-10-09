import { blankDocument, DEFAULT_MARGIN, defaultPage, type DocJSON, PAGE_SIZES, type PageSizeName } from '../../../../../shared/office/document.ts'
import type { TemplateContext } from './build.ts'
import { coverLetter, cv } from './career.ts'
import { invoice, newsletter, recipe } from './layouts.ts'
import { letter, memo, thankYouNote } from './letters.ts'
import { essay, meetingNotes, proposal, report } from './reports.ts'

/*
 * Herald Docs' built-in templates: each a pure function from the paper and the locale to a new
 * document with its own look, page setup, and headers and footers where they fit. The gallery
 * shows them when the person makes a document; Hermes makes documents from them by id.
 */

export interface TemplateInfo {
  id: string
  name: string
  description: string
}

export interface TemplateOptions {
  /** The paper; without one, the locale's (Letter in the US and Canada, A4 elsewhere). */
  size?: PageSizeName
  /** Whose paper and date order to use; the system's when missing. */
  locale?: string
}

interface Template extends TemplateInfo {
  build: (context: TemplateContext) => DocJSON
}

const HALF_LETTER = { width: 396, height: 612 }

const BUILT_IN: readonly Template[] = [
  {
    id: 'blank',
    name: 'Blank document',
    description: 'An empty page in Herald’s own styles.',
    build: ({ paper }) => blankDocument({ ...paper, margins: { top: DEFAULT_MARGIN, right: DEFAULT_MARGIN, bottom: DEFAULT_MARGIN, left: DEFAULT_MARGIN } })
  },
  { id: 'letter', name: 'Letter', description: 'A formal letter with a letterhead and today’s date.', build: letter },
  { id: 'cover-letter', name: 'Cover letter', description: 'A one-page letter to send with a job application.', build: coverLetter },
  { id: 'cv', name: 'CV', description: 'Your profile, experience, education and skills.', build: cv },
  { id: 'report', name: 'Report', description: 'A title page, a table of contents and numbered pages.', build: report },
  { id: 'memo', name: 'Memo', description: 'A short internal note with To, From, Date and Subject.', build: memo },
  { id: 'meeting-notes', name: 'Meeting notes', description: 'Attendees, agenda, notes, decisions and a checklist of actions.', build: meetingNotes },
  { id: 'essay', name: 'Essay', description: 'Double-spaced, with a heading block, page numbers and works cited.', build: essay },
  { id: 'project-proposal', name: 'Project proposal', description: 'The problem, goals, scope, timeline and budget of a project.', build: proposal },
  { id: 'newsletter', name: 'Newsletter', description: 'A masthead, a lead story, shorter items and dates for the diary.', build: newsletter },
  { id: 'invoice', name: 'Invoice', description: 'Items and totals in a table, with how and when to pay.', build: invoice },
  { id: 'thank-you-note', name: 'Thank-you note', description: 'A short note of thanks on a card-sized page.', build: thankYouNote },
  { id: 'recipe', name: 'Recipe', description: 'Servings and timings, ingredients, method and tips.', build: recipe }
]

/** The built-in templates, the blank document first. */
export const TEMPLATES: readonly TemplateInfo[] = BUILT_IN.map(({ id, name, description }) => ({ id, name, description }))

function contextFor(options: TemplateOptions): TemplateContext {
  const locale = options.locale ?? (typeof navigator === 'undefined' ? 'en-GB' : navigator.language)
  const size = options.size?.toLowerCase()

  if (size !== undefined && !(size in PAGE_SIZES)) {
    throw new Error(`“${options.size}” is not a paper size Herald Docs has; it has ${Object.keys(PAGE_SIZES).join(', ')}`)
  }

  const named = size === undefined ? null : PAGE_SIZES[size as PageSizeName]
  const local = defaultPage(locale)
  const paper = named ? { width: named.width, height: named.height } : { width: local.width, height: local.height }
  const card = named ? paper : local.width === PAGE_SIZES.letter.width ? HALF_LETTER : { width: PAGE_SIZES.a5.width, height: PAGE_SIZES.a5.height }

  return { paper, card, dateFormat: /^en-US$/i.test(locale) ? 'MMMM d, yyyy' : 'd MMMM yyyy' }
}

/** A new document from a built-in template, on the locale's paper unless `size` says otherwise. */
export function documentFromTemplate(id: string, options: TemplateOptions = {}): DocJSON {
  const template = BUILT_IN.find((entry) => entry.id === id)

  if (!template) {
    throw new Error(`Herald Docs has no template “${id}”; its templates are ${TEMPLATES.map((entry) => entry.id).join(', ')}`)
  }

  return template.build(contextFor(options))
}
