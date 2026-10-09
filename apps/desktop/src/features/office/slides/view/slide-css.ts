/*
 * The style sheet a slide is drawn with, one copy for the editor, the slide list, presenting and
 * the print view (which runs no scripts, so everything a slide needs is here or inline). A slide is
 * laid out in points as CSS pixels and scaled as a whole, so text wraps the same at every size.
 */

export const SLIDE_CSS = `
.hs-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; overflow: hidden; contain: layout paint; background-size: cover; background-position: center; -webkit-font-smoothing: antialiased; }
.hs-el { position: absolute; box-sizing: border-box; }
.hs-geom { position: absolute; left: 0; top: 0; overflow: visible; }
.hs-picture { position: absolute; inset: 0; overflow: hidden; }
.hs-picture img { position: absolute; display: block; max-width: none; user-select: none; -webkit-user-drag: none; }
.hs-text { position: absolute; display: flex; flex-direction: column; justify-content: flex-start; box-sizing: border-box; }
.hs-text[data-anchor="middle"] { justify-content: center; }
.hs-text[data-anchor="bottom"] { justify-content: flex-end; }
.hs-flow { white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; outline: none; font-variant-ligatures: none; font-feature-settings: "liga" 0; font-kerning: normal; }
.hs-flow[data-wrap="false"] { white-space: pre; }
.hs-table { position: absolute; left: 0; top: 0; display: grid; isolation: isolate; }
.hs-cell { position: relative; display: flex; flex-direction: column; justify-content: flex-start; box-sizing: border-box; min-width: 0; }
.hs-side { position: absolute; box-sizing: content-box; z-index: 1; pointer-events: none; }
.hs-cell[data-anchor="middle"] { justify-content: center; }
.hs-cell[data-anchor="bottom"] { justify-content: flex-end; }
.hs-p { margin: 0; padding: 0; min-height: 0; }
.hs-p[data-marker]::before { content: attr(data-marker); display: inline-block; text-indent: 0; width: var(--hs-hang, auto); padding-right: var(--hs-gap, 0); box-sizing: border-box; white-space: nowrap; color: var(--hs-marker-color, inherit); font-size: var(--hs-marker-size, inherit); font-family: var(--hs-marker-font, inherit); font-weight: normal; font-style: normal; text-decoration: none; }
.hs-prompt { opacity: 0.45; }
.hs-stage .hs-el[data-element-id]:hover { outline: calc(1.5px / var(--hs-scale, 1)) solid rgba(47, 125, 255, 0.55); }
.hs-stage .hs-el[data-placeholder-empty] { outline: calc(1px / var(--hs-scale, 1)) dashed rgba(0, 0, 0, 0.3); }
.hs-empty-picture { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 1.5px dashed rgba(0, 0, 0, 0.28); border-radius: 4px; color: rgba(0, 0, 0, 0.45); font: 15px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: rgba(127, 127, 127, 0.08); }
.hs-kept { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 6px; overflow: hidden; box-sizing: border-box; border: 1px solid rgba(127, 127, 127, 0.4); border-radius: 4px; background: rgba(127, 127, 127, 0.07); color: rgba(110, 110, 110, 0.9); font: 13px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; text-align: center; }
.hs-kept-drawing { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.hs-flow.ProseMirror { position: relative; cursor: text; caret-color: currentColor; }
.hs-flow.ProseMirror [contenteditable="false"] { white-space: normal; }
.hs-flow.ProseMirror img.ProseMirror-separator { display: inline !important; border: none !important; margin: 0 !important; width: 0 !important; height: 0 !important; }
.ProseMirror-hideselection *::selection { background: transparent; }
.ProseMirror-hideselection { caret-color: transparent; }
@keyframes hs-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes hs-push-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
@keyframes hs-push-out { from { transform: translateX(0); } to { transform: translateX(-100%); } }
@keyframes hs-push-in-back { from { transform: translateX(-100%); } to { transform: translateX(0); } }
@keyframes hs-push-out-back { from { transform: translateX(0); } to { transform: translateX(100%); } }
`

let added = false

/** Put the slide style sheet on the page once. */
export function addSlideStyles(): void {
  if (added || typeof document === 'undefined') {
    return
  }

  added = true
  const style = document.createElement('style')
  style.dataset.heraldSlides = ''
  style.textContent = SLIDE_CSS
  document.head.append(style)
}
