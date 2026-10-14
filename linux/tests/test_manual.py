"""The manual (docs/manual) against the code: chapters, links, `herald-os` commands and hotkeys."""

import importlib.machinery
import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MANUAL = ROOT / "docs" / "manual"
CHAPTERS = sorted(MANUAL.glob("*.md"))
# Pages outside the manual that link into it.
LINKING_PAGES = [*CHAPTERS, ROOT / "docs" / "LINUX.md", ROOT / "README.md"]

_LOADER = importlib.machinery.SourceFileLoader("herald_os_cli_manual", str(ROOT / "linux" / "bin" / "herald-os"))
_SPEC = importlib.util.spec_from_loader("herald_os_cli_manual", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
COMMAND = re.compile(r"(?<![\w/-])herald-os ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def prose(text: str) -> str:
    """The text with fenced code blocks blanked, so a `#` comment in a block is not a heading."""
    out, fenced = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            out.append("")
            continue
        out.append("" if fenced else line)
    return "\n".join(out)


def slug(heading: str) -> str:
    """GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = text.replace("`", "").strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(page: Path) -> set[str]:
    seen: dict[str, int] = {}
    out = set()
    for line in prose(page.read_text()).splitlines():
        match = HEADING.match(line)
        if not match:
            continue
        base = slug(match.group(2))
        count = seen.get(base, 0)
        seen[base] = count + 1
        out.add(base if count == 0 else f"{base}-{count}")
    return out


def niri_binds() -> set[str]:
    config = (ROOT / "linux" / "niri" / "config.kdl").read_text()
    body = config[config.index("\nbinds {"):]
    body = body[: body.index("\n}")]
    return {normalise(line.split()[0]) for line in body.splitlines()[1:] if line.strip() and not line.strip().startswith("//")}


MODIFIERS = {"mod": "Super", "super": "Super", "ctrl": "Ctrl", "shift": "Shift", "alt": "Alt"}
KEY_NAMES = {",": "Comma", "`": "Grave", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "page up": "Page_Up", "page down": "Page_Down"}


def normalise(combo: str) -> str:
    """`Super+Ctrl+,`, `Mod+Ctrl+Comma` and `SUPER + CTRL + Comma` all become `Ctrl+Super+Comma`."""
    parts = [part.strip() for part in re.split(r"\s*\+\s*(?=.)", combo.strip())]
    *mods, key = parts
    key = KEY_NAMES.get(key.lower(), key)
    key = key.upper() if len(key) == 1 else key[0].upper() + key[1:]
    return "+".join(sorted(MODIFIERS[mod.lower()] for mod in mods) + [key])


def omarchy_binds() -> set[str]:
    """Keys `herald-os omarchy install` writes into Hyprland, and the ones `keymap omarchy` adds to niri."""
    hyprland = {normalise(combo) for combo in re.findall(r'o\.bind\("([^"]+)"', cli.HYPR_LUA_BINDS)}
    keymap = {normalise(key) for key in (*cli.OMARCHY_BINDS, *cli.OMARCHY_MOVES.values())}
    return hyprland | keymap


def manual_hotkeys(page: Path) -> list[str]:
    found = []
    for line in prose(page.read_text()).splitlines():
        for _, span in CODE_SPAN.findall(line):
            span = span.strip()
            if not span.startswith("Super+"):
                continue
            # "`Super+Shift` with the same keys" names modifiers only.
            if span.split("+")[-1].lower() in MODIFIERS:
                continue
            found.append(span)
    return found


def test_the_manual_lists_every_chapter_and_every_listed_chapter_exists():
    index = MANUAL / "README.md"
    listed = {target.split("#")[0] for target in LINK.findall(prose(index.read_text())) if not re.match(r"[a-z]+:", target)}
    listed = {name for name in listed if name.endswith(".md") and "/" not in name}
    chapters = {page.name for page in CHAPTERS} - {"README.md"}
    assert chapters - listed == set(), "chapters missing from docs/manual/README.md"
    assert listed - chapters == set(), "docs/manual/README.md lists chapters that do not exist"


def test_the_chapters_issue_39_asks_for_exist():
    wanted = {
        "install-pc.md", "install-mac.md", "virtual-machine.md", "setup-and-reset.md", "unattended-installs.md",
        "coming-from-windows.md", "windows-and-spaces.md",
        "menu-bar.md", "notifications.md", "clipboard.md", "capture.md", "dictation-and-emoji.md", "reminders.md", "lock-and-idle.md",
        "talking-to-hermes.md", "missions.md", "memory.md", "automations.md", "connections.md", "studio.md", "usage.md", "privacy.md", "crash-help.md",
        "installing-software.md", "web-apps.md", "games.md", "windows-vm.md", "coding-agents.md", "canvas.md",
        "updates.md", "security.md", "command-line.md", "omarchy.md", "other-linux.md",
        "troubleshooting.md", "faq.md",
    }
    assert wanted - {page.name for page in CHAPTERS} == set()


@pytest.mark.parametrize("page", LINKING_PAGES, ids=lambda page: str(page.relative_to(ROOT)))
def test_relative_links_and_their_anchors_resolve(page):
    broken = []
    for target in LINK.findall(prose(page.read_text())):
        if re.match(r"[a-z]+:", target):
            continue
        path, _, anchor = target.partition("#")
        resolved = (page.parent / path).resolve() if path else page
        if not resolved.exists():
            broken.append(f"{target}: no such file")
            continue
        if anchor and resolved.suffix == ".md" and anchor not in anchors(resolved):
            broken.append(f"{target}: no heading #{anchor}")
    assert broken == []


def test_slugs_follow_github():
    assert slug("The `herald-os` command line") == "the-herald-os-command-line"
    assert slug("Inside Hyprland and Omarchy (app mode)") == "inside-hyprland-and-omarchy-app-mode"
    assert slug("Arch Linux (and Omarchy)") == "arch-linux-and-omarchy"
    assert slug("Setting it up for someone else, and reset") == "setting-it-up-for-someone-else-and-reset"


def test_every_herald_os_command_in_the_manual_exists():
    choices = {
        "page": set(cli.COMMANDS["page"].split(": ", 1)[1].split()),
        "panel": set(re.search(r"panel ([\w|]+)", cli.COMMANDS["panel"]).group(1).split("|")),
        "toggle": set(re.search(r"toggle ([\w|]+)", cli.COMMANDS["toggle"]).group(1).split("|")),
        "restart": set(re.search(r"restart ([\w|]+)", cli.COMMANDS["restart"]).group(1).split("|")),
    }
    unknown = []
    for page in CHAPTERS:
        for command, argument in COMMAND.findall(page.read_text()):
            if command not in cli.COMMANDS:
                unknown.append(f"{page.name}: herald-os {command}")
            elif command in choices and argument and argument not in choices[command]:
                unknown.append(f"{page.name}: herald-os {command} {argument}")
    assert unknown == []


FLAG = re.compile(r"(?<![\w-])--[a-z][a-z0-9-]*")
# Commands the CLI hands to herald-os-catalog, which parses options of its own.
CATALOG_COMMANDS = {"install", "remove", "catalog", "windows"}


def code_segments(text: str) -> list[str]:
    """Each inline code span, and each line of a fenced block without its trailing `# comment`."""
    out, fenced = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            out.append(re.split(r"\s#\s", line, maxsplit=1)[0])
        else:
            out.extend(span for _, span in CODE_SPAN.findall(line))
    return out


def command_flags(segment: str) -> list[tuple[str, str]]:
    """(command, --flag) for each flag that follows a `herald-os <command>` on the same command line."""
    out = []
    for match in COMMAND.finditer(segment):
        rest = re.split(r"&&|;|\||\\\|", segment[match.end():], maxsplit=1)[0]
        out.extend((match.group(1), flag) for flag in FLAG.findall(rest))
    return out


def catalog_flags() -> set[str]:
    return set(re.findall(r'"(--[a-z][a-z0-9-]*)"', (ROOT / "linux" / "bin" / "herald-os-catalog").read_text()))


def test_every_flag_the_manual_gives_a_command_is_in_its_help():
    from_catalog = catalog_flags()
    unknown = []
    for page in CHAPTERS:
        for segment in code_segments(page.read_text()):
            for command, flag in command_flags(segment):
                if command not in cli.COMMANDS:
                    continue
                known = set(FLAG.findall(cli.COMMANDS[command]))
                if command in CATALOG_COMMANDS:
                    known |= from_catalog
                if flag not in known:
                    unknown.append(f"{page.name}: herald-os {command} {flag}")
    assert unknown == []


def test_flags_are_read_per_command_line():
    assert command_flags("herald-os update --check") == [("update", "--check")]
    assert command_flags("herald-os weather location --set Melbourne") == [("weather", "--set")]
    assert command_flags("herald-os setup && makepkg --skipchecksums") == []
    assert command_flags("herald-os-tarball install --force") == []
    assert {"--purge", "--group", "--json"} <= catalog_flags()
    found = {pair for page in CHAPTERS for segment in code_segments(page.read_text()) for pair in command_flags(segment)}
    assert {("update", "--check"), ("windows", "--purge"), ("capture", "--edit"), ("setup", "--undo"), ("weather", "--set")} <= found


def test_the_manual_names_commands_the_cli_has():
    assert {"page", "panel", "toggle", "omarchy", "keymap"} <= set(cli.COMMANDS)
    found = {command for page in CHAPTERS for command, _ in COMMAND.findall(page.read_text())}
    assert {"update", "rollback", "channel", "reset", "install", "windows", "omarchy", "restart"} <= found


def test_every_linux_hotkey_in_the_manual_is_bound():
    bound = niri_binds() | omarchy_binds()
    missing = [f"{page.name}: {combo}" for page in CHAPTERS for combo in manual_hotkeys(page) if normalise(combo) not in bound]
    assert missing == []


def test_hotkey_names_normalise():
    assert normalise("Super+Ctrl+,") == normalise("Mod+Ctrl+Comma")
    assert normalise("Super+`") == normalise("Mod+Grave")
    assert normalise("Super+[") == normalise("Mod+BracketLeft")
    assert normalise("Super+Page Down") == normalise("Mod+Page_Down")
    assert normalise("SUPER + ALT + H") == normalise("Super+Alt+H")
    assert normalise("Super+Shift+Space") != normalise("Super+Space")
    assert "Ctrl+Super+X" in niri_binds()
    assert normalise("Super+Alt+M") in omarchy_binds()
    assert normalise("Super+Shift+V") in omarchy_binds()
