# herald-os-bridge

The Hermes plugin that lets Hermes act on the computer and drive the Herald OS interface. It is a
regular out-of-tree plugin: Hermes loads it from `$HERMES_HOME/plugins/herald-os-bridge`, a link
`npm run bootstrap` creates to this folder. Nothing in the Hermes core is patched.

Tools, permission tiers, protected paths, the policy file and the audit log are documented in
[docs/SYSTEM-BRIDGE.md](../../docs/SYSTEM-BRIDGE.md).

```
__init__.py          register(): the `herald_os` toolset, the bundled skills (SKILLS) and the observer hooks
plugin.yaml          manifest: name, version, tools, supported platforms
bridge/
  tools.py           tool schemas and handlers (TOOL_SPECS)
  scope.py           where the tools are offered and run: Herald OS sessions only
  permissions.py     tiers, protected paths, the approval gate
  audit.py           one JSON line per call in $HERMES_HOME/herald-os/audit.jsonl
  crash.py           crash report summaries for system_logs (macOS .ips, Linux core dumps)
  documents.py       system_documents: invoice hints, suggested names, scan pictures, filing places
  ui.py              client for the shell's control socket (the `os_ui`, `canvas`, `docs`, `sheets`, `slides` and `calc` tools)
  observe.py         observer hooks: live steps from Hermes outside Herald OS for the Pet Room, off unless asked for
  util.py            shared helpers (data folder, HERALD_OS_* settings)
  host/              HostAdapter per OS: darwin.py, linux.py, posix.py, windows.py (stub)
skills/
  herald-os/         when to use these tools
  diagnose-crash/    how to explain a crash from its report
  file-documents/    how to find, read, rename and file documents such as invoices, with undo
  herald-os-tailor/  how to change Herald OS itself: themes, fonts, keybindings, settings
  herald-canvas/     how to make and edit pictures with the canvas tool: workflow, design habits, .comp format
  herald-docs/       how to write and edit documents with the docs tool: drafts, marked text, formatting, pages, comments and reviews, saving
  herald-sheets/     how to work in spreadsheets with the sheets tool: formulas, cleaning data, charts, summaries, building workbooks
  herald-slides/     how to make presentations with the slides tool: outlines, layouts, the master, themes, transitions, diagrams, speaker notes
  herald-calc/       how to do exact math with the calc tool: sums, units, currencies, dates, notes with totals, graphs, the history
tests/               pytest suite: `npm run test:bridge` from the repository root
```

## Enabling it by hand

`npm run bootstrap` does all of this. Without it:

```bash
ln -s "$PWD/plugins/herald-os-bridge" ~/.hermes/plugins/herald-os-bridge
hermes plugins enable herald-os-bridge
hermes tools enable herald_os
```

To switch the tools off without uninstalling, set `herald_os.bridge.enabled: false` in
`~/.hermes/config.yaml`, or `HERALD_OS_BRIDGE_DISABLED=1` in the backend's environment for one run.

To take it all back, `herald-os setup --undo` on Linux; elsewhere the steps, and the list of what
Herald OS changes in Hermes, are in
[docs/SYSTEM-BRIDGE.md](../../docs/SYSTEM-BRIDGE.md#what-herald-os-changes-in-your-hermes).

## Live steps from Hermes outside Herald OS

`bridge/observe.py` registers Hermes's observer hooks (`pre_tool_call`, `post_tool_call`,
`subagent_start`, `subagent_stop`, `on_session_start`, `on_session_end`, `pre_approval_request` and
`post_approval_response`), which Hermes runs in every process that loads the plugin: messaging
gateways, the CLI and TUI, cron. They do nothing unless the person turns on Settings > Pet Room >
Live steps from Hermes outside Herald, which needs Show Hermes work outside Herald on as well. Until
then a hook reads a cached answer and returns: nothing is queued and no thread starts.

A running Herald OS with live steps on writes `$HERMES_HOME/herald-os/observe/<pid>.json` (0600, in a
0700 folder) with the path of its control socket and a token that lets a process report activity and
nothing else. It rewrites the file without them when the setting goes off and removes it when it
quits. A Hermes process looks in that folder, and in the root home's when it runs a profile, at most
every two seconds while its hooks fire, and trusts a file only when this user owns it and nobody else
can read it.

Each event is a kind (a session, a tool call, a helper or an approval wait starting or ending),
Hermes's session id and a helper's own, the tool's name, a target cut to a file or folder name or a
web host, an opaque id pairing a start with its end, a status from a fixed list, where the session
runs (`telegram`, `cli`) and when the hook fired. Never chat or file content, the rest of a tool's
arguments, a terminal command, results or errors, a helper's goal or summary, what an approval asks,
or what Hermes thinks. The hooks only append to a bounded queue and a background thread sends it in
batches over the socket, so a slow or absent Herald OS never holds Hermes up.

Herald OS's own sessions are left out, and the backend Herald OS starts registers none of these
hooks: the Pet Room already sees that work through its gateway.
