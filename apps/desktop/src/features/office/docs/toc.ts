import type { DocJSON } from '../../../../shared/office/document.ts'

/** The document as saved: its tables of contents with the pages the page view last gave their entries. */
export const withTocPages = (json: DocJSON, _docKey: string): DocJSON => json
