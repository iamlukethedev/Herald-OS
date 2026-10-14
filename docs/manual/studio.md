# Studio

Studio is where you watch Hermes build software. Say "build a website for a hair salon", "make an
app that tracks my plants" or "make a game where you dodge asteroids", and Hermes makes a project
folder, writes the code there, and Studio opens to show it happening.

## What it shows

- **The files** of the project, as Hermes creates them.
- **The code** as it is written.
- **The commands** Hermes runs: installing packages, starting a development server, running tests.
- **A live preview** of the site or app, which updates as the code changes.

At the bottom, "Ask for a change, or just say it": type or say "make the header blue" or "add a
booking page", and Hermes carries on. **Stop** halts it. The project's conversation and the project
in an editor are a click away.

## Opening it again

"Show me the code", "show me what you're doing" or "open the studio" brings back the Studio of the
latest build. Each build also has its conversation on the Hermes page.

## Where projects go

Each build gets its own folder in `~/Projects`, or the folder you choose in Settings > General >
Projects folder. It is an ordinary folder: open it in VS Code or any editor, put it under git, and
keep working on it with or without Hermes.

## Good to know

- Building runs commands on your computer, in the project folder, through Hermes's terminal tool,
  which follows Hermes's own approval settings rather than Herald OS's permission tiers.
- Hermes needs whatever the project needs (Node, Python, Ruby …). Herald OS Linux installs those in
  one step from Settings > Software; see [Coding agents and local models](coding-agents.md).
