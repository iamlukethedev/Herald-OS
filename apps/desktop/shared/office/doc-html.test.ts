import { describe, expect, it } from 'vitest'
import { contentCss, fontStack, htmlFromDocument, looksCss, printView } from './doc-html.ts'
import { type DocJSON, type DocNode, PAGE_SIZES, paragraphNode, textNode } from './document.ts'

const doc = (content: DocNode[], attrs: DocJSON['attrs'] = { page: null, styles: null }): DocJSON => ({ type: 'doc', attrs, content })

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
