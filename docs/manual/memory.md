# Memory

Hermes remembers what matters to you between conversations: your preferences, your projects, the
people in your life, and facts you have told it. The Memory page (`Cmd+4` on a Mac, `Ctrl+4` on
Linux) shows what it knows, and why.

## Adding a memory

- Say or type "remember that my sister's birthday is in May".
- Or press **Add memory** on the Memory page, write it, choose whether it is **Hermes memory** (what
  Hermes should know) or **About you**, and press **Save**.
- Hermes also saves memories on its own when you tell it something worth keeping; they show up here.

## Finding, changing and forgetting

Search ("Search your memory…") or filter by Preferences, Projects, People and Knowledge. Open a
memory to **Edit memory**, or **Forget** it, which asks to make sure. Or just say "forget that I live
in Sydney".

## Where it is kept

Memories are plain text files in your Hermes home: `~/.hermes/memories/MEMORY.md` for Hermes's own
notes and `~/.hermes/memories/USER.md` for what it knows about you. They stay on your computer, and
are sent to your model provider as part of a conversation, so Hermes can use them. Hermes Desktop
and the `hermes` command line use the same files.

Herald and Hermes take turns with these files, the same way Hermes's own sessions do, so a memory
Hermes saves while you add or edit one is kept. If Hermes is busy with a file for more than ten
seconds, Herald says so and changes nothing; try again in a moment.

Each [bot](README.md#talking-to-your-other-bots) has its own memory.
