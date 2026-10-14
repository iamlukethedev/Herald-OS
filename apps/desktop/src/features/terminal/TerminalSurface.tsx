import { useStore } from '@nanostores/react'
import { IconChevronDown, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useMemo, useRef, useState } from 'react'
import { terminalColors } from '../../../shared/theme.ts'
import { Button } from '../../components/ui/button.tsx'
import { EmptyState } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { logFailure } from '../../lib/report.ts'
import { useShellCommands } from '../../shell/surfaces/shell-utils.ts'
import { $prefs } from '../../store/backend.ts'
import { $catalog, loadCatalog } from '../../store/catalog.ts'
import { $terminalRequest } from '../../store/terminal.ts'

const MONO_STACK = 'SF Mono, JetBrains Mono, Menlo, monospace'

interface Tab {
  id: string
  title: string
}

const THEME = {
  background: '#050f33',
  foreground: '#e9eefb',
  cursor: '#5296ff',
  cursorAccent: '#050f33',
  selectionBackground: 'rgba(82, 150, 255, 0.3)',
  black: '#101a3f',
  red: '#e5645b',
  green: '#5fc98a',
  yellow: '#e3a54a',
  blue: '#6aa9ff',
  magenta: '#c58af9',
  cyan: '#5fd1d6',
  white: '#c9ced6',
  brightBlack: '#5b6270',
  brightRed: '#f08078',
  brightGreen: '#7fe0a6',
  brightYellow: '#f0c070',
  brightBlue: '#8fbfff',
  brightMagenta: '#d7a8ff',
  brightCyan: '#84e6ea',
  brightWhite: '#f4f6f8'
}

/** A request this recent, found at mount, is what opened the Terminal: it becomes the first tab. */
const FRESH_REQUEST_MS = 3000

/** Real shells in real PTYs. Tabs stay alive while the surface is hidden and end when it closes. */
export function TerminalSurface() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const live = useRef(new Set<string>())

  const create = async (program?: { id: string; label: string }) => {
    if (pending.current) {
      return
    }

    pending.current = true

    try {
      const handle = await window.heraldOS.terminal.create({ cols: 120, rows: 30, program: program?.id })

      if (!mounted.current) {
        void window.heraldOS.terminal.dispose(handle.id).catch(logFailure('terminal.dispose'))

        return
      }

      live.current.add(handle.id)
      setTabs(current => [...current, { id: handle.id, title: program?.label ?? handle.shell.split('/').pop() ?? 'shell' }])
      setActive(handle.id)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
    }
  }

  useEffect(() => {
    const request = $terminalRequest.get()

    if (tabs.length === 0 && !error) {
      void create(request && Date.now() - request.at < FRESH_REQUEST_MS ? { id: request.program, label: request.label } : undefined)
    }

    // Later requests (the Terminal already open) add a tab.
    return $terminalRequest.listen(next => {
      if (next) {
        void create({ id: next.program, label: next.label })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Panels mode: the Terminal is its own window and hears about agents as a command.
  useShellCommands(command => {
    if (command.type === 'terminal-program' && command.args?.[0]) {
      void create({ id: command.args[0], label: command.args[1] ?? command.args[0] })
    }
  })

  const catalog = useStore($catalog)
  const agents = useMemo(() => catalog.groups.flatMap(group => group.entries).filter(entry => entry.terminal && entry.installed), [catalog.groups])
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!catalog.loaded) {
      void loadCatalog()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ids = live.current
    mounted.current = true

    return () => {
      mounted.current = false

      for (const id of ids) {
        void window.heraldOS.terminal.dispose(id).catch(logFailure('terminal.dispose'))
      }

      ids.clear()
    }
  }, [])

  useEffect(
    () =>
      window.heraldOS.terminal.onExit(id => {
        live.current.delete(id)
        setTabs(current => {
          const next = current.filter(tab => tab.id !== id)
          setActive(prev => (prev === id ? (next[next.length - 1]?.id ?? null) : prev))

          return next
        })
      }),
    []
  )

  const close = (id: string) => {
    live.current.delete(id)
    void window.heraldOS.terminal.dispose(id).catch(logFailure('terminal.dispose'))
    setTabs(current => {
      const next = current.filter(tab => tab.id !== id)
      setActive(prev => (prev === id ? (next[next.length - 1]?.id ?? null) : prev))

      return next
    })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 px-3">
        {tabs.map(tab => (
          <div key={tab.id} className={cn('group/reveal-row flex h-7 items-center gap-1 rounded-sm pr-1 pl-2.5 text-[12px]', tab.id === active ? 'bg-white/8 text-fg' : 'text-fg-3 hover:bg-white/4 hover:text-fg-2')}>
            <button type="button" onClick={() => setActive(tab.id)} className="font-mono">
              {tab.title}
            </button>
            <button type="button" aria-label="Close terminal" onClick={() => close(tab.id)} className="flex size-5 items-center justify-center rounded-xs text-fg-4 reveal hover:text-fg">
              <IconX size={12} />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="icon-sm" aria-label="New terminal" onClick={() => void create()}>
          <IconPlus size={15} />
        </Button>
        {agents.length > 0 && (
          <div className="relative">
            <Button variant="ghost" size="icon-sm" aria-label="New tab with a coding agent" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}>
              <IconChevronDown size={14} />
            </Button>
            {menuOpen && (
              <div role="menu" className="float animate-pop absolute top-[calc(100%+4px)] left-0 z-30 flex min-w-[200px] flex-col rounded-lg p-1" onMouseLeave={() => setMenuOpen(false)}>
                {agents.map(agent => (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      void create({ id: agent.id, label: agent.label })
                    }}
                    className="flex h-8 items-center gap-2 rounded-md px-2.5 text-left hover:bg-white/8"
                  >
                    <IconSparkles size={14} className="text-fg-3" />
                    <span className="text-[12.5px]">{agent.label}</span>
                    <span className="ml-auto font-mono text-[11px] text-fg-4">{agent.bin}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1 px-3 pb-3">
        {error && (
          <EmptyState title="Terminal unavailable" description={error} action={<Button onClick={() => { setError(null); void create() }}>Try again</Button>} />
        )}
        {tabs.map(tab => (
          <TerminalView key={tab.id} id={tab.id} active={tab.id === active} />
        ))}
      </div>
    </div>
  )
}

function TerminalView({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const prefs = useStore($prefs)
  const theme = useMemo(() => (prefs.themeColors ? terminalColors(prefs.themeColors, prefs.themeScheme) : THEME), [prefs.themeColors, prefs.themeScheme])
  const fontFamily = prefs.fonts?.mono ? `${JSON.stringify(prefs.fonts.mono)}, ${MONO_STACK}` : MONO_STACK
  const initial = useRef({ theme, fontFamily })
  initial.current = { theme, fontFamily }

  useEffect(() => {
    if (term.current) {
      term.current.options.theme = theme
      term.current.options.fontFamily = fontFamily
      fit.current?.fit()
    }
  }, [theme, fontFamily])

  useEffect(() => {
    const el = host.current

    if (!el) {
      return
    }

    const terminal = new Terminal({
      theme: initial.current.theme,
      fontFamily: initial.current.fontFamily,
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 8000,
      macOptionIsMeta: true
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(el)

    try {
      terminal.loadAddon(new WebglAddon())
    } catch {
      // Canvas renderer fallback is automatic.
    }

    term.current = terminal
    fit.current = fitAddon
    const offData = window.heraldOS.terminal.onData((tid, data) => {
      if (tid === id) {
        terminal.write(data)
      }
    })
    const onInput = terminal.onData(data => window.heraldOS.terminal.write(id, data))
    const onResize = terminal.onResize(({ cols, rows }) => window.heraldOS.terminal.resize(id, cols, rows))
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        fitAddon.fit()
      }
    })
    observer.observe(el)
    fitAddon.fit()

    return () => {
      observer.disconnect()
      offData()
      onInput.dispose()
      onResize.dispose()
      terminal.dispose()
      term.current = null
    }
  }, [id])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fit.current?.fit()
        term.current?.focus()
      })
    }
  }, [active])

  return <div ref={host} className={cn('absolute inset-x-3 inset-y-0 bottom-3 overflow-hidden rounded-lg hairline', !active && 'invisible')} style={{ background: theme.background }} />
}
