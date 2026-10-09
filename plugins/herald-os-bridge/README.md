# herald-os-bridge

The Hermes plugin that lets Hermes act on the computer and drive the Herald OS interface. It is a
regular out-of-tree plugin: Hermes loads it from `$HERMES_HOME/plugins/herald-os-bridge`, a link
`npm run bootstrap` creates to this folder. Nothing in the Hermes core is patched.

Tools, permission tiers, protected paths, the policy file and the audit log are documented in
[docs/SYSTEM-BRIDGE.md](../../docs/SYSTEM-BRIDGE.md).

```
__init__.py          register(): the `herald_os` toolset and the bundled skills (SKILLS)
plugin.yaml          manifest: name, version, tools, supported platforms
bridge/
  tools.py           tool schemas and handlers (TOOL_SPECS)
  scope.py           where the tools are offered and run: Herald OS sessions only
  permissions.py     tiers, protected paths, the approval gate
  audit.py           one JSON line per call in $HERMES_HOME/herald-os/audit.jsonl
  crash.py           crash report summaries for system_logs (macOS .ips, Linux core dumps)
  documents.py       system_documents: invoice hints, suggested names, scan pictures, filing places
  ui.py              client for the shell's control socket (the `os_ui`, `canvas`, `docs` and `sheets` tools)
  util.py            shared helpers (data folder, HERALD_OS_* settings)
  host/              HostAdapter per OS: darwin.py, linux.py, posix.py, windows.py (stub)
skills/
  herald-os/         when to use these tools
  diagnose-crash/    how to explain a crash from its report
  file-documents/    how to find, read, rename and file documents such as invoices, with undo
  herald-os-tailor/  how to change Herald OS itself: themes, fonts, keybindings, settings
  herald-canvas/     how to make and edit pictures with the canvas tool: workflow, design habits, .comp format
  herald-docs/       how to write and edit documents with the docs tool: drafts, marked text, formatting, saving
  herald-sheets/     how to work in spreadsheets with the sheets tool: formulas, cleaning data, building workbooks
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
