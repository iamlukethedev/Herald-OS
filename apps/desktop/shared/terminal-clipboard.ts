/*
 * What the Terminal lets through its clipboard. Main and the renderer both apply the size limit:
 * main so a huge clipboard never crosses IPC, the renderer for text a native paste event carries.
 */

/** The most text, in UTF-8 bytes, the Terminal pastes or copies at once. */
export const TERMINAL_CLIPBOARD_LIMIT = 1024 * 1024

/** Whether `text` is more than the Terminal pastes or copies at once. */
export function overClipboardLimit(text: string, limit = TERMINAL_CLIPBOARD_LIMIT): boolean {
  // UTF-8 never takes fewer bytes than UTF-16 takes code units, so a long string is over without encoding it.
  return text.length > limit || new TextEncoder().encode(text).length > limit
}

/**
 * Pasted text without the control characters a terminal acts on. The bracketed-paste markers
 * (ESC[200~ and ESC[201~, or with the 8-bit CSI) go whole, so none can end a paste early and run
 * what follows, nor leave part of itself behind; then ESC, the other C0 controls but tab, line
 * feed and carriage return, DEL and the C1 controls. Takes one paste whole: a marker split across
 * two pastes is harmless, since each half loses its ESC or CSI on its own.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/(?:\x1b\[|\x9b)20[01]~/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
}
