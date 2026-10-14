import { useStore } from '@nanostores/react'
import { IconContrast, IconSparkles, IconTextSize } from '@tabler/icons-react'
import { useState } from 'react'
import { Chips, Toggle } from '../../../components/ui/glass.tsx'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { useT } from '../../../store/i18n.ts'
import { errorText, markSaved, readLocalFlag, SectionTitle, SettingsGroup, SettingsRow, writeLocal } from './shared.tsx'

/*
 * Text size and high contrast are shell-side: they set `font-size` / `data-contrast` on the
 * document element and persist in localStorage. `applyAccessibility()` re-applies them and is
 * called when the page first mounts (the stylesheet has no `data-contrast` rules yet; see report).
 */

export type TextSize = 'small' | 'default' | 'large'

const TEXT_SIZE_KEY = 'herald-os.a11y.text-size'
const CONTRAST_KEY = 'herald-os.a11y.high-contrast'
const TEXT_SIZES: { id: TextSize; label: string; px: string }[] = [
  { id: 'small', label: 'Small', px: '12px' },
  { id: 'default', label: 'Default', px: '13px' },
  { id: 'large', label: 'Large', px: '14.5px' }
]

function readTextSize(): TextSize {
  try {
    const raw = localStorage.getItem(TEXT_SIZE_KEY)

    return raw === 'small' || raw === 'large' ? raw : 'default'
  } catch {
    return 'default'
  }
}

function applyTextSize(size: TextSize): void {
  const px = TEXT_SIZES.find(item => item.id === size)?.px ?? '13px'
  document.documentElement.style.fontSize = size === 'default' ? '' : px
  document.body.style.fontSize = size === 'default' ? '' : px
}

function applyContrast(on: boolean): void {
  if (on) {
    document.documentElement.dataset.contrast = 'high'
  } else {
    delete document.documentElement.dataset.contrast
  }
}

/** Re-apply persisted accessibility choices to the document. Safe to call repeatedly. */
export function applyAccessibility(): void {
  applyTextSize(readTextSize())
  applyContrast(readLocalFlag(CONTRAST_KEY, false))
}

export function AccessibilitySection() {
  const t = useT()
  const prefs = useStore($prefs)
  const [textSize, setTextSize] = useState<TextSize>(readTextSize)
  const [contrast, setContrast] = useState(() => readLocalFlag(CONTRAST_KEY, false))

  const setMotion = async (next: boolean) => {
    try {
      await updatePrefs({ reduceMotion: next })
      markSaved()
    } catch (error) {
      notify({ title: 'Could not save setting', body: errorText(error), level: 'error' })
    }
  }

  const changeText = (next: TextSize) => {
    setTextSize(next)
    applyTextSize(next)
    writeLocal(TEXT_SIZE_KEY, next)
    markSaved()
  }

  const changeContrast = (next: boolean) => {
    setContrast(next)
    applyContrast(next)
    writeLocal(CONTRAST_KEY, String(next))
    markSaved()
  }

  return (
    <>
      <SectionTitle title={t('settings.section.accessibility')} subtitle={t('settings.accessibility.subtitle')} />

      <SettingsGroup title="Vision">
        <SettingsRow icon={<IconTextSize />} label="Text size" description="Scales the whole interface." keywords="font zoom bigger smaller">
          <Chips items={TEXT_SIZES} value={textSize} onChange={changeText} />
        </SettingsRow>
        <SettingsRow icon={<IconContrast />} label="High contrast" description="Stronger strokes and text. Marks the document with data-contrast for the stylesheet." keywords="contrast readability">
          <Toggle checked={contrast} onChange={changeContrast} label="High contrast" />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Motion">
        <SettingsRow icon={<IconSparkles />} label="Reduce motion" description="Collapse non-essential animation across the shell. Same setting as in Appearance." keywords="animation">
          <Toggle checked={prefs.reduceMotion} onChange={next => void setMotion(next)} label="Reduce motion" />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
