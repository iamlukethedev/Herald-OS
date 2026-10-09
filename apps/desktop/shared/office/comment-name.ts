/** The longest name Herald keeps for the person's comments. */
export const COMMENT_NAME_MAX = 80

/** A name for comments as Herald keeps it: one line, single spaces, at most COMMENT_NAME_MAX characters; empty when there is none. */
export function normalizeCommentName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, COMMENT_NAME_MAX).trim() : ''
}
