import { FileChild, type IRunOptions, NextAttributeComponent, TextRun, type XmlComponent } from 'docx'

/*
 * WordprocessingML the docx package has no class for, made from its own building blocks: any
 * element as Word writes it, text that stays text, complex fields with their last result, and
 * note references.
 */

type Value = string | number | undefined

/** An element with its attributes as written and its children; a FileChild, so a section can hold it. */
export class Element extends FileChild {
  constructor(name: string, attributes: Readonly<Record<string, Value>> = {}, children: readonly (XmlComponent | string)[] = []) {
    super(name)
    const written = Object.entries(attributes).filter((entry): entry is [string, string | number] => entry[1] !== undefined)

    if (written.length) {
      this.root.push(new NextAttributeComponent(Object.fromEntries(written.map(([key, value]) => [key, { key, value }]))))
    }

    for (const item of children) {
      this.root.push(item)
    }
  }
}

/** Text as it is: the docx package writes a run's text "CURRENT" or "SECTION" as a field. */
export const text = (value: string): Element => new Element('w:t', { 'xml:space': 'preserve' }, [value])

export const textRun = (value: string, options: IRunOptions = {}): TextRun => new TextRun({ ...options, children: [text(value)] })

const fieldChar = (type: 'begin' | 'separate' | 'end', dirty = false): Element => new Element('w:fldChar', { 'w:fldCharType': type, 'w:dirty': dirty ? 'true' : undefined })

/** The runs that start a complex field, up to its result; a dirty field is worked out again when Word opens the file. */
export const fieldStart = (instruction: string, options: IRunOptions = {}, dirty = false): TextRun[] => [
  new TextRun({ ...options, children: [fieldChar('begin', dirty)] }),
  new TextRun({ ...options, children: [new Element('w:instrText', { 'xml:space': 'preserve' }, [` ${instruction} `])] }),
  new TextRun({ ...options, children: [fieldChar('separate')] })
]

export const fieldEnd = (options: IRunOptions = {}): TextRun => new TextRun({ ...options, children: [fieldChar('end')] })

/** A complex field with its last result, which Word shows until it updates the field; with none, Word works one out. */
export function fieldRuns(instruction: string, result: string | null, options: IRunOptions = {}): TextRun[] {
  if (result === null) {
    const [begin, code] = fieldStart(instruction, options)

    return [begin, code, fieldEnd(options)]
  }

  return [...fieldStart(instruction, options), ...result.split('\t').flatMap((part, index) => [...(index ? [new TextRun({ ...options, children: [new Element('w:tab')] })] : []), ...(part ? [textRun(part, options)] : [])]), fieldEnd(options)]
}

/** The mark of a footnote or endnote in the text. */
export const noteReference = (kind: 'footnote' | 'endnote', id: number): TextRun =>
  new TextRun({ style: kind === 'footnote' ? 'FootnoteReference' : 'EndnoteReference', children: [new Element(kind === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference', { 'w:id': id })] })
