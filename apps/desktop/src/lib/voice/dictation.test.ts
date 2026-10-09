import { describe, expect, it } from 'vitest'
import { applySpokenPunctuation, dictationRemainder, matchDictation, parseDictationText, withLeadingSpace } from './dictation.ts'

describe('dictation', () => {
  it('recognises type/dictate and keeps the exact words', () => {
    expect(dictationRemainder('type how hi are you?')).toBe('how hi are you?')
    expect(dictationRemainder('Type: Hello World')).toBe('Hello World')
    expect(dictationRemainder('dictate the text meeting at 3')).toBe('meeting at 3')
    expect(dictationRemainder('open the terminal')).toBeNull()
  })

  it('drops the transcriber full stop but keeps real punctuation', () => {
    expect(matchDictation('type how hi are you?')).toEqual({ text: 'how hi are you?', submit: false })
    expect(matchDictation('Type hello there.')).toEqual({ text: 'hello there', submit: false })
    expect(matchDictation('type wow!')).toEqual({ text: 'wow!', submit: false })
  })

  it('understands "and press enter" / "and send it"', () => {
    expect(matchDictation('type ls -la and press enter')).toEqual({ text: 'ls -la', submit: true })
    expect(parseDictationText('good morning team, and send it.')).toEqual({ text: 'good morning team', submit: true })
  })

  it('turns spoken punctuation into characters', () => {
    expect(applySpokenPunctuation('hi there comma how are you question mark')).toBe('hi there, how are you?')
    expect(applySpokenPunctuation('line one new line line two')).toBe('line one\nline two')
  })

  it('lets a spoken mark take the place of the same mark the transcriber wrote beside it', () => {
    expect(applySpokenPunctuation('Hello comma, world')).toBe('Hello, world')
    expect(applySpokenPunctuation('Hello, comma world')).toBe('Hello, world')
    expect(applySpokenPunctuation('Hello, comma, world')).toBe('Hello, world')
    expect(applySpokenPunctuation('The end period. Next')).toBe('The end. Next')
    expect(applySpokenPunctuation('The end. Full stop. Next')).toBe('The end. Next')
    expect(applySpokenPunctuation('Is it ready question mark? Yes')).toBe('Is it ready? Yes')
    expect(applySpokenPunctuation('Is it ready? question mark')).toBe('Is it ready?')
    expect(applySpokenPunctuation('Wow exclamation mark! Great')).toBe('Wow! Great')
    expect(applySpokenPunctuation('Wow! Exclamation point')).toBe('Wow!')
    expect(applySpokenPunctuation('Dear Sam colon: thanks')).toBe('Dear Sam: thanks')
    expect(applySpokenPunctuation('Milk; semicolon eggs')).toBe('Milk; eggs')
  })

  it('keeps a mark said twice, other marks beside a spoken one, ellipses and words that only contain a mark', () => {
    expect(applySpokenPunctuation('Hello comma comma world')).toBe('Hello,, world')
    expect(applySpokenPunctuation('Wait... comma then')).toBe('Wait..., then')
    expect(applySpokenPunctuation('Wait... what')).toBe('Wait... what')
    expect(applySpokenPunctuation('Use commas, said the commander')).toBe('Use commas, said the commander')
    expect(applySpokenPunctuation('A periodic colonel')).toBe('A periodic colonel')
  })

  it('keeps a period said at the end and drops only the transcriber one', () => {
    expect(parseDictationText('Hello period.')).toEqual({ text: 'Hello.', submit: false })
    expect(parseDictationText('Hello comma.')).toEqual({ text: 'Hello,', submit: false })
    expect(parseDictationText('Hello comma, world.')).toEqual({ text: 'Hello, world', submit: false })
    expect(parseDictationText('To be continued...')).toEqual({ text: 'To be continued...', submit: false })
  })

  it('adds the space between dictations only after a word', () => {
    expect(withLeadingSpace('d', 'and then')).toBe(' and then')
    expect(withLeadingSpace('.', '42 people')).toBe(' 42 people')
    expect(withLeadingSpace('o', '"quoted"')).toBe(' "quoted"')
    expect(withLeadingSpace(' ', 'and then')).toBe('and then')
    expect(withLeadingSpace('\n', 'and then')).toBe('and then')
    expect(withLeadingSpace('', 'and then')).toBe('and then')
    expect(withLeadingSpace(null, 'and then')).toBe('and then')
    expect(withLeadingSpace('d', ', and then')).toBe(', and then')
  })

  it('does not repeat the mark the caret follows already', () => {
    expect(withLeadingSpace(',', ', world')).toBe(' world')
    expect(withLeadingSpace(',', ',world')).toBe(' world')
    expect(withLeadingSpace(',', ',')).toBe('')
    expect(withLeadingSpace('.', '. Next')).toBe(' Next')
    expect(withLeadingSpace('?', '?')).toBe('')
    expect(withLeadingSpace('!', '! Wow')).toBe(' Wow')
    expect(withLeadingSpace(':', ': two')).toBe(' two')
    expect(withLeadingSpace(';', ';')).toBe('')
    expect(withLeadingSpace('.', '..')).toBe('..')
    expect(withLeadingSpace('.', ', and')).toBe(', and')
  })
})
