import { isPanels } from '../../store/shell.ts'
import { openApp } from '../../store/windows.ts'
import type { CalcRequest } from './requests.ts'
import { $calcRequest } from './store.ts'

/** Show Herald Calc, on a view, a new note, a graph or a history search when asked. */
export function openCalc(request: Omit<CalcRequest, 'at'> = {}): void {
  const full: CalcRequest = { ...request, at: Date.now() }

  // Panels mode runs Calc in its own window process: the request goes over as its payload.
  openApp('calc', { payload: { ...full } })

  if (!isPanels) {
    $calcRequest.set(full)
  }
}
