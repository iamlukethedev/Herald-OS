import { atom } from 'nanostores'
import { type ReactNode, useMemo } from 'react'
import type { DocJSON } from '../../../../shared/office/document.ts'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { Modal } from '../shell/dialogs.tsx'
import { type DocumentStatistics, documentStatistics, durationLabel } from './statistics.ts'
import { activeEditor } from './store.ts'

/** Whether Tools > Word Count and Statistics… is open. */
export const $statistics = atom(false)

const whole = (value: number): string => value.toLocaleString()

const tenths = (value: number): string => value.toLocaleString(undefined, { maximumFractionDigits: 1 })

const ROWS: { label: string; value: (stats: DocumentStatistics) => ReactNode }[] = [
  { label: 'Words', value: (stats) => whole(stats.words) },
  { label: 'Characters', value: (stats) => whole(stats.characters) },
  { label: 'Characters without spaces', value: (stats) => whole(stats.charactersNoSpaces) },
  { label: 'Paragraphs', value: (stats) => whole(stats.paragraphs) },
  { label: 'Sentences', value: (stats) => whole(stats.sentences) },
  { label: 'Words per sentence', value: (stats) => (stats.sentences ? tenths(stats.wordsPerSentence) : '–') },
  { label: 'Reading time', value: (stats) => (stats.words ? durationLabel(stats.readingMinutes) : '–') },
  { label: 'Speaking time', value: (stats) => (stats.words ? durationLabel(stats.speakingMinutes) : '–') },
  {
    label: 'Reading ease',
    value: (stats) =>
      stats.readability ? (
        <>
          {Math.round(stats.readability.score)}
          <span className="block text-[11px] text-fg-3">{stats.readability.label}</span>
        </>
      ) : (
        '–'
      )
  },
  { label: 'Grade level', value: (stats) => (stats.readability ? tenths(stats.readability.grade) : '–') }
]

/** The figures of the document in front, and of the selection beside them when text is selected. */
export function StatisticsDialog() {
  const close = () => $statistics.set(false)
  const figures = useMemo(() => {
    const editor = activeEditor()

    if (!editor) {
      return null
    }

    const { selection } = editor.state
    const selected = selection.empty ? null : documentStatistics({ type: 'doc', content: selection.content().content.toJSON() ?? [] })

    return { all: documentStatistics(editor.state.doc.toJSON() as DocJSON), selected: selected?.characters ? selected : null }
  }, [])

  return (
    <Modal title="Word count and statistics" onClose={close}>
      {figures && (
        <table className="w-full text-[12.5px] tabular-nums">
          {figures.selected && (
            <thead>
              <tr className="text-[11.5px] text-fg-3">
                <th />
                <th className="pb-1.5 text-right font-medium">Selection</th>
                <th className="pb-1.5 pl-4 text-right font-medium">Document</th>
              </tr>
            </thead>
          )}
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="align-top">
                <td className="py-1 pr-4 text-fg-2">{row.label}</td>
                {figures.selected && <td className="selectable py-1 text-right text-fg">{row.value(figures.selected)}</td>}
                <td className="selectable py-1 pl-4 text-right text-fg">{row.value(figures.all)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-[11.5px] text-fg-3">Notes, comments, headers and footers are not counted. Reading ease is Flesch’s score from 0 (hard) to 100 (easy), and grade level the Flesch–Kincaid US school grade; both suit English text.</p>
      <div className="mt-5 flex justify-end">
        <GlassButton variant="primary" autoFocus onClick={close}>
          OK
        </GlassButton>
      </div>
    </Modal>
  )
}
