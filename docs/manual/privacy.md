# Privacy and the audit log

Hermes can see and change a lot on your computer, so Herald OS puts you in charge of what it may do,
and writes down what it did. Settings > Privacy has all of it.

## What reaches the model

Your model provider sees what is in a conversation: what you type or say, files you or Hermes put
in it, and what Hermes's tools return. Hermes reads a file when a task needs it, through tools you
can see in the chat and in the audit log. Nothing else on the computer is sent. Text recognised in
scans and on screen is read on this computer.

## Permission tiers

Herald OS's system tools each belong to a tier:

| Tier | Examples | What happens |
| --- | --- | --- |
| read | System information, searching for files | Runs straight away, and is logged |
| act | Opening an app or a page | Runs straight away, and is logged |
| mutate | Creating, moving or renaming files | Asks first; you can allow it for the session or always |
| destructive | Moving files to the Trash, stopping a program | Asks every time |

Herald OS never deletes anything permanently; the Trash is as far as it goes. Some places are always
refused, whatever you allow: `~/.ssh`, your keychains and Hermes's own credentials.

**Permission policy** in Settings > Privacy shows the policy as text, which you can change and
**Save policy** (or **Revert**): for example `mutate: allow` to stop being asked about moves.
**Protected paths** adds folders of your own that are always refused. The policy is kept in
`~/.hermes/herald-os/permissions.yaml`.

Hermes's own terminal tool, which runs shell commands, follows Hermes's approval settings rather than
these tiers.

## The audit log

Every system action Hermes takes is written to `~/.hermes/herald-os/audit.jsonl`: what it was, when,
its tier, and whether you allowed it. Settings > Privacy > Audit > **View log** shows the latest
entries, and **Refresh** brings it up to date.

## Pick up where you left off

The Overview can suggest where to pick up your work. It is off until you turn it on. It looks at the
names and dates of your recent files and folders, project branches and commit messages, conversation
titles, today's event titles and open apps, never file contents, window titles or the screen, and
sends them to your model provider to write the suggestions.

In Settings > Privacy > Pick up where you left off, turn it off, add folders and words it must never
look at (**Add folder…**, **Add word**), such as a client's name, or **Forget suggestions**.

## Voice and the microphone

The microphone is never opened while voice is off. The wake word, when you turn it on, is listened
for on this computer, and nothing is sent until you speak to Hermes. What you say then goes to your
speech-to-text provider.

## Your data

Herald OS's settings, the policy and the audit log are in `~/.hermes/herald-os/`; Hermes's
conversations, memories and credentials are in `~/.hermes/`, managed by Hermes. Clipboard history
on Linux stays on the computer ([Clipboard history](clipboard.md)).
