# Coding agents and local models

Hermes builds software with you in [Studio](studio.md), but you may also want the coding agents you
already know, or a model that runs on your own computer. Both install in one step from Settings >
Software > AI, on Herald OS Linux and on a Mac.

## Coding agents

Claude Code, Codex, OpenCode, Gemini CLI and Copilot CLI run in the terminal. Install one, then open
it from the Terminal (`Super+Return` on Linux, `Cmd+8` on a Mac): the arrow next to `+` opens a new
tab with any agent you installed. **Open** in Settings > Software does the same. Each signs in with
its own account the first time.

On Linux they install through npm into your home folder (`~/.local`), so they need no administrator
password and work on the Herald OS image. `herald-os install claude-code` does it from a terminal.

The languages they work with (Node, Python, Go, Rust, Ruby and Rails, PHP and Laravel and more) are
in the Developer group, installed through [mise](https://mise.jdx.dev) where they can be.

## Local models

A local model runs on your computer: nothing you say leaves it, and nothing is billed per message.
It needs a capable machine (plenty of memory, and ideally a graphics card), and is slower and less
capable than the large hosted models.

- **Ollama** runs models in the background. On Linux it installs into your home folder and serves on
  `127.0.0.1:11434`, only to this computer. Download a model from a terminal, for example
  `ollama pull llama3.2` (the [Ollama library](https://ollama.com/library) lists them).
- **LM Studio** is an app for finding, downloading and running models. On a Mac it installs through
  Homebrew; on Linux, Settings > Software opens its download page. Start its local server from
  inside the app.

## Using one with Hermes

Once Ollama or LM Studio has a model, **Use with Hermes** beside it in Settings > Software lists its
models; choose one, and Hermes uses it from then on, the conversation on screen included. Switch back
to your usual provider in Settings > Hermes & agents > Model provider.

Hermes leans on its tools and long instructions, so a small local model may struggle with bigger
tasks; try a larger one if answers go astray.
