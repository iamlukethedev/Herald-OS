import type { ApprovalChoice } from '@herald-os/client'
import { type CSSProperties, type RefObject, useLayoutEffect } from 'react'
import { cn } from '../../../lib/cn.ts'
import { ApprovalCard } from '../../../shell/RequestHost.tsx'
import type { RoomApproval } from '../model/types.ts'
import { keepFocus } from './AgentOverlay.tsx'
import type { PetBox } from './layout.ts'

export interface PopoverPlacement {
  above: boolean
  align: 'start' | 'center' | 'end'
}

/** About the card's size: it opens below a pet with less room than this above it, and inward near a side. */
const CARD_HEIGHT = 230
const CARD_WIDTH = 340

/** Where the card opens by a pet at (x, y) in a scene `width` wide, so it stays inside the scene. */
export function placePopover(at: { x: number; y: number }, width: number, pet: PetBox): PopoverPlacement {
  const half = CARD_WIDTH / 2

  return { above: at.y - pet.height > CARD_HEIGHT, align: at.x < half + 8 ? 'start' : at.x > width - half - 8 ? 'end' : 'center' }
}

/**
 * Herald's own approval card by the pet that holds the approval up. It never takes the focus, its
 * buttons are not on the tab path, and only a click answers it.
 */
export function ApprovalPopover({ approval, placement, pet, still, popoverRef, onChoice }: { approval: RoomApproval; placement: PopoverPlacement; pet: PetBox; still: boolean; popoverRef: RefObject<HTMLDivElement | null>; onChoice: (choice: ApprovalChoice) => void }) {
  useLayoutEffect(() => {
    popoverRef.current?.querySelectorAll('button, [tabindex]').forEach(element => (element as HTMLElement).setAttribute('tabindex', '-1'))
  })

  const style: CSSProperties = {
    width: CARD_WIDTH,
    ...(placement.above ? { bottom: Math.round(pet.height * 0.84) + 36 } : { top: 44 }),
    ...(placement.align === 'start' ? { left: -Math.round(pet.width * 0.5) } : placement.align === 'end' ? { right: -Math.round(pet.width * 0.5) } : { left: -CARD_WIDTH / 2 })
  }

  return (
    <div ref={popoverRef} role="group" aria-label="Hermes is asking for permission" onMouseDown={keepFocus} className={cn('float pointer-events-auto absolute rounded-2xl p-4', !still && 'animate-rise')} style={style}>
      <ApprovalCard id={approval.requestId} params={{ ...approval.params, session_id: approval.sessionId }} voiceHint={false} onChoice={onChoice} />
    </div>
  )
}
