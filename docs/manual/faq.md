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

**How is this different from Omarchy?**
Omarchy makes Linux something your coding agent can fix and reshape. Herald OS makes the agent how
you use the computer, for everyone, and it asks before it changes anything. It also runs on the Mac
you already have, and Herald OS can run as an app on Arch Linux and Omarchy.

**How do I update?**
On a Mac, `git pull` and `npm run bootstrap` in your checkout; Hermes updates itself with
`hermes update`. On Herald OS Linux, the menu's Update, or `herald-os update`.
