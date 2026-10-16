# Security policy

Herald OS lets an AI agent operate your computer, so security reports matter. Thank you for taking
the time to send one.

## Reporting a vulnerability

Report privately on GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. Please do not open a public issue, discussion, or pull request for a
vulnerability. If private reporting is unavailable, open an issue that only asks for a private
contact, without details.

A useful report says what an attacker controls (a web page, a file, a model response, another
local user), what they gain, and how to reproduce it. Expect a first reply within a week.

Herald OS is pre-1.0. Only the latest `main` is supported, and fixes land there.

Vulnerabilities in Hermes Agent itself (the `hermes` runtime, its tools, providers, or gateway)
belong upstream: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

## Security model

These are the guarantees Herald OS aims for. Breaking one of them is a vulnerability.

- **Desktop tools are gated.** The agent's desktop tools come from the `herald-os-bridge` plugin,
  and each has a tier. `read` and `act` tools run immediately and are logged; `mutate` tools need
  your approval; `destructive` tools need approval on every call. Protected paths (`~/.ssh`,
  `~/.gnupg`, keychains, browser cookies, `$HERMES_HOME/.env`, `$HERMES_HOME/auth.json`, system
  folders) are refused before any prompt. Every call is appended to
  `$HERMES_HOME/herald-os/audit.jsonl`. See [docs/SYSTEM-BRIDGE.md](docs/SYSTEM-BRIDGE.md).
- **The backend is local.** `hermes serve` listens on 127.0.0.1 only, behind a random token that
  changes on every launch. The Electron main process adds the token to REST calls.
- **The control socket is private.** The socket the agent uses to operate the interface (the
  `os_ui` tool) is readable only by your user (mode 0600) and refuses requests without a
  per-launch token. On Linux it also accepts the `herald-os` commands that the compositor's
  hotkeys run.
- **Shell windows stay on the shell.** They run with context isolation, the Chromium sandbox and
  no Node integration, and reach the system only through the preload API. They cannot navigate
  to any page but the shell's own, so a dropped file or a link cannot gain that API. Links open in
  your browser, and only http(s) links open at all. Only the shell may use the microphone. What
  they read through that API (listings, previews, thumbnails, `exists`, watches) stays in the home
  folder, the Hermes home and the temporary folders, judged after symlinks resolve, and never
  reaches a credential store: `~/.ssh`, `~/.gnupg`, `~/.aws`, keychains, and `.env` files and
  `auth.json` in the Hermes home, among others.
- **Web content is contained.** Web windows, file viewers and the Studio preview have no preload,
  run in their own storage partitions, are denied every permission, cannot download files and
  cannot open pop-ups. The Studio preview loads web pages and files inside the project folder,
  nothing else. A local page reads only what is open for viewing: a page in a viewer, the files
  open in viewers; a preview, the project folders being previewed. Paths are judged after symlinks
  resolve, and anything else, such as `~/.hermes/.env`, looks missing.
- **No credentials in the repository.** API keys and logins live in `~/.hermes`, managed by
  Hermes. CI scans the full history with [gitleaks](https://github.com/gitleaks/gitleaks); run
  `bash scripts/check-secrets.sh` to do the same locally.

## In scope

- A bridge tool that skips its tier, its approval, the protected-path check, or the audit log.
- Reaching the control socket, the backend, or the preload API from a web page, a file, a model
  response, or another user on the machine.
- Escaping a web window, viewer or preview into the shell.
- A page in a viewer or preview reading local files that are not open in a viewer or preview.
- Credentials leaking into logs, the audit log, the repository, or a built app.
- The Linux session or provisioning scripts doing something unsafe as root.

## Out of scope

- What the agent does with permissions you grant: approving a destructive call, turning approvals
  off, or yolo mode. Hermes's own terminal tool follows Hermes's approval settings.
- Attacks that already require running code as your user.
- Gatekeeper warnings on unsigned builds.
