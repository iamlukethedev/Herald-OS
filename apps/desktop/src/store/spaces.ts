import { computed } from 'nanostores'
import type { TextKey } from '../../shared/i18n.ts'
import type { SpaceDef } from '../../shared/ipc.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { t } from './i18n.ts'

export const $spaces = computed($prefs, prefs => prefs.spaces)
export const $activeSpace = computed($prefs, prefs => prefs.spaces.find(s => s.id === prefs.activeSpace) ?? prefs.spaces[0])

/** The Spaces Herald OS starts with, as main stores them. */
const STARTING_SPACES = new Map<string, { name: string; key: TextKey }>([
  ['personal', { name: 'Personal', key: 'space.personal' }],
  ['work', { name: 'Work', key: 'space.work' }],
  ['ideas', { name: 'Ideas', key: 'space.ideas' }]
])

/** A Space's name as shown: the ones Herald starts with are in the language shown until renamed. */
export function spaceLabel(space: Pick<SpaceDef, 'id' | 'name'>): string {
  const starting = STARTING_SPACES.get(space.id)

  return starting?.name === space.name ? t(starting.key) : space.name
}

export function setActiveSpace(id: string): void {
  void updatePrefs({ activeSpace: id })
}

export function addSpace(name: string, color = '#4d92ff'): void {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `space-${Date.now().toString(36)}`
  const next: SpaceDef = { id, name, color }
  void updatePrefs({ spaces: [...$prefs.get().spaces, next], activeSpace: id })
}

export function removeSpace(id: string): void {
  const spaces = $prefs.get().spaces.filter(s => s.id !== id)

  if (spaces.length === 0) {
    return
  }

  void updatePrefs({ spaces, activeSpace: $prefs.get().activeSpace === id ? spaces[0].id : $prefs.get().activeSpace })
}

/** Sessions created in a space carry this marker in their title so lists can filter without backend changes. */
export function spaceTag(id: string): string {
  return `[${id}]`
}
