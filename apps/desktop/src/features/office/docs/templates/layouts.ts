import type { DocJSON } from '../../../../../shared/office/document.ts'
import { bold, bullets, callout, cell, field, heading, type Inline, italic, lines, numbered, para, paper, quote, rule, run, type RunLook, subtitle, table, type TemplateContext, templateDocument, textWidth, title } from './build.ts'

/* Documents laid out in parts: a newsletter, an invoice and a recipe. */

const GREY = '#6B7280'

const SMALL: RunLook = { size: 8.5, color: GREY }

/** A newsletter: a masthead, what is in the issue, a lead story, shorter items and dates for the diary. */
export function newsletter({ paper: size }: TemplateContext): DocJSON {
  const terracotta = '#A3472A'
  const tint = '#F6E9E3'
  const page = paper(size, 54)

  return templateDocument(
    page,
    {
      normal: { font: 'Arial', size: 10.5, color: '#222222', lineHeight: 1.3, spaceBefore: 0, spaceAfter: 8 },
      title: { font: 'Georgia', size: 38, bold: true, color: terracotta, spaceBefore: 0, spaceAfter: 0 },
      subtitle: { font: 'Arial', size: 10, color: '#6B6B6B', spaceBefore: 2, spaceAfter: 4 },
      heading1: { font: 'Georgia', size: 22, bold: true, color: '#222222', spaceBefore: 14, spaceAfter: 4 },
      heading2: { font: 'Georgia', size: 15, bold: true, color: terracotta, spaceBefore: 16, spaceAfter: 4 },
      quote: { font: 'Georgia', size: 13, italic: true, color: terracotta }
    },
    [
      title('Newsletter Name'),
      subtitle('Issue 1 · Month Year · Organisation Name'),
      rule(),
      table([[cell([para(bold('In this issue'), { spaceAfter: 2 }), para(lines('Lead story headline', 'Second story', 'Dates for your diary', 'Get in touch'))], { fill: tint })]], { columns: [1], width: textWidth(page), borders: false }),
      heading(1, 'Lead story headline'),
      para(italic('A one-sentence summary that makes people want to read on.'), { spaceAfter: 10 }),
      para('Open with the most important or most interesting news. Say what happened, who it affects and why it matters, then add the detail in the paragraphs that follow.'),
      para('Keep paragraphs short: two to four sentences read well in a newsletter. A quote from someone involved brings a story to life.'),
      quote([para('“A short, lively quote from someone in the story.” Name, Role')]),
      heading(2, 'Second story'),
      para('A shorter item: an update, a success to celebrate or a new face to welcome. Link to more detail rather than putting it all here.'),
      heading(2, 'Dates for your diary'),
      table(
        [
          ['Date', 'Event', 'Where'],
          ['Day Month', 'Event name', 'Place or link'],
          ['Day Month', 'Event name', 'Place or link']
        ],
        { columns: [2, 4, 3], width: textWidth(page), header: true, headerFill: tint }
      ),
      heading(2, 'Get in touch'),
      para('Tell readers how to send news, ideas or feedback: name@example.com.')
    ],
    { header: {}, footer: { default: [para([run('Newsletter Name · Issue 1 · Page ', SMALL), field('page', null, SMALL)], { textAlign: 'center' })] } }
  )
}

/** An invoice: who it is from and to, its number and dates, a table of items with totals, and how to pay. */
export function invoice({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const slate = '#34495E'
  const page = paper(size, 54)
  const width = textWidth(page)
  const right = { textAlign: 'right' as const }
  const detail = (label: string, value: Inline) => para([bold(label), value], right)
  const total = (label: Inline, amount: Inline) => [cell([para(label, right)], { span: 3 }), cell([para(amount, right)])]

  return templateDocument(
    page,
    {
      normal: { font: 'Arial', size: 10, color: '#1F2328', lineHeight: 1.2, spaceBefore: 0, spaceAfter: 4 },
      title: { font: 'Arial', size: 30, bold: true, color: slate, spaceBefore: 0, spaceAfter: 10 }
    },
    [
      title('Invoice'),
      table(
        [
          [
            cell([para(bold('Company Name')), para(lines('Street Address', 'Town and Postcode', 'Phone Number', 'name@example.com'))]),
            cell([detail('Invoice number: ', 'INV-0001'), detail('Date: ', field('date', dateFormat)), detail('Due: ', 'Day Month Year'), detail('Reference: ', 'Order or project')])
          ]
        ],
        { columns: [1, 1], width, borders: false }
      ),
      para(bold('Bill to'), { spaceBefore: 14 }),
      para(lines('Client Name', 'Company Name', 'Street Address', 'Town and Postcode'), { spaceAfter: 14 }),
      table(
        [
          ['Description', 'Quantity', 'Unit price', 'Amount'],
          ['Item or service, with a short description', '1', '0.00', '0.00'],
          ['Another item or service', '2', '0.00', '0.00'],
          ['Another item or service', '1', '0.00', '0.00'],
          total('Subtotal', '0.00'),
          total('Tax (0%)', '0.00'),
          total(bold('Total due'), bold('0.00'))
        ],
        { columns: [6, 2, 2, 2], width, header: true, headerFill: '#E8EDF2', align: [null, 'right', 'right', 'right'] }
      ),
      para(bold('Payment'), { spaceBefore: 16 }),
      para('Please pay within 30 days of the invoice date, by bank transfer to Account Name at Bank Name, account number 00000000, quoting the invoice number.'),
      para(italic('Thank you for your business.'), { textAlign: 'center', spaceBefore: 18 })
    ],
    { header: {}, footer: { default: [para([run('Company Name · Registered Address · Company or Tax Number · Page ', SMALL), field('page', null, SMALL)], { textAlign: 'center' })] } }
  )
}

/** A recipe: servings and timings at a glance, the ingredients, the method and a few tips. */
export function recipe({ paper: size }: TemplateContext): DocJSON {
  const olive = '#56702E'
  const page = paper(size, 72)
  const fact = (label: string, value: string) => cell([para(run(label, { bold: true, size: 8, color: olive }), { spaceAfter: 0 }), para(value, { spaceAfter: 0 })], { fill: '#F1F4EA' })

  return templateDocument(
    page,
    {
      normal: { font: 'Arial', size: 10.5, color: '#2B2B2B', lineHeight: 1.3, spaceBefore: 0, spaceAfter: 6 },
      title: { font: 'Georgia', size: 32, color: olive, spaceBefore: 0, spaceAfter: 4 },
      subtitle: { font: 'Georgia', size: 13, italic: true, color: '#5F6B55', spaceBefore: 0, spaceAfter: 14 },
      heading1: { font: 'Georgia', size: 17, bold: true, color: olive, spaceBefore: 18, spaceAfter: 6 }
    },
    [
      title('Recipe Name'),
      subtitle('A line about the dish: where it comes from, or why it is a favourite.'),
      table([[fact('SERVES', '4'), fact('PREPARATION', '15 minutes'), fact('COOKING', '30 minutes'), fact('DIFFICULTY', 'Easy')]], { columns: [1, 1, 1, 1], width: textWidth(page), borders: false }),
      heading(1, 'Ingredients'),
      bullets(['A quantity and an ingredient, with how to prepare it, such as 1 onion, finely chopped', 'The ingredients in the order you use them', 'Small headings for the parts of a dish, such as a sauce, if it has them', 'Salt and pepper, to taste']),
      heading(1, 'Method'),
      numbered([
        'Start with what to prepare first: heat the oven, line a tin or bring water to the boil.',
        'Give one step to an item, in the order you do them, with times and temperatures.',
        'Say what to look for, such as “until golden” or “until it coats the back of a spoon”.',
        'Finish with how to serve it, and what goes well alongside.'
      ]),
      callout('success', [para(bold('Tips'), { spaceAfter: 2 }), para('Note what can be swapped, how to keep any leftovers, and how far ahead it can be made.')])
    ],
    { header: {}, footer: { default: [para(run('From the kitchen of Your Name', { ...SMALL, italic: true }), { textAlign: 'center' })] } }
  )
}
