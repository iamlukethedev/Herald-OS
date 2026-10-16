import { describe, expect, it } from 'vitest'
import { HEX_DIGITS, rollingDiff, rollingSlots } from './rolling.ts'

const changes = (previous: string | null, next: string) => rollingDiff(previous, next).map(slot => `${slot.char}:${slot.change}`)

describe('rolling slots', () => {
  it('keys digits by their place from the left and other characters by what and where', () => {
    expect(rollingSlots('1,234').map(slot => slot.key)).toEqual(['d0', 'o1:0:,', 'd1', 'd2', 'd3'])
    expect(rollingSlots('FF', HEX_DIGITS).map(slot => slot.digit)).toEqual([15, 15])
    expect(rollingSlots('Error').every(slot => slot.digit === null)).toBe(true)
  })

  it('keeps the digits a new value shares at the front still and rolls the rest', () => {
    expect(changes('1,234', '1,289')).toEqual(['1:still', ',:still', '2:still', '8:roll', '9:roll'])
    expect(changes('3', '87')).toEqual(['8:roll', '7:enter'])
  })

  it('brings in typed digits and moved separators', () => {
    expect(changes('12', '123')).toEqual(['1:still', '2:still', '3:enter'])
    expect(changes('1,234', '12,345')).toEqual(['1:still', '2:still', ',:enter', '3:still', '4:still', '5:enter'])
    expect(changes('\u22125', '5')).toEqual(['5:still'])
  })

  it('moves nothing on the first render', () => {
    expect(changes(null, '42')).toEqual(['4:still', '2:still'])
  })
})
