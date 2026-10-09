/** A rule's input message beside the selected cell, as Univer's popups draw a component: with what was attached in `extraProps`. */
export function InputMessage({ popup }: { popup: { extraProps?: { title?: string; message?: string } } }) {
  const { title, message } = popup.extraProps ?? {}

  return (
    <div role="tooltip" className="float menu-surface pointer-events-none max-w-64 rounded-lg px-2.5 py-2 text-[12px] leading-snug">
      {title && <div className="font-medium text-fg">{title}</div>}
      {message && <div className="whitespace-pre-wrap text-fg-2">{message}</div>}
    </div>
  )
}
