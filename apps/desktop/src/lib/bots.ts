import type { ProfileRow } from '@herald-os/client'

/*
 * Bots are Hermes profiles: each has its own memory, skills, model and sessions, and Hermes
 * Desktop's Bot Mode gives it a title and a picture. The gateway serves the roster
 * (`profiles.list`); the default profile is Hermes itself.
 */

/** The profile Hermes itself runs as. */
export const DEFAULT_PROFILE = 'default'

export interface Bot {
  /** The Hermes profile, as session RPCs take it. */
  profile: string
  /** The name it goes by: its Bot Mode title, else its profile's display name. */
  name: string
  /** What it is for, from its profile. */
  description: string
  /** The gateway has a picture of it (`profiles.get_asset`). */
  hasAvatar: boolean
}

export const HERMES_BOT: Bot = { profile: DEFAULT_PROFILE, name: 'Hermes', description: '', hasAvatar: false }

/** The `ui_meta` key Bot Mode keeps a bot's look under. */
const BOT_MODE_META = 'hermes-bots'

export const isDefaultProfile = (profile: string | null | undefined): profile is typeof DEFAULT_PROFILE | null | undefined => !profile || profile === DEFAULT_PROFILE

/** The `profile` param of a session RPC. Hermes's own sessions go without one, as they always have. */
export function profileParam(profile: string | null | undefined): { profile?: string } {
  return isDefaultProfile(profile) ? {} : { profile }
}

/** A stored session's key across profiles: its id for Hermes, `profile:id` for a bot, because stored ids can repeat across profiles' stores. */
export function sessionKey(storedId: string, profile?: string | null): string {
  return isDefaultProfile(profile) ? storedId : `${profile}:${storedId}`
}

export const sameProfile = (a: string | null | undefined, b: string | null | undefined): boolean => (isDefaultProfile(a) ? DEFAULT_PROFILE : a) === (isDefaultProfile(b) ? DEFAULT_PROFILE : b)

/** "inbox-triage" -> "Inbox Triage", as Bot Mode names a profile it has no title for. */
const titleCase = (name: string): string => name.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, letter => letter.toUpperCase())

function botModeTitle(row: ProfileRow): string {
  const meta = row.ui_meta?.[BOT_MODE_META]
  const title = meta && typeof meta === 'object' ? (meta as { title?: unknown }).title : undefined

  return typeof title === 'string' ? title.trim() : ''
}

/** Bot Mode describes a bot it creates as "Title — what it does", and the title is already its name. */
function withoutName(description: string, name: string): string {
  const lead = `${name} — `

  return description === name ? '' : description.startsWith(lead) ? description.slice(lead.length).trim() : description
}

export function botFromRow(row: ProfileRow): Bot {
  const isDefault = row.is_default === true || row.name === DEFAULT_PROFILE
  const name = botModeTitle(row) || row.display_name?.trim() || (isDefault ? HERMES_BOT.name : titleCase(row.name))

  return { profile: isDefault ? DEFAULT_PROFILE : row.name, name, description: withoutName((row.description ?? '').trim(), name), hasAvatar: row.has_avatar === true }
}

/** The roster Herald offers: Hermes first, then the bots by name. The profile Hermes keeps for its own setup is no bot. */
export function rosterFrom(rows: readonly ProfileRow[]): Bot[] {
  const bots = rows.filter(row => row.role !== 'setup').map(botFromRow)
  const others = bots.filter(bot => bot.profile !== DEFAULT_PROFILE).sort((a, b) => a.name.localeCompare(b.name))

  return [bots.find(bot => bot.profile === DEFAULT_PROFILE) ?? HERMES_BOT, ...others]
}

/** One object per profile the roster lacks, so a chat's bot keeps its identity between renders. */
const unlisted = new Map<string, Bot>()

/** The bot a session runs as; a profile the roster no longer has still reads as its name. */
export function botByProfile(bots: readonly Bot[], profile: string | null | undefined): Bot {
  const wanted = isDefaultProfile(profile) ? DEFAULT_PROFILE : profile
  const listed = bots.find(bot => bot.profile === wanted)

  if (listed || wanted === DEFAULT_PROFILE) {
    return listed ?? HERMES_BOT
  }

  const known = unlisted.get(wanted) ?? { profile: wanted, name: titleCase(wanted), description: '', hasAvatar: false }
  unlisted.set(wanted, known)

  return known
}

/** A name as people say it: lower case, hyphens and underscores as spaces, no leading @. */
const spoken = (value: string): string => value.trim().replace(/^@/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').toLowerCase()

/** The bot a person or Hermes means by a name ("Alfred", "@mark", "inbox triage"); `candidates` when it is not exactly one. */
export function findBot(bots: readonly Bot[], query: string): { bot: Bot | null; candidates: Bot[] } {
  const needle = spoken(query)

  if (!needle) {
    return { bot: null, candidates: [...bots] }
  }

  const byProfile = bots.find(bot => spoken(bot.profile) === needle)

  if (byProfile) {
    return { bot: byProfile, candidates: [byProfile] }
  }

  const byName = bots.filter(bot => spoken(bot.name) === needle || (needle === 'hermes' && bot.profile === DEFAULT_PROFILE))
  const matches = byName.length > 0 ? byName : bots.filter(bot => spoken(bot.profile).includes(needle) || spoken(bot.name).includes(needle))

  return { bot: matches.length === 1 ? matches[0] : null, candidates: matches }
}
