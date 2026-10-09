import { describe, expect, it } from 'vitest'
import { countWords, type DocJSON, type DocNode } from '../../../../shared/office/document.ts'
import { docsSchema } from './schema.ts'
import { countSentences, countSyllables, documentStatistics, durationLabel, readabilityLabel, readabilityOf } from './statistics.ts'

const p = (text: string): DocNode => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })

const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', content })

const prose = (text: string): DocJSON => doc(...text.split('\n').map(p))

describe('counting syllables', () => {
  it.each([
    ['cat', 1],
    ['the', 1],
    ['strengths', 1],
    ['make', 1],
    ['makes', 1],
    ['whole', 1],
    ['jumped', 1],
    ['played', 1],
    ['year', 1],
    ['queue', 1],
    ['table', 2],
    ['tables', 2],
    ['people', 2],
    ['wanted', 2],
    ['boxes', 2],
    ['pages', 2],
    ['player', 2],
    ['beyond', 2],
    ['nation', 2],
    ['social', 2],
    ['statement', 2],
    ['lonely', 2],
    ['didn’t', 2],
    ['document', 3],
    ['radio', 3],
    ['curious', 3],
    ['delicious', 3],
    ['medium', 3],
    ['actual', 3],
    ['video', 3],
    ['beautiful', 3],
    ['completely', 3],
    ['tourism', 3],
    ['readability', 5],
    ['implementation', 5],
    ['Église', 2],
    ['2026', 1],
    ['—', 0]
  ])('%s has %i', (word, syllables) => {
    expect(countSyllables(word)).toBe(syllables)
  })
})

describe('counting sentences', () => {
  it('ends one at a full stop, a question mark, an exclamation mark or an ellipsis, closing quotes and all', () => {
    expect(countSentences('It rained. Did it? Yes! Then it stopped…')).toBe(4)
    expect(countSentences('She said “Go home.” He went.')).toBe(2)
  })

  it('does not end one at a title, an initial, an abbreviation before a number, a decimal or a stop before lower case', () => {
    expect(countSentences('Mr. Smith met Dr. Jones at 3.30 p.m. on Friday.')).toBe(1)
    expect(countSentences('J. R. Example wrote it, e.g. in No. 5 and on pp. 10 to 12.')).toBe(1)
    expect(countSentences('Wait… what happened?')).toBe(1)
  })

  it('counts words after the last stop, as a heading or a list item has them, and nothing in an empty block', () => {
    expect(countSentences('Getting started')).toBe(1)
    expect(countSentences('One. Two')).toBe(2)
    expect(countSentences('  ')).toBe(0)
    expect(countSentences('…')).toBe(0)
  })
})

describe('readability', () => {
  it('names the bands of Flesch’s reading ease', () => {
    expect([95, 85, 75, 65, 55, 40, 10].map(readabilityLabel)).toEqual(['Very easy', 'Easy', 'Fairly easy', 'Plain English', 'Fairly difficult', 'Difficult', 'Very difficult'])
    expect(readabilityLabel(90)).toBe('Very easy')
    expect(readabilityLabel(89.9)).toBe('Easy')
  })

  it('works out reading ease and grade from words, sentences and syllables, kept in range', () => {
    // 100 words in 5 sentences with 150 syllables: 206.835 - 1.015 * 20 - 84.6 * 1.5 = 59.6; 0.39 * 20 + 11.8 * 1.5 - 15.59 = 9.9.
    expect(readabilityOf(100, 5, 150)).toEqual({ score: 59.6, label: 'Fairly difficult', grade: 9.9 })
    expect(readabilityOf(12, 4, 12)).toMatchObject({ score: 100, grade: 0 })
    expect(readabilityOf(10, 1, 50)).toMatchObject({ score: 0, label: 'Very difficult' })
    expect(readabilityOf(0, 0, 0)).toBeNull()
  })

  it('finds a children’s text very easy and a dense academic one very difficult', () => {
    const easy = documentStatistics(prose('The cat sat on the mat. The dog ran to the cat. It was fun.'))
    const plain = documentStatistics(prose('You can keep a document as a template. Choose Save as Template in the File menu and give it a name. It is there in the gallery the next time you start a new document.'))
    const hard = documentStatistics(prose('The epistemological ramifications of quantitative methodologies necessitate considerable interdisciplinary deliberation regarding institutional accountability.'))

    expect(easy.readability).toMatchObject({ score: 100, label: 'Very easy', grade: 0 })
    expect(plain.readability!.score).toBeGreaterThan(70)
    expect(plain.readability!.score).toBeLessThan(95)
    expect(plain.readability!.grade).toBeGreaterThan(2)
    expect(plain.readability!.grade).toBeLessThan(8)
    expect(hard.readability).toMatchObject({ score: 0, label: 'Very difficult' })
    expect(hard.readability!.grade).toBeGreaterThan(16)
  })
})

describe('documentStatistics', () => {
  it('counts words as the status bar does, characters with and without spaces, paragraphs and sentences', () => {
    const stats = documentStatistics(prose('Herald Docs counts words.\n\nIt counts what is on the page:\ttabs, too. Isn’t that well-known?'))

    expect(stats).toMatchObject({ words: 16, paragraphs: 2, sentences: 3, wordsPerSentence: 5.3 })
    expect(stats.words).toBe(countWords('Herald Docs counts words.\n\nIt counts what is on the page:\ttabs, too. Isn’t that well-known?'))
    expect(stats.characters).toBe(25 + 64)
    expect(stats.charactersNoSpaces).toBe(stats.characters - 14)
  })

  it('reads the body only: not notes, comments, headers, footers or a table of contents, but text boxes and tables', () => {
    const note: DocNode = { type: 'note', attrs: { kind: 'footnote', content: [p('A note with five words.')] } }
    const commented: DocNode = { type: 'text', text: 'Reviewed text', marks: [{ type: 'comment', attrs: { id: 'c1' } }] }
    const box: DocNode = { type: 'textBox', attrs: { width: null, height: null, align: null, border: null, fill: null }, content: [p('Boxed words here.')] }
    const table: DocNode = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('Cell one.')] }, { type: 'tableCell', content: [p('Cell two.')] }] }] }
    const document: DocJSON = {
      type: 'doc',
      attrs: { headers: { header: { default: [p('Header words should not count')] }, footer: {} }, comments: [{ id: 'c1', author: 'Ann Example', date: null, text: 'Comment words should not count' }] },
      content: [{ type: 'tableOfContents', attrs: { levels: 3, title: 'Contents', pages: null } }, { type: 'paragraph', content: [commented, { type: 'text', text: ' stays.' }, note] }, box, table, { type: 'paragraph', content: [{ type: 'text', text: 'Page ' }, { type: 'field', attrs: { kind: 'page', format: null, instruction: null, text: '3' } }] }]
    }

    expect(() => docsSchema().nodeFromJSON(document).check()).not.toThrow()
    expect(documentStatistics(document)).toMatchObject({ words: 11, paragraphs: 5, sentences: 5 })
  })

  it('counts code as words and characters but leaves it out of sentences and readability', () => {
    const stats = documentStatistics(doc(p('Run this.'), { type: 'codeBlock', content: [{ type: 'text', text: 'npm run build && npm test' }] }))

    expect(stats).toMatchObject({ words: 7, sentences: 1, wordsPerSentence: 2, paragraphs: 2 })
    expect(stats.syllables).toBe(2)
  })

  it('gives reading and speaking times, and the page count when there is one', () => {
    const stats = documentStatistics(prose(Array.from({ length: 476 }, () => 'word').join(' ')), { pages: 2 })

    expect(stats).toMatchObject({ words: 476, readingMinutes: 2, speakingMinutes: 3.4, pages: 2 })
    expect(documentStatistics(prose('One.'), { pages: null })).not.toHaveProperty('pages')
    expect(documentStatistics(prose('One.'), { pages: Number.NaN })).not.toHaveProperty('pages')
  })

  it('has nothing to score in an empty document', () => {
    expect(documentStatistics(doc(p('')))).toEqual({ words: 0, characters: 0, charactersNoSpaces: 0, paragraphs: 0, sentences: 0, wordsPerSentence: 0, syllables: 0, readingMinutes: 0, speakingMinutes: 0, readability: null })
  })
})

describe('durationLabel', () => {
  it('says a time in minutes as people say it', () => {
    expect(durationLabel(0.4)).toBe('Under a minute')
    expect(durationLabel(1.2)).toBe('About 1 minute')
    expect(durationLabel(7.6)).toBe('About 8 minutes')
    expect(durationLabel(60.2)).toBe('About 1 hour')
    expect(durationLabel(125)).toBe('About 2 hours 5 minutes')
  })
})
