import type { DocJSON } from '../../../../../shared/office/document.ts'
import { bold, bullets, checklist, contents, field, heading, type Inline, italic, lines, numbered, pageBreak, para, paper, run, type RunLook, subtitle, table, type TemplateContext, templateDocument, textWidth, title } from './build.ts'

/* Longer documents: a report, an essay, a project proposal and the notes of a meeting. */

const GREY = '#6B7280'

const SMALL: RunLook = { size: 9, color: GREY }

/** "Page X of Y" in small grey type, for a footer. */
const pageOfPages = (before = 'Page '): Inline[] => [run(before, SMALL), field('page', null, SMALL), run(' of ', SMALL), field('pages', null, SMALL)]

/** A report: a title page with nothing at its head or foot, a table of contents, and numbered pages after them. */
export function report({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const blue = '#1F4E79'

  return templateDocument(
    paper(size, 72),
    {
      normal: { font: 'Calibri', size: 11, color: '#1F2328', lineHeight: 1.2, spaceBefore: 0, spaceAfter: 8 },
      title: { font: 'Cambria', size: 36, color: blue, spaceBefore: 150, spaceAfter: 8 },
      subtitle: { font: 'Calibri', size: 15, color: '#5B6B7D', spaceBefore: 0, spaceAfter: 48 },
      heading1: { font: 'Cambria', size: 18, bold: true, color: blue, spaceBefore: 24, spaceAfter: 6 },
      heading2: { font: 'Cambria', size: 14, bold: true, color: '#2E74B5', spaceBefore: 16, spaceAfter: 4 },
      heading3: { font: 'Calibri', size: 12, bold: true, color: blue, spaceBefore: 12, spaceAfter: 2 }
    },
    [
      title('Report Title'),
      subtitle('A one-line summary of what this report covers'),
      para(lines(bold('Your Name'), 'Organisation Name', field('date', dateFormat))),
      pageBreak(),
      contents(3),
      pageBreak(),
      heading(1, 'Summary'),
      para('Sum up the purpose of the report, the main findings and what you recommend in a few short paragraphs. Many readers stop here, so make it stand on its own.'),
      heading(1, 'Introduction'),
      para('Explain why the report was written, the question it answers and what it covers. Mention anything it deliberately leaves out.'),
      heading(1, 'Findings'),
      heading(2, 'First finding'),
      para('Lead with the point, then give the evidence for it. A table or a chart helps when there are figures to compare.'),
      heading(2, 'Second finding'),
      para('Keep each finding to one idea, and say where its evidence came from.'),
      heading(1, 'Recommendations'),
      numbered(['A clear, specific action, and who should take it.', 'A second action, in order of priority.', 'A third, if one is needed.']),
      heading(1, 'Conclusion'),
      para('Draw the findings and the recommendations together in a short paragraph, without adding anything new.')
    ],
    {
      header: { default: [para(run('Report Title', SMALL), { textAlign: 'right' })] },
      footer: { default: [para(pageOfPages(), { textAlign: 'center' })] },
      differentFirst: true
    }
  )
}

/** An essay: double-spaced, with a heading block, the surname and page number at the head of each page, and works cited. */
export function essay({ paper: size }: TemplateContext): DocJSON {
  const body = (text: string) => para(text, { firstLine: 36 })
  const source = (parts: Inline[]) => para(parts, { indent: 36, firstLine: -36 })

  return templateDocument(
    paper(size, 72),
    {
      normal: { font: 'Times New Roman', size: 12, color: '#000000', lineHeight: 2, spaceBefore: 0, spaceAfter: 0 },
      title: { font: 'Times New Roman', size: 12, spaceBefore: 0, spaceAfter: 0 }
    },
    [
      para('Your Name'),
      para('Instructor Name'),
      para('Course Name'),
      para(field('date', 'd MMMM yyyy')),
      title('Essay Title', { textAlign: 'center' }),
      body('Open with a sentence that draws the reader in, then narrow to your topic. End the introduction with your thesis: the one claim the rest of the essay sets out to support.'),
      body('Give each body paragraph one main idea. Begin with a topic sentence that links back to the thesis, support it with evidence such as quotations, figures or examples, and explain what that evidence shows.'),
      body('Build the argument step by step. Answer the strongest objection where it helps your case, and use transitions so that each paragraph follows from the last.'),
      body('In the conclusion, restate the thesis in fresh words and draw the threads together. Show why the argument matters rather than adding new evidence.'),
      pageBreak(),
      title('Works Cited', { textAlign: 'center' }),
      source(['Surname, First Name. ', italic('Title of the Book'), '. Publisher, Year.']),
      source(['Surname, First Name. “Title of the Article.” ', italic('Name of the Journal'), ', vol. 1, no. 2, Year, pp. 1–10.']),
      source(['Organisation Name. “Title of the Web Page.” ', italic('Name of the Website'), ', Day Month Year, example.com/page.'])
    ],
    { header: { default: [para(['Surname ', field('page')], { textAlign: 'right', lineHeight: 1 })] }, footer: {} }
  )
}

/** A project proposal: the problem, goals, scope, a timeline and a budget, with "Page X of Y" at the foot. */
export function proposal({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const indigo = '#4B3B8F'
  const fill = '#ECE9F6'
  const page = paper(size, 72)
  const width = textWidth(page)

  return templateDocument(
    page,
    {
      normal: { font: 'Arial', size: 10.5, color: '#1F1F24', lineHeight: 1.25, spaceBefore: 0, spaceAfter: 8 },
      title: { font: 'Arial', size: 30, bold: true, color: indigo, spaceBefore: 0, spaceAfter: 2 },
      subtitle: { font: 'Arial', size: 15, color: '#6B6880', spaceBefore: 0, spaceAfter: 20 },
      heading1: { font: 'Arial', size: 15, bold: true, color: indigo, spaceBefore: 20, spaceAfter: 6 }
    },
    [
      title('Project Name'),
      subtitle('Project proposal'),
      table(
        [
          [bold('Prepared for'), 'Client or Sponsor Name'],
          [bold('Prepared by'), 'Your Name, Company Name'],
          [bold('Date'), field('date', dateFormat)],
          [bold('Version'), '1.0']
        ],
        { columns: [1, 3], width, borders: false }
      ),
      heading(1, 'Summary'),
      para('In a short paragraph, say what you propose, why it matters and what it will take in time and money. Write it last, once the rest is settled.'),
      heading(1, 'The problem'),
      para('Describe the need or the opportunity, who it affects and what happens if nothing changes. Give evidence where you have it.'),
      heading(1, 'Goals'),
      bullets(['A goal you can measure, such as “Halve the time it takes to answer a request by June”.', 'A second goal.', 'A third goal, if there is one.']),
      heading(1, 'Scope'),
      para([bold('In scope: '), 'what the project will deliver.']),
      para([bold('Out of scope: '), 'what it will not cover, so that expectations are clear from the start.']),
      heading(1, 'Timeline'),
      table(
        [
          ['Phase', 'When', 'What it delivers'],
          ['Discovery', 'Weeks 1–2', 'Findings and an agreed plan'],
          ['Delivery', 'Weeks 3–8', 'The main work, in stages'],
          ['Review', 'Weeks 9–10', 'Testing, handover and a short report']
        ],
        { columns: [2, 2, 5], width, header: true, headerFill: fill }
      ),
      heading(1, 'Budget'),
      table(
        [
          ['Item', 'Cost'],
          ['People', '0.00'],
          ['Tools and services', '0.00'],
          [bold('Total'), bold('0.00')]
        ],
        { columns: [4, 2], width, header: true, headerFill: fill, align: [null, 'right'] }
      ),
      heading(1, 'Team'),
      bullets([
        [bold('Team Member Name'), ', Role: what they are responsible for.'],
        [bold('Team Member Name'), ', Role: what they are responsible for.']
      ]),
      heading(1, 'Next steps'),
      para('Say what you need from the reader to go ahead, such as an approval, a meeting or a decision, and by when.')
    ],
    {
      header: { default: [para(run('Project Name · Proposal', SMALL), { textAlign: 'right' })] },
      footer: { default: [para(pageOfPages(), { textAlign: 'center' })] }
    }
  )
}

/** Meeting notes: when and where, the attendees and agenda, notes, decisions and a checklist of actions. */
export function meetingNotes({ paper: size, dateFormat }: TemplateContext): DocJSON {
  const forest = '#2F6B4F'
  const gap = '  ·  '

  return templateDocument(
    paper(size, 72),
    {
      normal: { font: 'Calibri', size: 11, color: '#1F2328', lineHeight: 1.2, spaceBefore: 0, spaceAfter: 6 },
      title: { font: 'Calibri', size: 26, bold: true, color: forest, spaceBefore: 0, spaceAfter: 6 },
      heading2: { font: 'Calibri', size: 13, bold: true, color: forest, spaceBefore: 16, spaceAfter: 4 },
      heading3: { font: 'Calibri', size: 11.5, bold: true, color: '#1F2328', spaceBefore: 10, spaceAfter: 2 }
    },
    [
      title('Meeting Title'),
      para([bold('Date: '), field('date', dateFormat), gap, bold('Time: '), '10:00–11:00', gap, bold('Where: '), 'Room or video link']),
      para([bold('Chair: '), 'Name', gap, bold('Notes: '), 'Name'], { spaceAfter: 10 }),
      heading(2, 'Attendees'),
      bullets(['Attendee Name, Role', 'Attendee Name, Role', 'Attendee Name, Role']),
      heading(2, 'Agenda'),
      numbered(['Welcome and the goal of the meeting (5 minutes)', 'First topic (15 minutes)', 'Second topic (15 minutes)', 'Actions and the next meeting (5 minutes)']),
      heading(2, 'Notes'),
      heading(3, 'First topic'),
      bullets(['The main points raised, and who raised them.', 'Questions still open, and who will answer them.']),
      heading(3, 'Second topic'),
      bullets(['What was agreed, and why.']),
      heading(2, 'Decisions'),
      bullets(['Each decision made in the meeting, in one sentence.']),
      heading(2, 'Actions'),
      checklist(['Owner Name: what they will do, by Day Month', 'Owner Name: a follow-up, by Day Month', 'Note taker: send these notes to everyone who came']),
      heading(2, 'Next meeting'),
      para('Date, time and place.')
    ],
    { header: {}, footer: { default: [para(pageOfPages('Meeting Title · Page '), { textAlign: 'center' })] } }
  )
}
