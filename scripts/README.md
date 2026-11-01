# scripts/

Run these from the repository root; the common ones have npm aliases.

| Script | npm alias | What it does |
| --- | --- | --- |
| `bootstrap.sh` | `npm run bootstrap` | One-time setup, safe to re-run after every pull: fetches the upstream snapshot, installs npm packages, links and enables the bridge plugin in your Hermes install, migrates settings from the pre-rename Hermes OS, checks voice prerequisites |
| `sync-upstream.sh` | `npm run sync-upstream` | Downloads the Hermes Agent commit pinned in `upstream/UPSTREAM.lock` into `upstream/hermes-agent/` |
| `sync-agent-desktop.sh <sha>` | | Moves desktop control's vendored source (`third_party/agent-desktop`) to another upstream revision: copies the Linux parts, re-applies `patches/`, trims the lock, re-vendors the crates and builds offline |
| `test-bridge.sh` | `npm run test:bridge` | Runs the bridge plugin's pytest suite |
| `check-secrets.sh` | | Scans the working tree and the whole git history for committed credentials with gitleaks |
| `migrate-hermes-config.py` | | Renames the plugin, toolset and saved approvals in `~/.hermes/config.yaml` from Hermes OS to Herald OS (bootstrap runs it) |
| `make-icons.py` | | Regenerates the app, favicon and boot-splash icons from the master Herald mark (needs Pillow; macOS for the `.icns`) |
