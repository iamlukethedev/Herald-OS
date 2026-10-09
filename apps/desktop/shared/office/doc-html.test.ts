import { describe, expect, it } from 'vitest'
import { contentCss, fontStack, htmlFromDocument, looksCss, noteHtml, partHtml, type PrintPage, printView } from './doc-html.ts'
import { type DocJSON, type DocNode, PAGE_SIZES, type PageSettings, paragraphNode, textNode } from './document.ts'

const doc = (content: DocNode[], attrs: DocJSON['attrs'] = { page: null, styles: null }): DocJSON => ({ type: 'doc', attrs, content })

const letter: PageSettings = { width: PAGE_SIZES.letter.width, height: PAGE_SIZES.letter.height, margins: { top: 72, right: 72, bottom: 72, left: 72 } }

const field = (kind: string): DocNode => ({ type: 'field', attrs: { kind, format: null, instruction: null, text: null } })

const printPage = (number: number, blocks: DocNode[], extra: Partial<PrintPage> = {}): PrintPage => ({
  number,
  kind: 'default',
  page: letter,
  blocks,
  notes: { footnote: 0, endnote: 0 },
  headings: 0,
  footnotes: [],
  endnotes: [],
  endnoteRule: false,
  bodyTop: 96,
  bodyBottom: 96,
  ...extra
})

const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? ''

describe('the print view', () => {
  it('sets the page size and margins from the document, and breaks pages where it does', () => {
    const page = { width: PAGE_SIZES.letter.height, height: PAGE_SIZES.letter.width, margins: { top: 36, right: 54, bottom: 36, left: 54 } }
    const html = printView(doc([paragraphNode([textNode('One')]), { type: 'pageBreak' }, paragraphNode([textNode('Two')])], { page, styles: null }), 'Report <1>')

    expect(html).toContain('<title>Report &lt;1&gt;</title>')
    expect(html).toContain('@page { size: 792pt 612pt; margin: 36pt 54pt 36pt 54pt }')
    expect(html).toContain('<p>One</p><div class="doc-page-break"></div><p>Two</p>')
    expect(html).toContain('.doc .doc-page-break { break-after: page')
    expect(html).not.toContain('<script')
  })

  it('writes paragraphs with their layout, headings, marks and links', () => {
    const html = htmlFromDocument(
      doc([
        paragraphNode([textNode('Title')], { docStyle: 'title', textAlign: 'center' }),
        { type: 'heading', attrs: { level: 2, spaceBefore: 12 }, content: [textNode('Part')] },
        paragraphNode(
          [
            textNode('big', [{ type: 'bold' }, { type: 'textStyle', attrs: { fontSize: '18pt', color: '#ff0000' } }]),
            textNode(' site', [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'italic' }]),
            textNode(' bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
            { type: 'hardBreak' },
            textNode('x'),
            textNode('2', [{ type: 'superscript' }])
          ],
          { lineHeight: 1.5, indent: 36, firstLine: -18 }
        )
      ])
    )

    expect(html).toBe(
      '<p data-style="title" style="text-align: center">Title</p>' +
        '<h2 style="margin-top: 12pt">Part</h2>' +
        '<p style="line-height: 1.8; margin-left: 36pt; text-indent: -18pt"><span style="color: #ff0000; font-size: 18pt"><strong>big</strong></span><a href="https://example.com"><em> site</em></a> bad<br>x<sup>2</sup></p>'
    )
  })

  it('writes lists, checklists, tables with spans and widths, callouts, code and pictures', () => {
    const html = htmlFromDocument(
      doc([
        { type: 'orderedList', attrs: { start: 3, type: 'a' }, content: [{ type: 'listItem', content: [paragraphNode([textNode('c')])] }] },
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraphNode([textNode('done')])] }] },
        {
          type: 'table',
          attrs: { borders: false },
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2, colwidth: [100, 50] }, content: [paragraphNode([textNode('H')])] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', attrs: { background: '#eeeeee' }, content: [paragraphNode()] }, { type: 'tableCell', content: [paragraphNode()] }] }
          ]
        },
        { type: 'callout', attrs: { kind: 'warning' }, content: [paragraphNode([textNode('Mind')])] },
        { type: 'codeBlock', attrs: { language: 'js' }, content: [textNode('a < b')] },
        paragraphNode([{ type: 'image', attrs: { src: 'data:image/png;base64,AA==', alt: 'A "dot"', width: 40.4, height: 20 } }, { type: 'image', attrs: { src: 'file:///etc/passwd' } }])
      ])
    )

    expect(html).toContain('<ol start="3" type="a"><li><p>c</p></li></ol>')
    expect(html).toContain('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label>☑</label><div><p>done</p></div></li></ul>')
    // Tables and pictures are sized as the editor sizes them, so they take the same room on paper.
    expect(html).toContain('<div class="tableWrapper"><table data-borders="none" style="width: 150px"><colgroup><col style="width: 100px"><col style="width: 50px"></colgroup><tbody><tr><th colspan="2"><p>H</p></th></tr><tr><td style="background-color: #eeeeee"><p><br></p></td><td><p><br></p></td></tr></tbody></table></div>')
    expect(html).toContain('<div class="doc-callout" data-callout="warning"><p>Mind</p></div>')
    expect(html).toContain('<pre><code>a &lt; b</code></pre>')
    expect(html).toContain('<p><img src="data:image/png;base64,AA==" alt="A &quot;dot&quot;" style="width: 40.4px; height: 20px"></p>')
    expect(htmlFromDocument(doc([{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [20] }, content: [paragraphNode()] }, { type: 'tableCell', content: [paragraphNode()] }] }] }]))).toContain(
      '<table style="min-width: 56px"><colgroup><col style="width: 36px"><col style="min-width: 36px"></colgroup>'
    )
  })
})

describe('pages in the print view', () => {
  const headers = {
    header: { default: [paragraphNode([textNode('Report')])], first: [paragraphNode([textNode('Cover')])] },
    footer: { default: [paragraphNode([textNode('Page '), field('page'), textNode(' of '), field('pages')])] },
    differentFirst: true
  }

  it('prints each page as the page view laid it out: its header, its part of the text, its footnotes and its footer with page numbers', () => {
    const document = doc([paragraphNode([textNode('One')]), paragraphNode([textNode('Two')])], { page: letter, styles: null, headers })
    const html = printView(document, 'Plan', [
      printPage(1, [paragraphNode([textNode('One'), { type: 'note', attrs: { kind: 'footnote', content: [paragraphNode([textNode('A note')])] } }])], { kind: 'first', footnotes: [{ number: 1, content: [paragraphNode([textNode('A note')])] }] }),
      printPage(2, [paragraphNode([textNode('Two')])], { notes: { footnote: 1, endnote: 0 }, bodyTop: 120 })
    ])
    const pages = body(html).split('<section').slice(1)

    expect(html).toContain('@page { size: 612pt 792pt; margin: 0 }')
    expect(html).toContain('.doc-page { position: relative; overflow: hidden; contain: size layout paint; break-after: page')
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('<div class="doc-part doc-header" data-page-part="header" style="top: 48px; left: 96px; width: 624px"><p>Cover</p></div>')
    expect(pages[0]).toContain('<div class="doc doc-page-body" style="top: 96px; left: 96px; width: 624px"><p>One<sup class="doc-note-ref" data-note="footnote">1</sup></p></div>')
    expect(pages[0]).toContain('<div class="doc-part doc-footnotes" style="bottom: 96px; left: 96px; width: 624px"><div class="doc-notes-rule"></div><div class="doc-note" data-note="footnote" data-number="1"><p><sup class="doc-note-label">1</sup>A note</p></div></div>')
    // The first page has a header of its own and no footer, as in Word.
    expect(pages[0]).not.toContain('data-page-part="footer"')
    expect(pages[1]).toContain('<p>Report</p>')
    expect(pages[1]).toContain('style="top: 120px; left: 96px; width: 624px"><p>Two</p>')
    expect(pages[1]).toContain('<p>Page <span class="doc-field">2</span> of <span class="doc-field">2</span></p>')
  })

  it('gives pages of other sizes named pages of their own', () => {
    const landscape = { ...letter, width: letter.height, height: letter.width }
    const html = printView(doc([paragraphNode()], { page: letter, styles: null }), 'Plan', [printPage(1, [paragraphNode()]), printPage(2, [paragraphNode()], { page: landscape })])

    expect(html).toContain('@page size1 { size: 792pt 612pt; margin: 0 } .doc-page[data-size="1"] { page: size1 }')
    expect(body(html)).toContain('<section class="doc-page" data-size="1" style="width: 792pt; height: 612pt">')
  })

  it('numbers a table of contents with the pages its headings print on, linked to them', () => {
    const heading = (level: number, text: string): DocNode => ({ type: 'heading', attrs: { level }, content: [textNode(text)] })
    const toc: DocNode = { type: 'tableOfContents', attrs: { levels: 2, title: 'Contents', pages: null } }
    const document = doc([toc, heading(1, 'Plan'), heading(3, 'Detail'), heading(2, 'Costs')], { page: letter, styles: null })
    const html = body(printView(document, 'Plan', [printPage(1, [toc, heading(1, 'Plan'), heading(3, 'Detail')]), printPage(2, [heading(2, 'Costs')], { headings: 2 })]))

    expect(html).toContain('<div class="doc-toc" data-toc="2"><p class="doc-toc-title">Contents</p><p class="doc-toc-entry" data-level="1"><a href="#doc-heading-0"><span class="doc-toc-text">Plan</span><span class="doc-toc-dots"></span><span class="doc-toc-page">1</span></a></p>')
    expect(html).toContain('<p class="doc-toc-entry" data-level="2"><a href="#doc-heading-2"><span class="doc-toc-text">Costs</span><span class="doc-toc-dots"></span><span class="doc-toc-page">2</span></a></p></div>')
    expect(html).toContain('<h1 id="doc-heading-0">Plan</h1><h3 id="doc-heading-1">Detail</h3>')
    expect(html).toContain('<h2 id="doc-heading-2">Costs</h2>')
  })

  it('leaves out of a block a page starts inside its second indent, list marker and edge, and numbers a cut list on', () => {
    const list: DocNode = { type: 'orderedList', attrs: { start: 4, continued: true }, content: [{ type: 'listItem', attrs: { continued: true }, content: [paragraphNode([textNode('rest')], { firstLine: 18, continued: true })] }] }
    const html = printView(doc([], { page: letter, styles: null }), 'Plan', [printPage(1, []), printPage(2, [list])])

    expect(body(html)).toContain('<ol class="doc-continued" start="4"><li class="doc-continued"><p class="doc-continued" style="text-indent: 18pt">rest</p></li></ol>')
    expect(html).toContain('.doc-continued { margin-top: 0 !important; padding-top: 0 !important; border-top-width: 0 !important;')
    expect(html).toContain('li.doc-continued { list-style-type: none }')
    expect(html).toContain('.doc-page + .doc-page .doc-page-body > :first-child { margin-top: 0 }')
  })

  it('lets the text flow over pages without the page view, listing footnotes and endnotes at its end', () => {
    const note = (kind: string, text: string): DocNode => ({ type: 'note', attrs: { kind, content: [paragraphNode([textNode(text)])] } })
    const html = body(printView(doc([paragraphNode([textNode('A'), note('footnote', 'foot'), note('endnote', 'end'), note('endnote', 'later')])]), 'Plan'))

    expect(html).toContain('<p>A<sup class="doc-note-ref" data-note="footnote">1</sup><sup class="doc-note-ref" data-note="endnote">i</sup><sup class="doc-note-ref" data-note="endnote">ii</sup></p>')
    expect(html).toContain('<div class="doc-endnotes"><div class="doc-notes-rule"></div><div class="doc-note" data-note="footnote" data-number="1"><p><sup class="doc-note-label">1</sup>foot</p></div></div>')
    expect(html).toContain('<div class="doc-note" data-note="endnote" data-number="2"><p><sup class="doc-note-label">ii</sup>later</p></div>')
  })
})

describe('the new nodes', () => {
  it('fills in fields with their page, and draws section breaks, text boxes and comments', () => {
    const html = htmlFromDocument(
      doc([
        paragraphNode([field('page'), textNode(' / '), field('pages'), textNode(' '), { type: 'field', attrs: { kind: 'other', text: 'kept' } }]),
        { type: 'sectionBreak', attrs: { kind: 'oddPage', page: null } },
        { type: 'textBox', attrs: { width: 144, height: 36, align: 'right', border: '#000000', fill: null }, content: [paragraphNode([textNode('Boxed', [{ type: 'comment', attrs: { id: 'c1' } }])])] }
      ]),
      { page: 3, pages: 9 }
    )

    expect(html).toBe(
      '<p><span class="doc-field">3</span> / <span class="doc-field">9</span> <span class="doc-field">kept</span></p>' +
        '<div class="doc-section-break" data-section-break="oddPage"></div>' +
        '<div class="doc-text-box" data-text-box="" data-align="right" data-border="#000000" style="width: 144pt; min-height: 36pt; border: 0.75pt solid #000000"><p>Boxed</p></div>'
    )
  })

  it('draws headers with their page and notes with their number first', () => {
    expect(partHtml([paragraphNode([textNode('p. '), field('page')])], { page: 12 })).toBe('<p>p. <span class="doc-field">12</span></p>')
    expect(noteHtml('endnote', 4, [paragraphNode([textNode('See')]), paragraphNode([textNode('more')])])).toBe('<div class="doc-note" data-note="endnote" data-number="4"><p><sup class="doc-note-label">iv</sup>See</p><p>more</p></div>')
    expect(contentCss('.p', 'print')).toContain('.p .doc-section-break:not([data-section-break="continuous"]) { break-after: page;')
    expect(contentCss('.p', 'screen')).toContain('.p .doc-page-break, .p .doc-section-break { position: relative; height: 0; margin: 0; border: 0 }')
  })
})

describe('typography', () => {
  it("gives each style the document's own look over Herald's", () => {
    const css = looksCss(doc([], { page: null, styles: { normal: { font: 'Calibri', size: 12 }, heading1: { size: 16, color: '#2f5496', bold: false } } }), '.doc')

    expect(css).toContain('.doc { font-family: Calibri, Carlito, "Helvetica Neue", Arial, "Liberation Sans", sans-serif; font-size: 12pt; line-height: 1.38 }')
    expect(css).toContain('.doc h1 { font-size: 16pt; color: #2f5496; font-weight: 400; margin: 20pt 0 6pt }')
    expect(css).toContain('.doc h2 { font-size: 16pt; font-weight: 700; margin: 18pt 0 6pt }')
  })

  it('falls back on faces of the same kind', () => {
    expect(fontStack('Times New Roman')).toBe('"Times New Roman", "Liberation Serif", Tinos, Georgia, serif')
    expect(fontStack('Fira Code')).toBe('"Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace')
    expect(fontStack(null)).toBe('"Helvetica Neue", Arial, "Liberation Sans", sans-serif')
  })

  it('draws borderless tables with guides on screen and none on paper, taking the same room', () => {
    expect(contentCss('.p', 'screen')).toContain('.p table[data-borders="none"] td, .p table[data-borders="none"] th { border: 0.75pt dashed #d5dae2 }')
    expect(contentCss('.p', 'print')).toContain('.p table[data-borders="none"] td, .p table[data-borders="none"] th { border: 0.75pt solid transparent }')
  })
})
