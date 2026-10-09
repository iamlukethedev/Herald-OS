import { atom } from 'nanostores'
import type { SystemInfo } from '../../../shared/ipc.ts'
import { normalizeCommentName } from '../../../shared/office/comment-name.ts'
import type { OfficeApp } from '../../../shared/office/files.ts'
import { $prefs, updatePrefs } from '../../store/backend.ts'
import type { CommandSource } from '../../store/os-commands.ts'
import { $systemInfo } from '../../store/system.ts'

/*
 * The name on the comments, replies and notes the person adds in Herald Docs, Sheets and Slides,
 * the same in every Office window: theirs once they confirmed it (it is kept in the prefs), asked
 * for the first time they add one, in a question that proposes the account's name. Nothing uses
 * the account's name before they confirm it, and a cancelled question adds nothing: each app
 * leaves the comment unposted where it was written. Hermes signs its own comments; a command (the
 * command bar, voice) signs with the confirmed name or a neutral one, and never asks.
 */

/** The name on comments a command adds before the person confirmed theirs. */
export const NEUTRAL_NAME = 'Herald user'

export const HERMES_NAME = 'Hermes'

/** Where Herald Docs kept the name before the Office apps shared one. */
const DOCS_NAME_KEY = 'herald.docs.author'

/** The name the person confirmed for their comments; empty until they do. */
export const $commentName = atom(normalizeCommentName($prefs.get().commentName))

$prefs.listen((prefs) => $commentName.set(normalizeCommentName(prefs.commentName)))

export interface NameQuestion {
  /** The Office app whose window asks. */
  app: OfficeApp
  /** What the name starts as: the account's name, when the system gives it. */
  proposed: string
}

/** The question an Office window shows while a comment waits for the person's name. */
export const $nameQuestion = atom<NameQuestion | null>(null)

let waiting: ((name: string | null) => void) | null = null
let asking: Promise<string | null> | null = null

function settle(name: string | null): void {
  $nameQuestion.set(null)
  waiting?.(name)
  waiting = null
}

// A name confirmed in another window, or in Settings, answers the question open here.
$commentName.listen((name) => {
  if (name && waiting) {
    settle(name)
  }
})

const prefsBridge = () => (typeof window === 'undefined' ? undefined : window.heraldOS?.prefs)

function docsName(): string {
  try {
    return normalizeCommentName(globalThis.localStorage?.getItem(DOCS_NAME_KEY))
  } catch {
    return ''
  }
}

function forgetDocsName(): void {
  try {
    globalThis.localStorage?.removeItem(DOCS_NAME_KEY)
  } catch {
    // Storage may be unavailable; there is no name of Docs' own to move then.
  }
}

/** The account's full name, or its user name: what the question proposes, and nothing more. */
export function accountName(info: SystemInfo | null = $systemInfo.get()): string {
  const user = normalizeCommentName(info?.userName)

  return normalizeCommentName(info?.fullName) || user.charAt(0).toUpperCase() + user.slice(1)
}

/** Confirm or change the person's name in every Office window; an empty one clears it, and their next comment asks again. */
export async function setCommentName(name: string): Promise<void> {
  const value = normalizeCommentName(name)
  $commentName.set(value)

  if (prefsBridge()) {
    await updatePrefs({ commentName: value })
  }
}

/** The name on a comment a command adds: Hermes's for Hermes, else the confirmed name or the neutral one. It never asks. */
export const commentNameFor = (source?: CommandSource): string => (source === 'agent' ? HERMES_NAME : $commentName.get() || NEUTRAL_NAME)

/**
 * The confirmed name as the prefs file has it (a window's copy may not have arrived yet), after
 * moving Herald Docs' own name into it, once, when it has none: the person confirmed that one in
 * Docs' comments. Empty when there is none.
 */
export async function loadCommentName(): Promise<string> {
  const bridge = prefsBridge()

  if (!bridge) {
    return $commentName.get()
  }

  const saved = normalizeCommentName((await bridge.get()).commentName)
  const kept = docsName()

  if (saved) {
    $commentName.set(saved)
  } else if (kept) {
    await setCommentName(kept)
  }

  forgetDocsName()

  return saved || kept
}

/**
 * The name for a comment the person adds in `app`: the confirmed one, or, the first time, the one
 * they give in the question that app's window shows. Null when they cancel; the comment is not
 * added then.
 */
export function askCommentName(app: OfficeApp): Promise<string | null> {
  const name = $commentName.get()

  if (name) {
    return Promise.resolve(name)
  }

  // One question answers every comment waiting for it; it shows where the latest one is written.
  if ($nameQuestion.get()) {
    $nameQuestion.set({ app, proposed: accountName() })
  }

  asking ??= loadCommentName()
    .catch(() => '')
    .then((found) => found || question(app))
    .finally(() => {
      asking = null
    })

  return asking
}

/** Show the question in `app`'s window, until the person answers it. */
function question(app: OfficeApp): Promise<string | null> {
  return new Promise((resolve) => {
    waiting = resolve
    $nameQuestion.set({ app, proposed: accountName() })
  })
}

/** The person's answer to the question: the name they confirm, or null when they cancel. */
export function answerCommentName(name: string | null): void {
  const value = normalizeCommentName(name)
  settle(value || null)

  if (value) {
    // The name holds in this window even when it could not be saved.
    void setCommentName(value).catch(() => {})
  }
}
