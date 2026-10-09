import { printView } from '../../../../shared/office/doc-html.ts'
import { documentFromMarkdown, documentFromText, markdownFromDocument, textFromDocument, type TextLayout } from '../../../../shared/office/doc-text.ts'
import { blankDocument, type DocJSON } from '../../../../shared/office/document.ts'
import { decodeText, encodeText } from '../print.ts'
import type { OfficeAdapter } from '../types.ts'

/*
 * Herald Docs' files: Word documents (read by our own WordprocessingML mapper, written with the
 * docx package, both loaded only when a Word file is opened or saved), Markdown and plain text, and
 * the print view main turns into a PDF, its pages laid out as the page view lays them out.
 */

export const printHtml = (document: DocJSON, title: string): string => printView(document, title)

const isWord = (extension: string): boolean => extension === '.docx' || extension === '.docm'

export const docsAdapter: OfficeAdapter<DocJSON> = {
  app: 'docs',
  defaultFormat: '.docx',
  blank: () => blankDocument(),
  read: async (bytes, extension) => {
    if (isWord(extension)) {
      const { documentFromDocx } = await import('../../../../shared/office/docx/read.ts')
      const { doc, notes } = await documentFromDocx(bytes)

      return { model: doc, notes }
    }

    const { text, notes } = decodeText(bytes)
    const result = extension === '.txt' ? documentFromText(text) : documentFromMarkdown(text)

    return { model: result.document, notes: [...notes, ...result.notes], layout: result.layout }
  },
  write: async (model, extension, layout) => {
    if (isWord(extension)) {
      const { docxFromDocument } = await import('../../../../shared/office/docx/write.ts')

      return docxFromDocument(model)
    }

    const textLayout = (layout ?? {}) as Partial<TextLayout>
    const result = extension === '.txt' ? textFromDocument(model, textLayout) : markdownFromDocument(model, textLayout)

    return { bytes: encodeText(result.text), losses: result.losses }
  },
  print: async (model, name) => {
    const { printDocument } = await import('./pages/print.ts')

    return { html: await printDocument(model, name) }
  }
}
