import type { ProfileRow } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { botByProfile, botFromRow, findBot, HERMES_BOT, profileParam, rosterFrom, sameProfile, sessionKey } from './bots.ts'

const row = (name: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({ name, path: `/home/me/.hermes/profiles/${name}`, ...extra })
const titled = (title: string) => ({ ui_meta: { 'hermes-bots': { title, color: '#8b5cf6' } } })
const hermes = row('default', { path: '/home/me/.hermes', is_default: true })

describe('bots from the gateway roster', () => {
  it('go by their Bot Mode title, else their display name, else their profile', () => {
    expect(botFromRow(row('alfred', titled('Alfred Pennyworth'))).name).toBe('Alfred Pennyworth')
    expect(botFromRow(row('mark', { display_name: 'Mark', ...titled('  ') })).name).toBe('Mark')
    expect(botFromRow(row('inbox-triage')).name).toBe('Inbox Triage')
  })

  it('call the default profile Hermes unless Bot Mode titled it', () => {
    expect(botFromRow(hermes)).toEqual(HERMES_BOT)
    expect(botFromRow({ ...hermes, ...titled('Jarvis') })).toMatchObject({ profile: 'default', name: 'Jarvis' })
  })

  it('say what a bot is for without the title Bot Mode writes in front of it', () => {
    expect(botFromRow(row('mark', { description: 'Mark — Backend', ...titled('Mark') })).description).toBe('Backend')
    expect(botFromRow(row('sally', { description: 'Sally', ...titled('Sally') })).description).toBe('')
    expect(botFromRow(row('notes', { description: 'Keeps my notes tidy' })).description).toBe('Keeps my notes tidy')
  })

  it('know which bots the gateway has a picture of', () => {
    expect(botFromRow(row('alfred', { has_avatar: true })).hasAvatar).toBe(true)
    expect(botFromRow(row('mark')).hasAvatar).toBe(false)
  })

  it('put Hermes first and the rest by name, leaving out the profile Hermes keeps for its setup', () => {
    const roster = rosterFrom([row('sally', titled('Sally')), row('setup', { role: 'setup' }), hermes, row('alfred', titled('Alfred'))])

    expect(roster.map(bot => bot.profile)).toEqual(['default', 'alfred', 'sally'])
  })

  it('offer Hermes even when the roster leaves the default profile out', () => {
    expect(rosterFrom([row('alfred')])[0]).toBe(HERMES_BOT)
    expect(rosterFrom([])).toEqual([HERMES_BOT])
  })
})

describe('session calls for a bot', () => {
  it('carry no profile for Hermes and the bot’s profile otherwise', () => {
    expect(profileParam(undefined)).toEqual({})
    expect(profileParam('default')).toEqual({})
    expect(profileParam('alfred')).toEqual({ profile: 'alfred' })
  })

  it('keep a bot’s stored sessions apart from Hermes’s ones with the same id', () => {
    expect(sessionKey('20261014_120000_ab12')).toBe('20261014_120000_ab12')
    expect(sessionKey('20261014_120000_ab12', 'default')).toBe('20261014_120000_ab12')
    expect(sessionKey('20261014_120000_ab12', 'alfred')).toBe('alfred:20261014_120000_ab12')
    expect(sameProfile(undefined, 'default')).toBe(true)
    expect(sameProfile('alfred', undefined)).toBe(false)
  })
})

describe('finding a bot by name', () => {
  const bots = rosterFrom([hermes, row('alfred', titled('Alfred')), row('mark', titled('Mark')), row('mark-two', titled('Marko')), row('inbox-triage')])

  it('take its profile, its name, an @handle or the words people say', () => {
    expect(findBot(bots, 'alfred').bot?.profile).toBe('alfred')
    expect(findBot(bots, 'ALFRED').bot?.profile).toBe('alfred')
    expect(findBot(bots, '@mark').bot?.profile).toBe('mark')
    expect(findBot(bots, 'inbox triage').bot?.profile).toBe('inbox-triage')
    expect(findBot(bots, 'Hermes').bot?.profile).toBe('default')
  })

  it('take a part of a name that only one bot has, and list the bots a vaguer one could mean', () => {
    expect(findBot(bots, 'alf').bot?.profile).toBe('alfred')
    expect(findBot(bots, 'mar')).toMatchObject({ bot: null, candidates: [{ profile: 'mark' }, { profile: 'mark-two' }] })
    expect(findBot(bots, 'nobody')).toEqual({ bot: null, candidates: [] })
  })
})

describe('the bot a session runs as', () => {
  const bots = rosterFrom([hermes, row('alfred', titled('Alfred'))])

  it('comes from the roster, and is Hermes when the session has no profile', () => {
    expect(botByProfile(bots, undefined)).toBe(bots[0])
    expect(botByProfile(bots, 'alfred')).toBe(bots[1])
  })

  it('keeps the name of a profile the roster no longer lists, as the same object each time', () => {
    const gone = botByProfile(bots, 'old-bot')

    expect(gone).toMatchObject({ profile: 'old-bot', name: 'Old Bot', hasAvatar: false })
    expect(botByProfile(bots, 'old-bot')).toBe(gone)
  })
})
