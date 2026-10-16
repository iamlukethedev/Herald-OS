import { useStore } from '@nanostores/react'
import { IconCar } from '@tabler/icons-react'
import { Toggle } from '../../../components/ui/glass.tsx'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { useT } from '../../../store/i18n.ts'
import { notify } from '../../../store/notifications.ts'
import { flyoversOn } from '../../roadster/flight.ts'
import { errorText, markSaved, SettingsRow } from './shared.tsx'

/** The roadster over the Pet Room and the screensaver; the command bar's easter egg flies either way. */
export function FlyoverRow() {
  const t = useT()
  const on = flyoversOn(useStore($prefs))

  const toggle = async (next: boolean) => {
    try {
      await updatePrefs({ flyovers: next })
      markSaved()
    } catch (error) {
      notify({ title: t('settings.appearance.flyoversFailed'), body: errorText(error), level: 'error' })
    }
  }

  return (
    <SettingsRow icon={<IconCar />} label={t('settings.appearance.flyovers')} description={t('settings.appearance.flyoversHint')} keywords="roadster car flyover animation easter egg screensaver pet room fly">
      <Toggle checked={on} onChange={next => void toggle(next)} label={t('settings.appearance.flyovers')} />
    </SettingsRow>
  )
}
