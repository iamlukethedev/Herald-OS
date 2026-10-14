import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { type Bot, isDefaultProfile } from '../lib/bots.ts'
import { cn } from '../lib/cn.ts'
import { $botAvatars, loadAvatar } from '../store/bots.ts'
import { HermesAvatar } from './app-icon.tsx'

/** A bot's face: Hermes's own mark, the picture Bot Mode gave the bot, or its initial on an accent tile. */
export function BotAvatar({ bot, size = 28, rounded = 8, className }: { bot: Bot; size?: number; rounded?: number; className?: string }) {
  const image = useStore($botAvatars)[bot.profile]

  useEffect(() => {
    void loadAvatar(bot)
  }, [bot])

  if (isDefaultProfile(bot.profile)) {
    return <HermesAvatar size={size} rounded={rounded} className={className} />
  }

  if (image) {
    return <img src={image} alt={bot.name} width={size} height={size} draggable={false} className={cn('shrink-0 object-cover shadow-card', className)} style={{ borderRadius: rounded }} />
  }

  return (
    <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center bg-accent-soft font-semibold text-accent-strong hairline', className)} style={{ width: size, height: size, borderRadius: rounded, fontSize: Math.round(size * 0.44) }}>
      {bot.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
