# FAQ

**Does Herald OS send my files to the AI?**
Only what you or Hermes put in a conversation. Hermes reads a file when a task needs it, through
tools you can see in the chat and in the audit log. "Pick up where you left off" sends names and
dates (file names, project branches, chat titles), never contents, and only after you turn it on.

**Which AI model does it use?**
Whatever your Hermes is set up with: a Nous Portal subscription, or an API key for OpenRouter,
OpenAI, Anthropic, a local model and others. Change it in Settings > Hermes & agents: Model provider
signs you in to another account or takes an API key, and Preferred model picks the model.
`hermes model` does the same in a terminal. A custom endpoint you set up in Hermes, with
`hermes model` or in Hermes Desktop, is in the list too. When its entry in Hermes's config.yaml
names a key variable (`key_env`), Model provider takes and replaces its key, and Hermes keeps it in
`~/.hermes/.env`, which Herald OS, Hermes Desktop and the `hermes` CLI share.

**Can I talk to my other Hermes bots?**
Yes. Each Hermes profile is a bot with its own memory, skills and model, and the Hermes page and
the Overview start a conversation with whichever you choose; see
[Talking to your other bots](README.md#talking-to-your-other-bots).

**What does it cost?**
Herald OS is free and open source. The model is billed by its provider; Settings > Usage shows how
much Hermes has used this week and this month, and what is left on a Nous Portal plan.

**Can it break my computer?**
Anything that changes something asks first; moving files to the Trash and stopping programs ask
every time, and Herald OS never deletes permanently. Keep backups of anything you let an agent touch,
as with any software that acts on your behalf.

**Do I have to use voice?**
No. Everything works from the keyboard, and the microphone is never opened unless voice is on.

**Can I use my own themes, keyboard shortcuts and scripts?**
Yes: see [Make it yours](make-it-yours.md).

**Do I need a server?**
No. Herald OS starts its own Hermes on the same computer, and that is all it needs besides a model
provider. It does not connect to a Hermes on another machine: `HERALD_OS_BACKEND_URL` takes only an
`http://` address on this computer, because the session token would travel unencrypted
([coexist.ts](../../apps/desktop/electron/backend/coexist.ts)); an SSH tunnel can make a distant
Hermes look local ([docs/LINUX.md](../LINUX.md#inside-hyprland-and-omarchy-app-mode)). A Hermes you
already run on a server can keep running there, for example for messaging.

**Which Linux distributions does it run on?**
Herald OS Linux, the whole system with Fedora underneath, installs from the ISO on x86_64 PCs. On
Arch Linux and Omarchy the Arch package gives you the full session or Herald OS as an app, and on
other Linux the release tarball runs it as an app inside your Wayland desktop. Window integration and
some tools need niri or Hyprland so far; GNOME and KDE are tracked in
[#20](https://github.com/iamlukethedev/Herald-OS/issues/20). [Arch and other Linux](other-linux.md)
has the details.

Fedora Silverblue, Kinoite, Bazzite, Bluefin and other bootc systems can also switch to the Herald
OS image in place, which replaces the system you run, so try it on a spare machine or in a virtual
machine. Afterwards a login screen asks who signs in, and your own account and its password keep
working; run `herald-os setup` once in your own account to install Hermes Agent there. Herald OS
also adds a `hermes` account, which stays locked until you give it a password
(`sudo passwd hermes`), and becomes an administrator only at the next restart after that. The
exception is a system where no existing account can sign in with a password: there `hermes` signs
in by itself, without a password but outside the administrators, and the first-start setup asks
for one; it becomes an administrator at the next restart after it has one (see
[docs/LINUX.md](../LINUX.md#switching-a-bootc-system-to-herald-os)). If no login screen appears, press `Ctrl+Alt+F2` for a text console and sign in there; see
[Locked out of your account](troubleshooting.md#locked-out-of-your-account).
[docs/LINUX.md](../LINUX.md#switching-a-bootc-system-to-herald-os) has the steps, what changes and
how to go back.

**How is this different from Omarchy?**
Omarchy makes Linux something your coding agent can fix and reshape. Herald OS makes the agent how
you use the computer, for everyone, and it asks before it changes anything. It also runs on the Mac
you already have, and Herald OS can run as an app on Arch Linux and Omarchy.

**How is it different from Hermes on Omarchy?**
On Omarchy, Hermes is one of 15 coding tools you can pick as the default agent
([`omarchy-default-agent`](https://github.com/omacom/omarchy/blob/84cfb93959f4fe0bbb71de71593b36647d2ba78d/bin/omarchy-default-agent#L4)),
its install menu adds Hermes Desktop
([`omarchy-install-ai-hermes`](https://github.com/omacom/omarchy/blob/84cfb93959f4fe0bbb71de71593b36647d2ba78d/bin/omarchy-install-ai-hermes#L14-L17)),
and its key or menu starts the agent in a terminal with `--yolo`, so it does not stop to ask
([`omarchy-agent`](https://github.com/omacom/omarchy/blob/84cfb93959f4fe0bbb71de71593b36647d2ba78d/bin/omarchy-agent#L106-L111)).
Herald OS is the whole desktop built around Hermes, and asks before it changes anything. It also
runs inside Omarchy: see [Running inside Omarchy](omarchy.md).

**Does it support touchscreens?**
Not yet. Herald OS runs on touchscreen PCs, but there is no on-screen keyboard, some menus need a
right-click and some buttons only appear when a pointer hovers over them.
[#21](https://github.com/iamlukethedev/Herald-OS/issues/21) tracks the work.

**How do I update?**
On a Mac, download the new DMG and replace the app, or `git pull` and `npm run bootstrap` in your
checkout; Hermes updates itself with `hermes update`. On Herald OS Linux, the menu's Update, or
`herald-os update`. See
[Updates, channels and rollback](updates.md).
