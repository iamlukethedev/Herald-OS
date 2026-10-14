import { useStore } from '@nanostores/react'
import { IconBrain, IconEyeOff, IconFolder, IconHash, IconHistory, IconShieldLock, IconTrash, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, GlassCard, LinkAction, Toggle } from '../../../components/ui/glass.tsx'
import { deviceNoun } from '../../../lib/platform-labels.ts'
import { useLocalData } from '../../../lib/use-async.ts'
import { $env } from '../../../store/backend.ts'
import { $continuity, forgetThreads, setContinuityEnabled, setExclusions } from '../../../store/continuity.ts'
import { notify } from '../../../store/notifications.ts'
import { AuditRow } from './AgentsSection.tsx'
import { useT } from '../../../store/i18n.ts'
import { errorText, markSaved, SectionTitle, SettingsBlock, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * Privacy: what "Pick up where you left off" may look at, the raw permission policy the Herald OS
 * bridge plugin enforces, and the audit trail. The textarea is the source of truth; the "Ask
 * before sending" toggle in Hermes & agents edits the same file line by line.
 */

function ContinuitySettings() {
  const continuity = useStore($continuity)
  const home = useStore($env)?.homeDir ?? ''
  const [word, setWord] = useState('')
  const add = (entries: string[]) => void setExclusions([...continuity.exclude, ...entries])
  const isFolder = (entry: string) => entry.startsWith('/') || entry.startsWith('~')

  const pickFolders = async () => {
    const picked = await window.heraldOS.fs.pickFiles({ directory: true, multiple: true })
    add(picked.map(target => (home && target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target)))
  }

  return (
    <SettingsGroup title="Pick up where you left off">
      <SettingsRow
        icon={<IconBrain />}
        label="Pick up where you left off"
        description="When you open Herald OS or come back after a break, Hermes reads the names and dates of your recent documents, project folders (with their git state), conversations, open apps and today's calendar, then suggests where to continue. Never file contents, window titles or the screen. Your Hermes model provider writes the suggestions."
        keywords="continuity resume catch up brain context recent work suggestions welcome back"
      >
        <Toggle checked={continuity.enabled === true} onChange={enabled => void setContinuityEnabled(enabled)} label="Pick up where you left off" />
      </SettingsRow>
      <SettingsRow
        icon={<IconEyeOff />}
        label="Never look at"
        description="Folders and words Herald OS leaves out. A word hides every file, project, chat or event whose name contains it, such as a client's name."
        keywords="exclude hide private confidential folders words clients"
        below={
          <div className="flex flex-col gap-2.5">
            {continuity.exclude.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {continuity.exclude.map(entry => (
                  <span key={entry} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-white/6 pr-1 pl-2.5 text-[12px] text-fg-2">
                    {isFolder(entry) ? <IconFolder size={13} className="shrink-0 text-fg-3" /> : <IconHash size={13} className="shrink-0 text-fg-3" />}
                    <span className="truncate">{entry}</span>
                    <button
                      type="button"
                      aria-label={`Stop leaving out ${entry}`}
                      onClick={() => void setExclusions(continuity.exclude.filter(e => e !== entry))}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-fg-4 hover:bg-white/10 hover:text-fg"
                    >
                      <IconX size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={event => {
                event.preventDefault()

                if (word.trim()) {
                  add([word.trim()])
                  setWord('')
                }
              }}
            >
              <input
                value={word}
                onChange={event => setWord(event.target.value)}
                placeholder="Add a word, such as a client's name"
                aria-label="Word to leave out"
                className="glass-input h-8 min-w-0 flex-1 rounded-lg px-3 text-[12.5px] text-fg outline-none"
              />
              <GlassButton size="sm" type="submit" disabled={!word.trim()}>
                Add word
              </GlassButton>
            </form>
          </div>
        }
      >
        <GlassButton size="sm" onClick={() => void pickFolders()}>
          Add folder…
        </GlassButton>
      </SettingsRow>
      <SettingsRow icon={<IconTrash />} label="Forget suggestions" description="Clear the threads Hermes found. Herald OS keeps nothing else from a catch-up." keywords="clear delete reset threads">
        <GlassButton size="sm" variant="ghost" disabled={!continuity.threads?.length} onClick={() => void forgetThreads()}>
          Forget
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}

export function PrivacySection() {
  const t = useT()
  const policy = useLocalData(() => window.heraldOS.bridge.readPolicy())
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const audit = useLocalData(() => (showAudit ? window.heraldOS.bridge.readAudit(200) : Promise.resolve([])), [showAudit])
  const text = draft ?? policy.data ?? ''
  const dirty = draft !== null && draft !== policy.data

  useEffect(() => {
    setDraft(null)
  }, [policy.data])

  const save = async () => {
    setSaving(true)

    try {
      await window.heraldOS.bridge.writePolicy(text)
      markSaved()
      notify({ title: 'Permissions saved', body: 'The system bridge reads the policy on its next action.', level: 'success' })
      policy.reload()
    } catch (error) {
      notify({ title: 'Could not save policy', body: errorText(error), level: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SectionTitle title={t('settings.section.privacy')} subtitle={t('settings.privacy.subtitle', { device: deviceNoun() })} />

      <ContinuitySettings />

      <SettingsBlock title="Permission policy" label="Permission policy" description="Tiers: read runs freely, act runs and is audited, mutate asks first, destructive always asks. Protected paths are never touched." keywords="permissions yaml tiers allow confirm deny bridge">
        <GlassCard className="flex flex-col gap-3 p-3.5">
          <div className="text-[12px] leading-snug text-fg-3">
            Tiers: <span className="text-fg-2">read</span> runs freely, <span className="text-fg-2">act</span> runs and is audited, <span className="text-fg-2">mutate</span> asks first, <span className="text-fg-2">destructive</span> always asks. Each tier takes <span className="font-mono text-fg-2">allow</span>, <span className="font-mono text-fg-2">confirm</span> or <span className="font-mono text-fg-2">deny</span>.
          </div>
          <textarea
            value={text}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
            aria-label="Permission policy"
            className="glass-input min-h-[260px] resize-y rounded-lg p-3 font-mono text-[12px] leading-relaxed text-fg-2 outline-none"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-fg-4">{policy.error ? policy.error : dirty ? 'Unsaved changes' : 'Saved on disk'}</span>
            <div className="flex items-center gap-2">
              <GlassButton size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(null)}>
                Revert
              </GlassButton>
              <GlassButton size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
                Save policy
              </GlassButton>
            </div>
          </div>
        </GlassCard>
      </SettingsBlock>

      <SettingsGroup title="Protected paths">
        <SettingsRow
          icon={<IconShieldLock />}
          label="Protected paths"
          description="Paths listed under protected_paths are never read, written or moved by the bridge, whatever the tier says. Hermes's own config.yaml and secrets are protected upstream regardless."
          keywords="secrets config.yaml never touched"
        />
      </SettingsGroup>

      <SettingsGroup title="Audit">
        <SettingsRow
          icon={<IconHistory />}
          label="Audit log"
          description="Every action the bridge took or refused, newest first."
          keywords="history activity"
          below={
            showAudit ? (
              <div className="animate-rise flex max-h-[360px] flex-col overflow-y-auto rounded-lg border border-line bg-black/20">
                {audit.loading && !audit.data?.length && <div className="p-3 text-[12px] text-fg-4">Loading…</div>}
                {!audit.loading && (audit.data?.length ?? 0) === 0 && <div className="p-3 text-[12px] text-fg-4">No bridge activity yet.</div>}
                {(audit.data ?? []).map((entry, index) => (
                  <AuditRow key={`${entry.ts}-${index}`} entry={entry} />
                ))}
              </div>
            ) : undefined
          }
        >
          {showAudit && (
            <GlassButton size="sm" variant="ghost" onClick={audit.reload}>
              Refresh
            </GlassButton>
          )}
          <LinkAction onClick={() => setShowAudit(o => !o)}>{showAudit ? 'Hide log' : 'View log'}</LinkAction>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
