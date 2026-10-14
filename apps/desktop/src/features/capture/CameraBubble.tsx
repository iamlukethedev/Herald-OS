import { IconCameraOff } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { canOpenPrivacyPanes, openPrivacyPane } from '../../lib/privacy-pane.ts'
import { logFailure } from '../../lib/report.ts'

/** Your camera in a round bubble, mirrored like a mirror, for screen recordings and demos. */
export function CameraBubble() {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false

    void (async () => {
      try {
        if (!(await window.heraldOS.capture.requestCamera())) {
          setDenied(true)
          throw new Error('Herald OS is not allowed to use the camera (System Settings > Privacy & Security > Camera).')
        }

        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false })

        if (stopped) {
          stream.getTracks().forEach(track => track.stop())

          return
        }

        if (video.current) {
          video.current.srcObject = stream
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()

    return () => {
      stopped = true
      stream?.getTracks().forEach(track => track.stop())
    }
  }, [])

  return (
    <div className="flex h-full w-full items-center justify-center p-2">
      <div className="relative aspect-square h-full max-h-full max-w-full overflow-hidden rounded-full border-2 border-line-strong bg-black/40 shadow-(--shadow-float)">
        {error ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center text-[11.5px] text-fg-3">
            <IconCameraOff size={22} />
            {error}
            {denied && canOpenPrivacyPanes() && (
              <GlassButton size="sm" onClick={() => void openPrivacyPane('camera').catch(logFailure('shell.openExternal'))} aria-label="Open the Camera pane in System Settings">
                Open System Settings
              </GlassButton>
            )}
          </div>
        ) : (
          <video ref={video} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Camera" />
        )}
      </div>
    </div>
  )
}
