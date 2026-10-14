import { useStore } from '@nanostores/react'
import { IconBrandSlack, IconPlugConnected, IconServer, IconTerminal2, IconWifi } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill, type PillTone, Toggle } from '../../../components/ui/glass.tsx'
import { logFailure } from '../../../lib/report.ts'
import { type HermesStatusPayload, rest } from '../../../lib/rest.ts'
import { useBackendData } from '../../../lib/use-async.ts'
import { $backend } from '../../../store/backend.ts'
import { $connection } from '../../../store/gateway.ts'
import { notify } from '../../../store/notifications.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

interface McpServerRow {
  name: string
  transport?: string
  url?: string | null
  command?: string | null
  enabled?: boolean
  [key: string]: unknown
}

const phaseTone = (phase: string): PillTone => (phase === 'ready' ? 'ok' : phase === 'failed' ? 'danger' : phase === 'stopped' || phase === 'idle' ? 'muted' : 'warn')

export function NetworkSection() {
  const backend = useStore($backend)
  const connection = useStore($connection)

  return (
    <>
      <SectionTitle title="Network" subtitle="The Hermes runtime this shell talks to, and what Hermes itself is connected to." />

      <SettingsGroup title="Hermes runtime">
        <SettingsRow icon={<IconServer />} label="Backend" description={<span className="selectable font-mono text-[11.5px]">{backend.baseUrl ?? 'not running'}</span>} keywords="hermes runtime server status">
          <Pill tone={phaseTone(backend.phase)} dot>
            {backend.phase}
          </Pill>
          <GlassButton size="sm" variant="ghost" onClick={() => void window.heraldOS.backend.restart().catch(logFailure('backend.restart'))} aria-label="Restart Hermes">
            Restart
          </GlassButton>
        </SettingsRow>
        <SettingsRow icon={<IconPlugConnected />} label="Gateway socket" description="JSON-RPC over WebSocket." keywords="websocket connection">
          <Pill tone={connection === 'open' ? 'ok' : connection === 'error' ? 'danger' : 'warn'} dot>
            {connection}
          </Pill>
        </SettingsRow>
        <SettingsRow
          icon={<IconTerminal2 />}
          label="Runtime command"
          description={<span className="selectable font-mono text-[11.5px]">{backend.runtime?.kind === 'attached' ? `Using ${backend.runtime.label} (HERALD_OS_BACKEND_URL)` : backend.runtime ? backend.runtime.command.join(' ') : '—'}</span>}
          keywords="hermes command path managed attached shared"
        >
          {backend.runtime && <Pill>{backend.runtime.kind}</Pill>}
        </SettingsRow>
        {backend.sharedGateway && (
          <InlineNote tone="info">
            Another app (Hermes Desktop, say) runs a Hermes gateway on this Hermes home (pid {backend.sharedGateway}). That is fine: Hermes runs each scheduled job once and keeps one messaging gateway. To share its backend
            too, start Herald OS with HERALD_OS_BACKEND_URL and HERALD_OS_BACKEND_TOKEN.
          </InlineNote>
        )}
        {backend.runtime?.kind === 'attached' && backend.localFiles === false && (
          <InlineNote tone="info">
            This Hermes did not read a file Herald wrote on this computer, so Herald treats it as running elsewhere (another computer, through a tunnel, say): files you attach are uploaded to it, it works
            in its own folders, and it knows your other files are out of its reach. Canvas AI needs a Hermes that reads this computer's files. If this one does run here, update it with `hermes update`.
          </InlineNote>
        )}
      </SettingsGroup>

      <McpServersGroup />
      <PlatformsGroup />
    </>
  )
}

function McpServersGroup() {
  const servers = useBackendData(() => rest.get<{ servers: McpServerRow[] }>('/api/mcp/servers'))
  const [override, setOverride] = useState<{ base: unknown; name: string; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const rows = servers.data?.servers ?? []

  const toggle = async (row: McpServerRow, enabled: boolean) => {
    setOverride({ base: servers.data, name: row.name, enabled })
    setBusy(row.name)

    try {
      await rest.put(`/api/mcp/servers/${encodeURIComponent(row.name)}/enabled`, { enabled })
      markSaved()
      notify({ title: enabled ? 'MCP server enabled' : 'MCP server disabled', body: `${row.name}. Takes effect on the next session.`, level: 'success' })
    } catch (error) {
      setOverride(null)
      notify({ title: 'Could not update MCP server', body: errorText(error), level: 'error' })
    } finally {
      setBusy(null)
      servers.reload()
    }
  }

  return (
    <SettingsGroup title="MCP servers">
      {rows.length === 0 && (
        <SettingsRow icon={<IconWifi />} label="MCP servers" description={servers.loading ? 'Loading…' : servers.error ? servers.error : 'No MCP servers configured. Add them in Connections.'} keywords="mcp model context protocol" />
      )}
      {rows.map(row => {
        const enabled = override && override.base === servers.data && override.name === row.name ? override.enabled : row.enabled !== false
        const target = row.url ?? (row.command ? [row.command, ...((row.args as string[] | undefined) ?? [])].join(' ') : '')

        return (
          <SettingsRow key={row.name} icon={<IconWifi />} label={row.name} description={<span className="selectable font-mono text-[11.5px]">{target || row.transport || 'MCP server'}</span>} keywords="mcp server">
            {row.transport && <Pill>{row.transport}</Pill>}
            <Toggle checked={enabled} onChange={next => void toggle(row, next)} label={`Enable ${row.name}`} disabled={busy === row.name} />
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}

type PlatformState = { state?: string; status?: string; [key: string]: unknown } | string

function platformTone(value: PlatformState): PillTone {
  const state = String(typeof value === 'string' ? value : (value.state ?? value.status ?? '')).toLowerCase()

  if (['connected', 'running', 'ok'].includes(state)) {
    return 'ok'
  }

  if (['fatal', 'error', 'failed'].includes(state)) {
    return 'danger'
  }

  if (!state) {
    return 'muted'
  }

  return 'warn'
}

function PlatformsGroup() {
  const status = useBackendData(() => rest.get<HermesStatusPayload & { gateway_platforms?: Record<string, PlatformState>; platforms?: Record<string, PlatformState> | PlatformState[] }>('/api/status'))
  const raw = status.data?.gateway_platforms ?? status.data?.platforms
  const entries: [string, PlatformState][] = Array.isArray(raw) ? raw.map((item, index) => [typeof item === 'string' ? item : String(item.name ?? item.id ?? index), item]) : Object.entries(raw ?? {})

  return (
    <SettingsGroup title="Messaging platforms">
      {entries.length === 0 && <SettingsRow icon={<IconBrandSlack />} label="Messaging platforms" description={status.loading ? 'Loading…' : 'No messaging platforms connected to the Hermes gateway.'} keywords="telegram discord slack whatsapp" />}
      {entries.map(([name, value]) => {
        const state = typeof value === 'string' ? value : String(value.state ?? value.status ?? 'unknown')

        return (
          <SettingsRow key={name} icon={<IconBrandSlack />} label={name} description="Connected to the Hermes gateway." keywords="messaging platform">
            <Pill tone={platformTone(value)} dot>
              {state}
            </Pill>
          </SettingsRow>
        )
      })}
    </SettingsGroup>
  )
}
