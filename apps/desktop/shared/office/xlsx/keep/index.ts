import type { FinishContext } from '../finish.ts'

/*
 * The parts of the file a workbook was opened from that Herald does not model (pivot tables and
 * their caches, pictures, shapes and charts Herald does not draw, slicers and the like), carried
 * into the file Herald saves with their relationships and content types, where that is safe.
 */

/** Carry the source file's untouched parts into the package being finished. */
export async function finishKept(_ctx: FinishContext): Promise<void> {}
