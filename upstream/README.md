# upstream/

Herald OS builds on [Hermes Agent](https://github.com/NousResearch/hermes-agent) without forking
it. Two different things come from upstream:

- **The runtime** (Python: `hermes serve`, tools, memory, sessions) is the user's own Hermes
  install, normally `~/.hermes/hermes-agent`, updated with `hermes update`. Nothing in this repo
  replaces it.
- **The TypeScript gateway client** (`apps/shared/src` upstream) is compiled into the shell from a
  pinned snapshot, so the wire contract only changes when we choose.

`UPSTREAM.lock` pins that snapshot to one commit. `npm run sync-upstream` (also run by
`npm run bootstrap`) downloads it into `upstream/hermes-agent/`, which is gitignored.

Herald OS Linux also installs the runtime from that commit on the first boot: the image's build
(`linux/image/packages.sh`) and the development VM's seed (`linux/vm/make-seed.sh`) write it to
`/etc/herald-os/ref` as `HERMES_REF=<sha>`, and both stop when `sha=` is not one full commit id.
After that first install, `hermes update` is what moves it.

To move to a newer upstream: edit `sha=` in `UPSTREAM.lock`, run `npm run sync-upstream`, then
`npm run typecheck`. Type errors show exactly where the contract changed.
