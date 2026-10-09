import type { CommandArg, CommandContext, OsCommand } from '../store/os-commands.ts'

/* What Herald Sheets' commands share: the workbook, sheet and range they take, and where they run. */

const office = () => import('../features/office/agent.ts')

export const workbook: CommandArg = { name: 'workbook', type: 'string', description: 'The workbook: a file (full path or ~/…) or the name of an open workbook as its tab shows it; the one in front in Herald Sheets when left out' }
export const sheet: CommandArg = { name: 'sheet', type: 'string', description: 'The sheet, when the range does not name it; the one in front when left out' }
export const range = (what: string, required = false): CommandArg => ({ name: 'range', type: 'string', description: `${what}: cells like B2, B2:D9, C:C or 'Q1 sales'!A1:F20, or selection for what is selected`, ...(required ? { required } : {}) })

/** Run where the workbook lives: here, or in its own window (panels mode). */
export const run =
  (id: string, work: (args: Record<string, unknown>, context: CommandContext) => Promise<{ summary: string; data?: Record<string, unknown> }>): OsCommand['run'] =>
  async (args, context) =>
    (await office()).inOwnWindow('sheets', id, args, 'workbook', context, () => work(args, context))
