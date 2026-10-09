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
})
