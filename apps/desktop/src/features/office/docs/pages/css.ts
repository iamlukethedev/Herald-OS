import { contentCss, looksCss, partCss } from '../../../../../shared/office/doc-html.ts'
import type { StyleLooks } from '../../../../../shared/office/document.ts'

/** The CSS a document's pages are drawn with: its own looks and the print view's content rules, for its text and its headers, footers and notes. */
export function pageCss(key: string, styles: StyleLooks | null): string {
  const prefix = `[data-docs-page="${key}"]`
  const scope = `${prefix} :is(.tiptap, .doc-part)`

  return [looksCss({ type: 'doc', attrs: { styles } }, scope), contentCss(scope, 'screen'), partCss(prefix)].join('\n')
}
