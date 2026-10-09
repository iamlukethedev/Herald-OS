import type { DocJSON } from '../../../../../shared/office/document.ts'
import { bold, bullets, field, heading, type Inline, lines, para, paper, rule, run, type RunLook, table, type TemplateContext, templateDocument, textWidth, title } from './build.ts'

/* Letters and notes: a formal letter on letterhead, an internal memo and a thank-you note on a card. */

const GREY = '#6B7280'

/** A formal letter: a letterhead at the top of each page, today's date, the addressee and a signature. */
export function letter({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const navy = '#1F3A5F'
  const letterhead = [
    para(run('Company Name', { bold: true, size: 18, color: navy }), { lineHeight: 1, spaceAfter: 3 }),
    para(run('Street Address · Town · Postcode · Phone Number · name@example.com', { size: 8.5, color: GREY }), { spaceAfter: 0 })
  ]

  return templateDocument(
    paper(size, { top: 108, right: 72, bottom: 72, left: 72 }),
    { normal: { font: 'Georgia', size: 11, color: '#222222', lineHeight: 1.2, spaceBefore: 0, spaceAfter: 10 } },
    [
      para(field('date', dateFormat), { spaceAfter: 24 }),
      para(lines('Recipient Name', 'Job Title', 'Company Name', 'Street Address', 'Town and Postcode'), { spaceAfter: 24 }),
      para(bold('Subject of the letter')),
      para('Dear Recipient Name,'),
      para('Start with why you are writing, in a sentence or two, so that the reader knows at once what the letter is about.'),
      para('Use the middle paragraphs for the details: what has happened, what you need and any dates or figures the reader should have. One idea to a paragraph keeps a letter easy to follow.'),
      para('Close by saying what happens next or what you would like the reader to do, and how best to reach you.'),
      para('Yours sincerely,', { spaceBefore: 8, spaceAfter: 44 }),
      para(lines(bold('Your Name'), 'Your Job Title'))
    ],
    { header: { default: letterhead }, footer: {} }
  )
}

/** A memo: To, From, Date and Subject over a short note in sections, page numbers at the foot. */
export function memo({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const burgundy = '#7B2D26'
  const small: RunLook = { size: 9, color: GREY }
  const page = paper(size, 72)
  const row = (label: string, value: Inline): Inline[] => [bold(label), value]

  return templateDocument(
    page,
    {
      normal: { font: 'Arial', size: 11, color: '#1F1F1F', lineHeight: 1.2, spaceBefore: 0, spaceAfter: 8 },
      title: { font: 'Arial', size: 32, bold: true, color: burgundy, spaceBefore: 0, spaceAfter: 14 },
      heading2: { font: 'Arial', size: 12.5, bold: true, color: burgundy, spaceBefore: 16, spaceAfter: 4 }
    },
    [
      title('Memo'),
      table([row('To', 'Recipient Name, Team or Department'), row('From', 'Your Name, Job Title'), row('Copy to', 'Anyone else who should know'), row('Date', field('date', dateFormat)), row('Subject', 'What the memo is about, in a few words')], { columns: [1, 4], width: textWidth(page), borders: false }),
      rule(),
      para('Open with the purpose of the memo in a sentence or two: what has been decided, what is changing or what you need from the reader.'),
      heading(2, 'Background'),
      para('Give only the context the reader needs to understand the decision or the request.'),
      heading(2, 'Details'),
      bullets(['Use short points for dates, figures and who is responsible for what.', 'Put the most important point first.', 'Keep the whole memo to a page if you can.']),
      heading(2, 'Next steps'),
      para('Say who does what, and by when. Invite questions, and say how to reach you.')
    ],
    { header: {}, footer: { default: [para([run('Company Name · Internal · Page ', small), field('page', null, small)], { textAlign: 'center' })] } }
  )
}

/** A thank-you note on a card-sized page. */
export function thankYouNote({ card }: TemplateContext): DocJSON {
  const plum = '#8E4B6E'

  return templateDocument(
    paper(card, 54),
    {
      normal: { font: 'Georgia', size: 11.5, color: '#2B2B2B', lineHeight: 1.35, spaceBefore: 0, spaceAfter: 10 },
      title: { font: 'Georgia', size: 36, italic: true, color: plum, spaceBefore: 48, spaceAfter: 4 }
    },
    [
      title('Thank you', { textAlign: 'center' }),
      para(run('·  ·  ·', { color: plum }), { textAlign: 'center', spaceAfter: 28 }),
      para('Dear Name,'),
      para('Say what you are thanking them for, and be specific: the gift, the help or the kindness, and what it meant to you.'),
      para('Add a line about how you will use the gift, the difference their help made, or when you hope to see them next.'),
      para('With warm wishes,', { spaceBefore: 14, spaceAfter: 4 }),
      para('Your Name')
    ]
  )
}
