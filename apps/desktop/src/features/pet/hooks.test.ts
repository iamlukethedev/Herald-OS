import { describe, expect, it } from 'vitest'
import { PET_IDLE_SNAPSHOT, type PetSnapshot } from '../../../shared/pet.ts'
import { extrasOf, heldApprovalOf, type PetUi } from './hooks.ts'

const waiting: PetSnapshot = { ...PET_IDLE_SNAPSHOT, activity: 'waiting', approval: { id: 'r1', params: { description: 'Move Budget.xlsx' }, voice: false } }
const ui: PetUi = { bubble: false, setBubble: () => undefined, drop: null, setDrop: () => undefined, say: null, hush: () => undefined }

describe('heldApprovalOf', () => {
  it('leaves an approval to the request host while the pet is still walking to it', () => {
    expect(heldApprovalOf(waiting, extrasOf(waiting, ui, false))).toBeNull()
  })

  it('holds the approval once the pet draws its card', () => {
    expect(heldApprovalOf(waiting, extrasOf(waiting, ui, true))).toBe('r1')
  })

  it('holds nothing without an approval', () => {
    expect(heldApprovalOf(PET_IDLE_SNAPSHOT, extrasOf(PET_IDLE_SNAPSHOT, { ...ui, bubble: true }, true))).toBeNull()
  })
})
