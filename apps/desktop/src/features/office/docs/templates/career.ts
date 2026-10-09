import type { DocJSON, StyleLook } from '../../../../../shared/office/document.ts'
import { bold, bullets, field, heading, lines, para, paper, rule, run, type RunLook, subtitle, type TemplateContext, templateDocument, title } from './build.ts'

/* A CV and the cover letter that goes with it, in one look: Calibri with a teal accent. */

const TEAL = '#1A6B66'
const INK = '#1F2328'
const MUTED = '#5F6B73'

const CONTACT = 'Town, County · Phone Number · name@example.com · portfolio.example.com'

const NAME: StyleLook = { font: 'Calibri', size: 28, bold: true, color: TEAL, spaceBefore: 0 }

/** A one-page letter to send with a job application. */
export function coverLetter({ paper: size, dateFormat }: TemplateContext): DocJSON {
  return templateDocument(
    paper(size, 72),
    {
      normal: { font: 'Calibri', size: 11, color: INK, lineHeight: 1.2, spaceBefore: 0, spaceAfter: 10 },
      title: { ...NAME, spaceAfter: 2 }
    },
    [
      title('Your Name'),
      para(run(CONTACT, { size: 9.5, color: MUTED }), { spaceAfter: 30 }),
      para(field('date', dateFormat), { spaceAfter: 18 }),
      para(lines('Hiring Manager Name', 'Job Title', 'Company Name', 'Street Address', 'Town and Postcode'), { spaceAfter: 18 }),
      para(bold('Application for Job Title')),
      para('Dear Hiring Manager Name,'),
      para('Say which role you are applying for and where you saw it, then give the main reason you are a strong fit. Two or three sentences are enough.'),
      para('In the middle, connect your experience to what the job asks for. Pick two or three achievements and give each a result: a number, a deadline met or a problem solved.'),
      para('Show that you know the organisation: what draws you to its work, and what you would bring to the team in your first months.'),
      para('Thank the reader, say you would welcome the chance to talk, and mention when you are available.'),
      para('Kind regards,', { spaceBefore: 8, spaceAfter: 40 }),
      para(bold('Your Name'))
    ]
  )
}

/** A CV: profile, experience, education and skills, with the name and page numbers at the foot of each page. */
export function cv({ paper: size }: TemplateContext): DocJSON {
  const small: RunLook = { size: 8.5, color: MUTED }
  const dates = (text: string) => para(run(text, { italic: true, color: MUTED }), { spaceAfter: 3 })

  return templateDocument(
    paper(size, 54, 28),
    {
      normal: { font: 'Calibri', size: 10.5, color: INK, lineHeight: 1.15, spaceBefore: 0, spaceAfter: 4 },
      title: { ...NAME, spaceAfter: 0 },
      subtitle: { font: 'Calibri', size: 13, color: '#4A5560', spaceBefore: 0, spaceAfter: 4 },
      heading1: { font: 'Calibri', size: 12, bold: true, color: TEAL, spaceBefore: 16, spaceAfter: 4 },
      heading2: { font: 'Calibri', size: 11, bold: true, color: INK, spaceBefore: 8, spaceAfter: 0 }
    },
    [
      title('Your Name'),
      subtitle('Job Title or Profession'),
      para(run(CONTACT, { size: 9.5, color: MUTED }), { spaceAfter: 2 }),
      rule(),
      heading(1, 'Profile'),
      para('Two or three sentences on who you are at work, what you do best and what you are looking for next. Tailor them to each role you apply for.'),
      heading(1, 'Experience'),
      heading(2, 'Job Title, Company Name'),
      dates('Month Year – Present · Town'),
      bullets(['Start each point with a verb: led, built, improved, cut, launched.', 'Give results where you can, such as “Cut the time it takes to process an order by a third”.', 'Keep to the three to five points that matter most for the job you want.']),
      heading(2, 'Previous Job Title, Company Name'),
      dates('Month Year – Month Year · Town'),
      bullets(['A responsibility or achievement that shows the skills the new role needs.', 'Another result, with a number if you have one.']),
      heading(1, 'Education'),
      heading(2, 'Qualification, Institution Name'),
      dates('Year – Year'),
      para('A line on results, a project or anything else that matters for the job.'),
      heading(1, 'Skills'),
      bullets([
        [bold('Tools: '), 'the software, equipment or methods you use well'],
        [bold('Languages: '), 'Language (fluent), Language (conversational)'],
        [bold('Other: '), 'certificates, licences or memberships']
      ]),
      heading(1, 'Interests'),
      para('A line on interests that say something about you, if there is room.')
    ],
    { header: {}, footer: { default: [para([run('Your Name · Page ', small), field('page', null, small), run(' of ', small), field('pages', null, small)], { textAlign: 'right' })] } }
  )
}
