import { type FormEvent, useEffect, useState } from 'react'
import { GlassButton } from '../../../../components/ui/glass.tsx'
import { messageOf } from '../../../canvas/errors.ts'
import { Modal } from '../../shell/dialogs.tsx'
import { $saveTemplate, docsSession } from '../store.ts'
import { type SavedTemplate, savedTemplates, saveTemplate } from './saved.ts'

const withoutExtension = (name: string): string => name.replace(/\.[a-z0-9]{1,5}$/i, '')

/** Keep the document in front as a template, under a name: it is in File > New from then on. */
export function SaveTemplateDialog() {
  const doc = docsSession.active()
  const [name, setName] = useState(() => withoutExtension(doc?.name ?? ''))
  const [existing, setExisting] = useState<SavedTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const clash = existing.find((template) => template.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())
  const close = () => $saveTemplate.set(false)

  useEffect(() => {
    void savedTemplates()
      .then(setExisting)
      .catch(() => {})
  }, [])

  const save = async (event: FormEvent) => {
    event.preventDefault()

    if (!doc || !name.trim() || busy) {
      return
    }

    setBusy(true)

    try {
      await doc.editor?.settle?.()
      const saved = await saveTemplate(name, doc.editor?.snapshot() ?? doc.initial, clash?.id)
      docsSession.notify(`Saved “${saved.name}” as a template. New documents can start from it.`)
      close()
    } catch (error) {
      docsSession.notify(`Could not save the template: ${messageOf(error)}`, 'error')
      setBusy(false)
    }
  }

  return (
    <Modal title="Save as template" onClose={close}>
      <form onSubmit={(event) => void save(event)}>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Name
          <input autoFocus value={name} maxLength={120} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} className="glass-input h-8 w-full rounded-lg px-2 text-[13px] text-fg outline-none" />
        </label>
        <p className="mt-2 text-[11.5px] text-fg-3">{clash ? `This replaces your template “${clash.name}”.` : 'It will be in File > New, under Your templates.'}</p>
        <div className="mt-5 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={close}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" type="submit" disabled={busy || !doc || !name.trim()}>
            {clash ? 'Replace' : 'Save'}
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}
