import { contentCss, htmlFromDocument, looksCss } from '../../../../../shared/office/doc-html.ts'
import { type DocJSON, type DocNode, headersOf, pageOf, pagePart, type PageSettings } from '../../../../../shared/office/document.ts'
import { type FieldContext, fieldText } from '../../../../../shared/office/fields.ts'

/*
 * A document's first page as a thumbnail: the header and footer page 1 shows, the blocks before
 * the first page or new-page section break, and the document's own styles under a scope, all as
 * the print view draws them. Fields show what they would on page 1.
 */

export interface Thumbnail {
  page: PageSettings
  header: string | null
  body: string
  footer: string | null
  css: string
}

/** The top-level blocks the first page starts with: those before the first page break or new-page section. */
export function firstPageBlocks(doc: DocJSON): DocNode[] {
  const end = doc.content.findIndex((node) => node.type === 'pageBreak' || (node.type === 'sectionBreak' && node.attrs?.kind !== 'continuous'))

  return end < 0 ? doc.content : doc.content.slice(0, end)
}

function filledIn(nodes: DocNode[], context: FieldContext): DocNode[] {
  return nodes.map((node) => {
    if (node.type === 'field') {
      return { type: 'text', text: fieldText(node.attrs, context), ...(node.marks ? { marks: node.marks } : {}) }
    }

    return node.content ? { ...node, content: filledIn(node.content, context) } : node
  })
}

/** The parts of the first page's thumbnail, with CSS for `scope` (the element the page is drawn in). */
export function thumbnailOf(doc: DocJSON, scope: string, context: FieldContext = {}): Thumbnail {
  const fields: FieldContext = { page: 1, pages: 1, ...context }
  const html = (blocks: DocNode[] | null) => (blocks?.length ? htmlFromDocument({ type: 'doc', content: filledIn(blocks, fields) }) : null)
  const headers = headersOf(doc)

  return {
    page: pageOf(doc),
    header: html(pagePart(headers, 'header', 1)),
    body: html(firstPageBlocks(doc)) ?? '',
    footer: html(pagePart(headers, 'footer', 1)),
    css: [`${scope} { overflow-wrap: break-word; white-space: pre-wrap; tab-size: 36pt }`, looksCss(doc, scope), contentCss(scope, 'print')].join('\n')
  }
}
