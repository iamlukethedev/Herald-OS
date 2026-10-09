import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeraldOSPrefs, SystemInfo } from '../../../shared/ipc.ts'
import { $prefs } from '../../store/backend.ts'
import { $systemInfo } from '../../store/system.ts'
import { $commentName, $nameQuestion, accountName, answerCommentName, askCommentName, commentNameFor, HERMES_NAME, loadCommentName, NEUTRAL_NAME, setCommentName } from './comment-name.ts'

const ACCOUNT = { fullName: 'Pat Example', userName: 'pat' } as SystemInfo
const FIRST_PREFS = $prefs.get()

/** The question, once it shows. */
const asked = () => vi.waitUntil(() => $nameQuestion.get())

afterEach(() => {
  answerCommentName(null)
  $prefs.set(FIRST_PREFS)
  $commentName.set('')
  $systemInfo.set(null)
  vi.unstubAllGlobals()
})

describe('the name on the person’s comments', () => {
  it('is the one they confirmed, without asking', async () => {
    $systemInfo.set(ACCOUNT)
    $commentName.set('Sam Rivera')

    expect(await askCommentName('docs')).toBe('Sam Rivera')
    expect($nameQuestion.get()).toBeNull()
  })

  it('is asked for the first time, proposing the account’s name, which nothing uses before it is confirmed', async () => {
    $systemInfo.set(ACCOUNT)
    const answer = askCommentName('sheets')

    expect(await asked()).toEqual({ app: 'sheets', proposed: 'Pat Example' })
    expect($commentName.get()).toBe('')
    expect(commentNameFor('voice')).toBe(NEUTRAL_NAME)

    answerCommentName('  Sam   Rivera ')

    expect(await answer).toBe('Sam Rivera')
    expect($commentName.get()).toBe('Sam Rivera')
    expect($nameQuestion.get()).toBeNull()
    expect(await askCommentName('docs')).toBe('Sam Rivera')
    expect($nameQuestion.get()).toBeNull()
  })

  it('stays unconfirmed when the question is cancelled, and is asked again the next time', async () => {
    $systemInfo.set(ACCOUNT)
    const answer = askCommentName('docs')
    await asked()
    answerCommentName(null)

    expect(await answer).toBeNull()
    expect($commentName.get()).toBe('')
    expect(commentNameFor()).toBe(NEUTRAL_NAME)

    const again = askCommentName('docs')

    expect(await asked()).toMatchObject({ app: 'docs' })
    answerCommentName('Sam Rivera')
    expect(await again).toBe('Sam Rivera')
  })

  it('is asked once for every comment waiting, where the latest is written, and a name confirmed elsewhere answers it', async () => {
    const docs = askCommentName('docs')
    await asked()
    const sheets = askCommentName('sheets')

    expect($nameQuestion.get()?.app).toBe('sheets')

    $prefs.set({ ...$prefs.get(), commentName: 'Sam Rivera' })

    expect(await Promise.all([docs, sheets])).toEqual(['Sam Rivera', 'Sam Rivera'])
    expect($nameQuestion.get()).toBeNull()
  })

  it('is proposed from the account’s full name, else its user name', () => {
    expect(accountName(ACCOUNT)).toBe('Pat Example')
    expect(accountName({ ...ACCOUNT, fullName: '  ' })).toBe('Pat')
    expect(accountName(null)).toBe('')
  })
})

describe('the name on what commands add', () => {
  it('is the confirmed name, else the neutral one, never the account’s; Hermes signs as Hermes; nothing asks', () => {
    $systemInfo.set(ACCOUNT)

    expect(commentNameFor('palette')).toBe(NEUTRAL_NAME)
    expect(commentNameFor()).toBe(NEUTRAL_NAME)
    expect(commentNameFor('agent')).toBe(HERMES_NAME)

    $commentName.set('Sam Rivera')

    expect(commentNameFor('voice')).toBe('Sam Rivera')
    expect(commentNameFor('agent')).toBe(HERMES_NAME)
    expect($nameQuestion.get()).toBeNull()
  })
})

describe('the name in the prefs', () => {
  /** Main's prefs as the window's bridge reaches them, and the storage where Herald Docs kept its own name. */
  function main(saved: Partial<HeraldOSPrefs> = {}, docsName?: string) {
    let prefs: HeraldOSPrefs = { ...FIRST_PREFS, ...saved }
    const set = vi.fn(async (patch: Partial<HeraldOSPrefs>) => (prefs = { ...prefs, ...patch }))
    const stored = new Map(docsName === undefined ? [] : [['herald.docs.author', docsName]])
    vi.stubGlobal('window', { heraldOS: { prefs: { get: async () => prefs, set } } })
    vi.stubGlobal('document', { documentElement: { dataset: {}, style: { setProperty: () => {}, removeProperty: () => {} } } })
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, removeItem: (key: string) => stored.delete(key) })

    return { set, stored }
  }

  it('is kept there for every window, and cleared with an empty name', async () => {
    const { set } = main()
    await setCommentName(' Sam  Rivera ')

    expect(set).toHaveBeenLastCalledWith({ commentName: 'Sam Rivera' })
    expect($prefs.get().commentName).toBe('Sam Rivera')

    await setCommentName('')

    expect(set).toHaveBeenLastCalledWith({ commentName: '' })
    expect($commentName.get()).toBe('')
  })

  it('takes the one Herald Docs kept, once, when the prefs have none', async () => {
    const { set, stored } = main({}, 'Ann Example')

    expect(await loadCommentName()).toBe('Ann Example')
    expect(set).toHaveBeenCalledWith({ commentName: 'Ann Example' })
    expect($commentName.get()).toBe('Ann Example')
    expect(stored.has('herald.docs.author')).toBe(false)

    await setCommentName('')

    expect(await loadCommentName()).toBe('')
  })

  it('keeps the one the prefs have over the one Herald Docs kept, and forgets that one', async () => {
    const { set, stored } = main({ commentName: 'Sam Rivera' }, 'Ann Example')

    expect(await loadCommentName()).toBe('Sam Rivera')
    expect(set).not.toHaveBeenCalled()
    expect(stored.size).toBe(0)
  })

  it('is looked up there before asking, so a name confirmed in Docs before is not asked for in another app', async () => {
    main({}, 'Ann Example')

    expect(await askCommentName('sheets')).toBe('Ann Example')
    expect($nameQuestion.get()).toBeNull()

    $commentName.set('')
    main({ commentName: 'Sam Rivera' })

    expect(await askCommentName('docs')).toBe('Sam Rivera')
    expect($nameQuestion.get()).toBeNull()
  })
})
