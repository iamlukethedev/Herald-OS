import type { Deck, FooterRole, HeaderFooter, Slide } from '../deck.ts'
import { footersOf, headerFooterOf } from '../footers.ts'
import type { PlaceholderSlot } from './placeholders.ts'
import { bodyPropertiesXml, paragraphXml, runPropertiesXml, transformXml } from './write-drawingml.ts'
import { placeholderXml } from './write-tree.ts'
import { xml, type XmlElement } from './xml.ts'

/*
 * The date, footer and slide number: placeholders of PowerPoint's own kinds on the master, its
 * layouts and the slides that show them, the date and the number as the fields PowerPoint keeps up
 * to date (the date with the text of the day the file was written), in the place and look the
 * slide's layout or the master gives them.
 */

/** The fields' ids: PowerPoint gives a field the same id on every slide it is on. */
const FIELD_IDS: Partial<Record<FooterRole, string>> = { date: '{3C9A4F5E-8B21-4D6A-9E07-1F2B5C6D7E80}', number: '{7D5E2B1A-4C3F-4E8D-A6B9-0C1D2E3F4A5B}' }

export const FOOTER_NAMES: Record<FooterRole, string> = { date: 'Date Placeholder', footer: 'Footer Placeholder', number: 'Slide Number Placeholder' }

export const FOOTER_SIZES: Record<FooterRole, string> = { date: 'half', footer: 'quarter', number: 'quarter' }

/** What a footer role's paragraph holds: the slide number, or the date unless its text is fixed, as a field; else its text, if any. */
export function footerRuns(role: FooterRole, text: string, run: XmlElement, settings: HeaderFooter): XmlElement[] {
  const field = role === 'number' ? 'slidenum' : role === 'date' && !settings.dateText ? settings.dateFormat : undefined

  if (field) {
    return [xml('a:fld', { id: FIELD_IDS[role], type: field }, [run, xml('a:t', {}, [text])])]
  }

  return text ? [xml('a:r', {}, [run, xml('a:t', {}, [text])])] : [xml('a:endParaRPr', { lang: 'en-US' })]
}

/** The date, footer and slide number a slide shows, as placeholders of its layout's (`slots`), placed and styled as written out. */
export function footerShapes(deck: Deck, slide: Slide, index: number, slots: ReadonlyMap<string, PlaceholderSlot>, now: Date): XmlElement[] {
  const settings = headerFooterOf(deck)

  return footersOf(deck, slide, index, now).flatMap(({ role, place, text }, n) => {
    const slot = [...slots.values()].find((entry) => entry.role === role)

    if (!slot || (place.kind !== 'text' && place.kind !== 'shape')) {
      return []
    }

    const run = runPropertiesXml('a:rPr', place.body.style, { lang: 'en-US', dirty: '0' })

    return [
      xml('p:sp', {}, [
        xml('p:nvSpPr', {}, [xml('p:cNvPr', { id: '', name: `${FOOTER_NAMES[role]} ${n + 1}` }), xml('p:cNvSpPr', {}, [xml('a:spLocks', { noGrp: '1' })]), xml('p:nvPr', {}, [placeholderXml(slot, { size: FOOTER_SIZES[role] })])]),
        xml('p:spPr', {}, [transformXml(place)]),
        xml('p:txBody', {}, [bodyPropertiesXml(place.body), xml('a:lstStyle'), xml('a:p', {}, [paragraphXml(place.body.paragraphs[0] ?? { runs: [] }), ...footerRuns(role, text, run, settings)])])
      ])
    ]
  })
}
