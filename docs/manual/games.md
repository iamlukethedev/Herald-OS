# Games

Herald OS Linux installs the usual Linux game stores and launchers in one step, from Settings >
Software > Gaming, Install in the `Super+M` menu, or "install Steam".

| App | What it is for | Needs |
| --- | --- | --- |
| Steam | Valve's store, with Proton to run Windows games | An x86_64 PC |
| Lutris | One library for games from every store and emulator | An x86_64 PC |
| Heroic | Epic, GOG and Amazon games | An x86_64 PC |
| RetroArch | Emulators for classic consoles in one app | |
| Prism Launcher | Minecraft, with mods and several instances | |
| Moonlight | Stream games from your gaming PC | |
| GeForce NOW | NVIDIA's cloud gaming, as a web app | |
| Xbox Cloud Gaming | Xbox games streamed, as a web app | |

They install as Flatpaks from Flathub (the two cloud services as [web apps](web-apps.md)), so they
update with the rest of the system. On an ARM machine, or in the Apple Silicon virtual machine, the
x86_64-only ones are marked unavailable and say why.

## Good to know

- **Proton** runs most Windows games on Steam: in Steam's Settings > Compatibility, turn on Steam
  Play for all titles. [ProtonDB](https://www.protondb.com) says how well a game runs.
- **Controllers:** Steam supports most controllers through Steam Input. Pair a Bluetooth controller
  in the Bluetooth panel (`Super+Ctrl+B`).
- **Fullscreen:** a game that goes fullscreen covers the menu bar and Dock; `Super+Shift+F` toggles
  it for any window.
- **Stay awake** (`Super+Ctrl+I`) stops the screen from locking during a long cutscene or a game you
  play with a controller.
- **Graphics drivers:** Herald OS Linux comes with Fedora's open-source drivers, which cover AMD and
  Intel graphics. There is no image with NVIDIA's own driver yet
  ([#62](https://github.com/iamlukethedev/Herald-OS/issues/62)).
- Games that need anti-cheat software made only for Windows may not run on Linux at all, and the
  [Windows VM](windows-vm.md) has no graphics acceleration for games.
