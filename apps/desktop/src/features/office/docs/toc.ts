import type { DocJSON } from '../../../../shared/office/document.ts'
import { fillTocPages } from './review-ops.ts'
import { $pages } from './store.ts'

/** The document as saved: its tables of contents with the pages the page view last gave their entries. */
export const withTocPages = (json: DocJSON, docKey: string): DocJSON => fillTocPages(json, $pages.get()[docKey]?.headings)
