import { useStore } from '@nanostores/react'
import { IconClock, IconCloud, IconDownload, IconFolder, IconStar, IconTrash, IconUsers } from '@tabler/icons-react'
import type React from 'react'
import { useState } from 'react'
import { LinkAction, ProgressBar } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatBytes } from '../../lib/format.ts'
import { isMac } from '../../lib/shortcuts.ts'
import { useLocalData } from '../../lib/use-async.ts'
import { useSystemStats } from '../../store/system.ts'
import { openApp } from '../../store/windows.ts'
import { $home, $location, DRAG_MIME, type Location, moveItem, navigate, sameLocation } from './files-store.ts'

interface Place {
  id: string
  label: string
  icon: React.ReactNode
  location: Location
}

async function namesIn(dir: string): Promise<Set<string>> {
  try {
    return new Set((await window.heraldOS.fs.readDir(dir)).map(entry => entry.name))
  } catch {
    return new Set()
  }
}

/** Resolve the well-known folders for this Mac; anything missing falls back sensibly or is dropped. */
async function resolvePlaces(home: string): Promise<Place[]> {
  // Only a Mac has iCloud Drive; elsewhere the read fails every time, and main logs each failure.
  const [homeNames, mobileDocs] = await Promise.all([namesIn(home), isMac ? namesIn(`${home}/Library/Mobile Documents`) : Promise.resolve(new Set<string>())])
  const projects = homeNames.has('Projects') ? `${home}/Projects` : homeNames.has('Apps') ? `${home}/Apps` : home
  const shared = mobileDocs.has('com~apple~CloudDocs') ? `${home}/Library/Mobile Documents/com~apple~CloudDocs` : homeNames.has('Public') ? `${home}/Public` : null
  const places: Place[] = [
    { id: 'recent', label: 'Recent', icon: <IconClock />, location: { kind: 'recent' } },
    { id: 'favorites', label: 'Favorites', icon: <IconStar />, location: { kind: 'favorites' } },
    { id: 'projects', label: 'Projects', icon: <IconFolder />, location: { kind: 'dir', path: projects } },
    { id: 'downloads', label: 'Downloads', icon: <IconDownload />, location: { kind: 'dir', path: `${home}/Downloads` } }
  ]

  if (shared) {
    places.push({ id: 'shared', label: 'Shared', icon: <IconUsers />, location: { kind: 'dir', path: shared } })
  }

  places.push({ id: 'trash', label: 'Trash', icon: <IconTrash />, location: { kind: 'dir', path: `${home}/.Trash` } })

  return places
}

export function FilesSidebar() {
  const home = useStore($home)
  const location = useStore($location)
  const stats = useSystemStats()
  const places = useLocalData(() => (home ? resolvePlaces(home) : Promise.resolve([] as Place[])), [home])
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const disk = stats?.disks[0]
  const percent = disk && disk.total > 0 ? (disk.used / disk.total) * 100 : 0

  return (
    <aside className="flex w-[150px] shrink-0 flex-col justify-between" aria-label="Places">
      <nav className="flex flex-col gap-0.5">
        {!places.data && home && Array.from({ length: 6 }, (_, index) => <div key={index} className="shimmer mx-1 my-1 h-6 rounded-md" />)}
        {(places.data ?? []).map(place => {
          const active = sameLocation(location, place.location)
          const droppable = place.location.kind === 'dir'
          const dir = place.location.kind === 'dir' ? place.location.path : null

          return (
            <button
              key={place.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(place.location)}
              onDragOver={event => {
                if (droppable && event.dataTransfer.types.includes(DRAG_MIME)) {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropTarget(place.id)
                }
              }}
              onDragLeave={() => setDropTarget(current => (current === place.id ? null : current))}
              onDrop={event => {
                setDropTarget(null)
                const from = event.dataTransfer.getData(DRAG_MIME)

                if (!droppable || !from || !dir) {
                  return
                }

                event.preventDefault()
                void moveItem(from, dir, place.label)
              }}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] transition-colors duration-120 [&_svg]:size-[15px] [&_svg]:shrink-0',
                active ? 'bg-white/10 text-fg' : 'text-fg-2 hover:bg-white/6 hover:text-fg',
                dropTarget === place.id && 'bg-accent-soft text-fg ring-1 ring-accent-strong'
              )}
            >
              <span className={active ? 'text-accent-strong' : 'text-fg-3'}>{place.icon}</span>
              <span className="truncate">{place.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="flex flex-col gap-2 px-2.5 pb-1">
        <div className="flex items-center gap-2 text-[12px] text-fg-3">
          <IconCloud size={15} className="shrink-0 text-fg-3" />
          {disk ? (
            <span className="truncate">
              {formatBytes(disk.used, 0)} of {formatBytes(disk.total, 0)} used
            </span>
          ) : (
            <span className="shimmer h-3 w-24 rounded" />
          )}
        </div>
        <ProgressBar value={percent} className="h-1" />
        <LinkAction onClick={() => openApp('system')}>Manage storage</LinkAction>
      </div>
    </aside>
  )
}
