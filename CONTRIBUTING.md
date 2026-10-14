# Contributing to Herald OS

Thanks for helping. This page covers getting a working setup, the checks a change must pass, and
the conventions the code follows.

## Set up

You need macOS 13 or later on Apple Silicon (or Herald OS Linux, see
[linux/README.md](linux/README.md)), Node 22.12 or later, and Hermes Agent installed and signed in.
Then:

```bash
git clone https://github.com/iamlukethedev/Herald-OS.git
cd Herald-OS
npm run bootstrap
npm run dev
```

The [README](README.md) walks through each step and the usual problems.

## Where things are

| Folder | Contents |
| --- | --- |
| `apps/desktop` | The shell: Electron main, preload, and the React renderer |
| `packages/hermes-client` | Typed client for the Hermes gateway (JSON-RPC over WebSocket, REST) |
| `plugins/herald-os-bridge` | Hermes plugin with the desktop tools, permission tiers and audit log |
| `linux` | Herald OS Linux: session, compositor config, provisioning, VM tooling |
| `scripts` | Bootstrap, upstream sync, bridge tests, secret scan |
| `upstream` | The pinned Hermes Agent version the shell is built against |
| `docs` | Architecture, decisions, the bridge, voice, Linux |

[apps/desktop/README.md](apps/desktop/README.md) maps the shell's folders and says where common
changes go: a new page, a new command, a native capability.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:bridge          # when plugins/ changed
bash scripts/check-secrets.sh
```

`npm run test:bridge` uses the Hermes runtime's Python when it has pytest, otherwise
[uv](https://docs.astral.sh/uv/). The secret scan needs [gitleaks](https://github.com/gitleaks/gitleaks)
(`brew install gitleaks`) or Docker.

CI runs the same checks on Ubuntu and macOS, parses every script, and scans the full history for
secrets. For UI changes, run the shell and add a screenshot to the pull request.

## Conventions

- Match the code around you: naming, file layout, and how much it comments.
- Comments state constraints the code cannot show, as complete sentences ending with a period.
  They don't narrate what the next line does.
- Styling uses the design tokens in `apps/desktop/src/styles.css`, never literal colours.
  [DESIGN.md](apps/desktop/DESIGN.md) has the layout model and the rules for pages.
- Every user-visible action registers an `OsCommand`, so the command bar, voice and Hermes can all
  reach it.
- Text people read comes from the translation catalogs in `apps/desktop/shared/locales/`, English
  first. [docs/TRANSLATING.md](docs/TRANSLATING.md) says how, and how to translate Herald OS into
  your language.
- The renderer never touches Node or spawns processes. Native work goes through a `HostPlatform`
  method, an IPC handler and the preload bridge.
- Herald OS does not patch Hermes Agent. When the shell needs something upstream lacks, use its
  public surfaces (gateway, REST, plugins, config) or propose the change upstream.
- Decisions with lasting consequences get an entry in [docs/DECISIONS.md](docs/DECISIONS.md).

## Updating Hermes Agent

The runtime is each user's own Hermes install, updated with `hermes update`. The shell compiles
Hermes's TypeScript gateway client from a pinned snapshot: to move it, edit `sha=` in
`upstream/UPSTREAM.lock`, run `npm run sync-upstream`, then `npm run typecheck`. See
[upstream/README.md](upstream/README.md).

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), never in issues or
pull requests.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
