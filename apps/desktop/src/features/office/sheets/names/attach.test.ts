import { CommandType, ICommandService } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { newWorkbook } from '../../../../../shared/office/workbook.ts'
import { withHeadlessSheets } from '../headless.ts'
import { attachNames } from './attach.ts'
import { openNameManager } from './NameManager.tsx'

vi.mock('./NameManager.tsx', () => ({ openNameManager: vi.fn() }))

describe('the name box’s names', () => {
  it('opens Herald’s Name manager where Univer would open its own sidebar, until stopped', async () => {
    const { result } = await withHeadlessSheets(newWorkbook('book', 'Book'), async ({ univer }) => {
      const commands = univer.__getInjector().get(ICommandService)
      const ran: string[] = []
      commands.registerCommand({ id: 'sidebar.operation.defined-name', type: CommandType.COMMAND, handler: (_accessor, params?: { value?: string }) => Boolean(ran.push(params?.value ?? '')) })
      const stop = attachNames({ univer }, 'doc-1')
      const opened = await commands.executeCommand('sidebar.operation.defined-name', { value: 'open' })
      const closed = await commands.executeCommand('sidebar.operation.defined-name', { value: 'close' })
      stop()
      const after = await commands.executeCommand('sidebar.operation.defined-name', { value: 'open' })

      return { opened, closed, after, ran }
    })

    expect(openNameManager).toHaveBeenCalledTimes(1)
    expect(openNameManager).toHaveBeenCalledWith('doc-1')
    expect(result).toEqual({ opened: false, closed: true, after: true, ran: ['close', 'open'] })
  })
})
