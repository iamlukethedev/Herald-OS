"""Desktop control: Hermes operates desktop apps on Herald OS Linux through the AT-SPI tree.

The ``desktop`` tool runs the vendored binary (``third_party/agent-desktop``, installed off PATH in
``/usr/libexec/herald-os``) with a fixed argv for each command. This module is the pure half:
it maps the tool's arguments to that argv, gives every command its permission tier, remembers the
elements of recent snapshots so an approval names what it acts on, and holds the ``pre_tool_call``
guard that keeps shell tools from running the binary past the tool's approvals.

Tiers: reading the tree, windows, apps and notifications is ``read``; acting in an app (click,
type, set-value, select, toggle, scroll, press, launch, focus, clipboard-set) is ``mutate``, and an
"always allow" covers one command in one app; a screenshot and reading the clipboard show Hermes
what is on screen or copied, so they ask the same way. Quitting an app, acting on or dismissing
notifications and clearing the clipboard are ``destructive``. A batch asks once, at its highest tier,
and its approval lists every step.
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .permissions import Tier, fingerprint
from .util import data_dir, os_env, truncate

BINARY = "agent-desktop"
HELPER = "agent-desktop-linux-clipboard-owner"
# The image's location, then the development VM's (linux/dev/build.sh).
INSTALL_DIRS = (Path("/usr/libexec/herald-os"), Path("/usr/local/libexec/herald-os"))

TIERS: dict[str, Tier] = {
    "snapshot": Tier.READ, "find": Tier.READ, "get": Tier.READ, "is": Tier.READ, "wait": Tier.READ,
    "list-apps": Tier.READ, "list-windows": Tier.READ, "list-displays": Tier.READ, "list-surfaces": Tier.READ,
    "list-notifications": Tier.READ, "status": Tier.READ, "permissions": Tier.READ, "version": Tier.READ,
    "click": Tier.MUTATE, "type": Tier.MUTATE, "set-value": Tier.MUTATE, "select": Tier.MUTATE,
    "toggle": Tier.MUTATE, "scroll": Tier.MUTATE, "press": Tier.MUTATE, "launch": Tier.MUTATE,
    "focus": Tier.MUTATE, "clipboard-set": Tier.MUTATE,
    # Read-only for the app, but they hand Hermes what is on screen or on the clipboard.
    "screenshot": Tier.MUTATE, "clipboard-get": Tier.MUTATE,
    "close-app": Tier.DESTRUCTIVE, "notification-action": Tier.DESTRUCTIVE, "dismiss-notification": Tier.DESTRUCTIVE,
    "dismiss-all-notifications": Tier.DESTRUCTIVE, "clipboard-clear": Tier.DESTRUCTIVE,
}
COMMANDS: tuple[str, ...] = (*TIERS, "batch")
_TIER_ORDER = (Tier.READ, Tier.ACT, Tier.MUTATE, Tier.DESTRUCTIVE)

BATCH_MAX = 20
SNAPSHOTS_KEPT = 8
ELEMENTS_PER_SNAPSHOT = 5000
TEXT_MAX = 10_000
CLIPBOARD_MAX = 100_000
NAME_MAX = 128
LABEL_MAX = 60
SURFACES = ("window", "focused", "menu", "menubar", "sheet", "popover", "alert", "desktop", "toolbar", "notification-center")
GET_PROPERTIES = ("text", "value", "title", "bounds", "role", "states")
IS_PROPERTIES = ("visible", "enabled", "checked", "focused", "expanded", "selected")
PREDICATES = ("exists", "enabled", "visible", "actionable")
DIRECTIONS = ("up", "down", "left", "right")

# Upstream's grammar (crates/core/src/refs): @<snapshot id>:e<N>.
_REF = re.compile(r"^@([A-Za-z0-9_-]{3,64}):e([1-9][0-9]{0,9})$")
_LOCAL_REF = re.compile(r"^@e[1-9][0-9]{0,9}$")
_WINDOW_ID = re.compile(r"^[A-Za-z0-9:._-]{1,64}$")
_ROLE = re.compile(r"^[a-z][a-z _-]{0,39}$")
_COMBO = re.compile(r"^[A-Za-z0-9]{1,12}(\+[A-Za-z0-9]{1,12}){0,4}$")
_SCOPE = re.compile(r"[^a-z0-9._-]+")
_PASSWORD_ROLES = ("password", "password text", "passwordtext", "password-text")


# ---------------------------------------------------------------------------------------------
# Elements from recent snapshots
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Element:
    ref: str
    role: str
    name: str
    app: str | None

    @property
    def secret(self) -> bool:
        return self.role.lower() in _PASSWORD_ROLES

    def describe(self) -> str:
        what = f"the {self.role} “{self.name}”" if self.name else f"an unnamed {self.role}"
        return f"{what} in {self.app}" if self.app else what


# Snapshot id -> its elements by ref, newest last.
_snapshots: OrderedDict[str, dict[str, Element]] = OrderedDict()


def clean(value: Any, limit: int = LABEL_MAX) -> str:
    """Text an app chose (a name, a title) made safe to show in an approval: one line, no control or
    format characters, no quotes that could pass for the prompt's own, cut to ``limit``."""
    if not isinstance(value, str):
        return ""
    text = "".join(" " if unicodedata.category(ch).startswith(("C", "Z")) else ch for ch in value)
    text = " ".join(text.replace("“", "'").replace("”", "'").replace('"', "'").split())
    return truncate(text, limit)


def _label(node: dict[str, Any]) -> str:
    return clean(node.get("name")) or clean(node.get("description"))


def _nodes(value: Any, depth: int = 0) -> Iterable[dict[str, Any]]:
    if depth > 200:
        return
    if isinstance(value, dict):
        if isinstance(value.get("ref_id"), str):
            yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from _nodes(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            yield from _nodes(child, depth + 1)


def remember(data: Any, app: str | None = None) -> int:
    """Keep the elements a snapshot or find returned (pure but for the cache; tested). The app is
    the one the result names, else the one the call asked for. Returns how many were kept."""
    if not isinstance(data, dict):
        return 0
    snapshot_id = data.get("snapshot_id") if isinstance(data.get("snapshot_id"), str) else None
    app = clean(data.get("app"), NAME_MAX) or (clean(app, NAME_MAX) or None)
    kept = 0
    for node in _nodes(data):
        ref = node["ref_id"]
        if snapshot_id and _LOCAL_REF.match(ref):
            ref = f"@{snapshot_id}:{ref[1:]}"
        match = _REF.match(ref)
        if not match:
            continue
        elements = _snapshots.setdefault(match.group(1), {})
        _snapshots.move_to_end(match.group(1))
        if len(elements) >= ELEMENTS_PER_SNAPSHOT:
            continue
        elements[ref] = Element(ref, clean(node.get("role"), 40) or "element", _label(node), app)
        kept += 1
    while len(_snapshots) > SNAPSHOTS_KEPT:
        _snapshots.popitem(last=False)
    return kept


def element(ref: str) -> Element | None:
    match = _REF.match(ref)
    return _snapshots.get(match.group(1), {}).get(ref) if match else None


def forget() -> None:
    _snapshots.clear()


# ---------------------------------------------------------------------------------------------
# Planning a call
# ---------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Step:
    command: str
    argv: tuple[str, ...]
    tier: Tier
    summary: str
    # What an "always allow" of a mutate step is limited to: the app, the clipboard, the screen.
    scope: str | None = None
    app: str | None = None
    output: Path | None = None
    audit: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Call:
    action: str
    tier: Tier
    summary: str
    scope: str | None
    steps: tuple[Step, ...]
    audit: dict[str, Any]


def scope_key(name: str | None) -> str:
    text = _SCOPE.sub("-", (name or "").strip().lower()).strip("-")
    return text[:64] or "unknown-app"


def highest(tiers: Iterable[Tier]) -> Tier:
    return max(tiers, key=_TIER_ORDER.index, default=Tier.READ)


def _ref(args: dict[str, Any], key: str = "ref") -> str:
    value = str(args.get(key) or "").strip()
    if not _REF.match(value):
        raise ValueError(f"{key} must be a ref from a snapshot, like @s8f3k2p9:e1 (got {truncate(value, 40) or 'nothing'})")
    return value


def _known(args: dict[str, Any], command: str) -> Element:
    """The element a mutate step acts on, from a snapshot this process took: the approval has to say what it is."""
    ref = _ref(args)
    found = element(ref)
    if found is None:
        raise ValueError(f"{command}: {ref} is not from a recent snapshot; take a snapshot (or find) with the desktop tool first and use a ref from it")
    return found


def _name(args: dict[str, Any], key: str, *, required: bool = False) -> str | None:
    value = args.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValueError(f"{key} is required for command={args.get('command')}")
        return None
    text = str(value).strip()
    if text.startswith("-") or len(text) > NAME_MAX or any(unicodedata.category(ch).startswith("C") for ch in text):
        raise ValueError(f"{key} must be a plain name of at most {NAME_MAX} characters that does not start with '-'")
    return text


def _text(args: dict[str, Any], key: str, limit: int, *, allow_empty: bool = False) -> str:
    value = args.get(key)
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    if not text and not allow_empty:
        raise ValueError(f"{key} is required for command={args.get('command')}")
    if len(text) > limit:
        raise ValueError(f"{key} is longer than {limit} characters")
    return text


def _int(args: dict[str, Any], key: str, default: int | None, lo: int, hi: int) -> int | None:
    value = args.get(key)
    if value is None or value == "":
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a whole number") from None
    if not lo <= number <= hi:
        raise ValueError(f"{key} must be between {lo} and {hi}")
    return number


def _choice(args: dict[str, Any], key: str, choices: tuple[str, ...], default: str | None) -> str | None:
    value = args.get(key)
    if value is None or value == "":
        return default
    text = str(value).strip().lower()
    if text not in choices:
        raise ValueError(f"{key} must be one of {', '.join(choices)}")
    return text


def _flag(args: dict[str, Any], key: str, default: bool) -> bool:
    value = args.get(key)
    return default if value is None else value is True or str(value).lower() in ("true", "1", "yes")


def _preview(text: str, secret: bool = False) -> str:
    if secret:
        return f"{len(text)} hidden characters"
    shown = clean(text, 80)
    return f"“{shown}” ({len(text)} characters)" if len(text) > 80 else f"“{shown}”"


def _redacted(args: dict[str, Any]) -> dict[str, Any]:
    """The arguments as the audit log keeps them: typed and copied text by its length only."""
    out = {key: value for key, value in args.items() if key not in ("text", "value", "steps")}
    for key in ("text", "value"):
        if isinstance(args.get(key), str):
            out[key] = f"[{len(args[key])} characters]"
    return out


def _screenshot_path() -> Path:
    return data_dir() / "desktop" / "screenshots" / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.png"


def plan_step(args: dict[str, Any]) -> Step:
    """One command's argv (after the binary), tier and approval summary (pure but for the element
    memory; tested). Raises ``ValueError`` for an unknown command or a bad argument."""
    if not isinstance(args, dict):
        raise ValueError("each step must be an object with a command")
    command = str(args.get("command") or "").strip()
    if command == "batch":
        raise ValueError("a batch step cannot be another batch")
    if command not in TIERS:
        raise ValueError(f"unknown command '{command}'")
    tier = TIERS[command]
    audit = {"command": command, **_redacted({k: v for k, v in args.items() if k != "command"})}

    def step(argv: list[str], summary: str, *, scope: str | None = None, app: str | None = None, output: Path | None = None) -> Step:
        return Step(command, tuple(argv), tier, summary, scope, app, output, audit)

    app = _name(args, "app")
    if command == "snapshot":
        argv = ["snapshot"]
        if app:
            argv.append(f"--app={app}")
        window = _name(args, "window_id")
        if window:
            if not _WINDOW_ID.match(window):
                raise ValueError("window_id must be an id from list-windows")
            argv.append(f"--window-id={window}")
        if args.get("root"):
            argv += ["--root", _ref(args, "root")]
        surface = _choice(args, "surface", SURFACES, None)
        if surface:
            argv.append(f"--surface={surface}")
        if _flag(args, "interactive_only", True):
            argv.append("--interactive-only")
        if _flag(args, "compact", True):
            argv.append("--compact")
        if _flag(args, "skeleton", False):
            argv.append("--skeleton")
        depth = _int(args, "max_depth", None, 1, 50)
        if depth:
            argv.append(f"--max-depth={depth}")
        return step(argv, f"read the accessibility tree of {app or 'the focused app'}", app=app)
    if command == "find":
        argv = ["find"]
        if app:
            argv.append(f"--app={app}")
        role = _name(args, "role")
        if role and not _ROLE.match(role):
            raise ValueError("role must be an accessibility role such as button, text field, check box")
        name, text = _name(args, "name"), _name(args, "text")
        if not (role or name or text):
            raise ValueError("find needs a role, a name or a text to look for")
        argv += [f"--role={role}"] * bool(role) + [f"--name={name}"] * bool(name) + [f"--text={text}"] * bool(text)
        if args.get("root"):
            argv += ["--root", _ref(args, "root")]
        if _flag(args, "first", False):
            argv.append("--first")
        else:
            argv.append(f"--limit={_int(args, 'limit', 50, 1, 200)}")
        return step(argv, f"look for elements in {app or 'the focused app'}", app=app)
    if command in ("get", "is"):
        ref = _ref(args)
        choices, default = (GET_PROPERTIES, "text") if command == "get" else (IS_PROPERTIES, "visible")
        prop = _choice(args, "property", choices, default)
        found = element(ref)
        return step([command, ref, f"--property={prop}"], f"read the {prop} of {found.describe() if found else ref}")
    if command == "wait":
        timeout = _int(args, "timeout_ms", 10_000, 100, 60_000)
        if args.get("ms") not in (None, ""):
            ms = _int(args, "ms", None, 1, 30_000)
            return step(["wait", str(ms)], f"wait {ms} ms")
        if args.get("ref"):
            argv = ["wait", f"--element={_ref(args)}", f"--timeout={timeout}"]
            predicate = _choice(args, "predicate", PREDICATES, None)
            if predicate:
                argv.append(f"--predicate={predicate}")
            return step(argv, "wait for an element")
        text, window = _name(args, "text"), _name(args, "window")
        if text:
            return step(["wait", f"--text={text}", *([f"--app={app}"] if app else []), f"--timeout={timeout}"], "wait for text to appear")
        if window:
            return step(["wait", f"--window={window}", f"--timeout={timeout}"], "wait for a window")
        raise ValueError("wait needs ms, a ref, a text or a window title")
    if command in ("list-apps", "list-windows", "list-surfaces"):
        return step([command, *([f"--app={app}"] if app else [])], f"list {command.removeprefix('list-')}")
    if command == "list-notifications":
        argv = ["list-notifications", *([f"--app={app}"] if app else [])]
        text = _name(args, "text")
        if text:
            argv.append(f"--text={text}")
        limit = _int(args, "limit", None, 1, 100)
        if limit:
            argv.append(f"--limit={limit}")
        return step(argv, "list notifications")
    if command in ("list-displays", "status", "permissions", "version"):
        return step([command], f"{command.replace('-', ' ')}")

    if command in ("click", "toggle"):
        target = _known(args, command)
        return step([command, target.ref], f"{command} {target.describe()}", scope=scope_key(target.app), app=target.app)
    if command == "focus":
        target = _known(args, command)
        # Linux grants AT-SPI's GrabFocus only to a headed call; it moves no pointer and sends no key.
        return step(["focus", target.ref, "--headed"], f"move the keyboard focus to {target.describe()}", scope=scope_key(target.app), app=target.app)
    if command == "type":
        target = _known(args, command)
        text = _text(args, "text", TEXT_MAX)
        return step(["type", target.ref, "--", text], f"type {_preview(text, target.secret)} into {target.describe()}", scope=scope_key(target.app), app=target.app)
    if command in ("set-value", "select"):
        target = _known(args, command)
        value = _text(args, "value", TEXT_MAX, allow_empty=command == "set-value")
        summary = f"set {target.describe()} to {_preview(value, target.secret)}" if command == "set-value" else f"choose {_preview(value)} in {target.describe()}"
        return step([command, target.ref, "--", value], summary, scope=scope_key(target.app), app=target.app)
    if command == "scroll":
        target = _known(args, command)
        direction = _choice(args, "direction", DIRECTIONS, "down")
        amount = _int(args, "amount", 3, 1, 50)
        return step(["scroll", target.ref, f"--direction={direction}", f"--amount={amount}"], f"scroll {target.describe()} {direction}", scope=scope_key(target.app), app=target.app)
    if command == "press":
        combo = str(args.get("key") or "").strip().lower()
        if not _COMBO.match(combo):
            raise ValueError("key must be a key or combo such as return, escape, tab, ctrl+s or shift+tab")
        return step(["press", combo], f"press {combo} in the focused window", scope="focused-window")
    if command == "launch":
        name = _name(args, "app", required=True)
        return step(["launch", "--", name], f"open {name}", scope=scope_key(name), app=name)
    if command == "clipboard-set":
        text = _text(args, "text", CLIPBOARD_MAX)
        return step(["clipboard-set", "--", text], f"put {_preview(text)} on the clipboard", scope="clipboard")
    if command == "screenshot":
        output = _screenshot_path()
        argv = ["screenshot", *([f"--app={app}"] if app else []), str(output)]
        what = f"{app}'s window" if app else "the screen"
        return step(argv, f"take a screenshot of {what} for Hermes to look at", scope=scope_key(app) if app else "screen", app=app, output=output)
    if command == "clipboard-get":
        return step(["clipboard-get", "--format=text"], "read the clipboard (Hermes sees what is on it)", scope="clipboard")

    if command == "close-app":
        name = _name(args, "app", required=True)
        force = _flag(args, "force", False)
        summary = f"force {name} to quit (unsaved work is lost)" if force else f"quit {name}"
        return step(["close-app", *(["--force"] if force else []), "--", name], summary, scope=scope_key(name), app=name)
    if command in ("notification-action", "dismiss-notification"):
        index = _int(args, "index", None, 1, 100)
        if index is None:
            raise ValueError(f"index is required for command={command} (its number in list-notifications)")
        expected_app, expected_title = _name(args, "expected_app"), _name(args, "expected_title")
        if not (expected_app or expected_title):
            raise ValueError(f"{command} needs expected_app or expected_title, so it cannot act on a notification that moved")
        expect = [f"--expected-app={expected_app}"] * bool(expected_app) + [f"--expected-title={expected_title}"] * bool(expected_title)
        source = f" from {clean(expected_app)}" if expected_app else ""
        titled = f" “{clean(expected_title)}”" if expected_title else ""
        if command == "notification-action":
            action = _name(args, "action", required=True)
            return step(["notification-action", *expect, "--", str(index), action], f"press “{clean(action)}” on the notification{titled}{source}")
        return step(["dismiss-notification", *expect, "--", str(index)], f"dismiss the notification{titled}{source}")
    if command == "dismiss-all-notifications":
        return step(["dismiss-all-notifications", *([f"--app={app}"] if app else [])], f"dismiss every notification{f' from {app}' if app else ''}")
    if command == "clipboard-clear":
        return step(["clipboard-clear"], "clear the clipboard")
    raise ValueError(f"unknown command '{command}'")  # pragma: no cover - TIERS and the branches agree.


def plan(args: dict[str, Any]) -> Call:
    """The whole call: one step, or a batch's steps with the highest tier among them (pure but for
    the element memory; tested)."""
    command = str((args or {}).get("command") or "").strip()
    if command != "batch":
        one = plan_step(args)
        return Call(one.command, one.tier, one.summary, one.scope, (one,), one.audit)
    raw = args.get("steps")
    if not isinstance(raw, list) or not raw:
        raise ValueError("batch needs steps: a list of commands, each an object like the tool's own arguments")
    if len(raw) > BATCH_MAX:
        raise ValueError(f"a batch runs at most {BATCH_MAX} steps")
    steps = tuple(plan_step(item) for item in raw)
    tier = highest(step.tier for step in steps)
    summary = f"run {len(steps)} desktop steps: " + "; ".join(f"{n}. {step.summary}" for n, step in enumerate(steps, 1))
    # "Always allow" for a batch holds for exactly these commands in these apps.
    scope = None if tier is Tier.READ else "batch-" + fingerprint(*sorted({f"{step.command}@{step.scope}" for step in steps if step.tier is not Tier.READ}))
    return Call("batch", tier, summary, scope, steps, {"command": "batch", "steps": [step.audit for step in steps]})


# ---------------------------------------------------------------------------------------------
# The binary
# ---------------------------------------------------------------------------------------------

def binary() -> Path | None:
    """The installed binary with its clipboard helper beside it, or ``None``. ``HERALD_OS_DESKTOP_BIN``
    points at another build (a checkout's target/release)."""
    override = os_env("DESKTOP_BIN")
    candidates = (Path(override),) if override else tuple(folder / BINARY for folder in INSTALL_DIRS)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def envelope(stdout: str) -> dict[str, Any] | None:
    """The JSON envelope the binary prints (one document on stdout), or ``None``."""
    text = stdout.strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        last = text.splitlines()[-1]
        try:
            data = json.loads(last)
        except json.JSONDecodeError:
            return None
    return data if isinstance(data, dict) and "ok" in data else None


# ---------------------------------------------------------------------------------------------
# The pre_tool_call guard
# ---------------------------------------------------------------------------------------------

# The tools that run what the model writes, and the argument that holds it.
SHELL_TOOLS = {"terminal": "command", "execute_code": "code"}
_NAME = r"agent-desktop(?:-linux-clipboard-owner)?"
# Running the binary, not mentioning it: a checkout's third_party/agent-desktop stays workable.
_RUNS = (
    re.compile(r"libexec/herald-os/(?:" + _NAME + r"\b|[^\s/'\"]*[*?\[])", re.I),
    re.compile(r"target/(?:release|debug|ci)/" + _NAME + r"\b", re.I),
    re.compile(r"(?:^|[;&|`(\n{'\"]|\$\(|\bthen\b|\bdo\b|\belse\b)\s*(?:(?:sudo|doas|env|exec|nohup|command|builtin|which|time|setsid|nice|xargs|stdbuf|timeout|strace|ltrace|gdb|watch|\S+=\S*)\s+(?:-\S+\s+)*)*(?:\S*/)?" + _NAME + r"(?=\s|$|[;&|)`}])", re.I),
    re.compile(r"""["']""" + _NAME + r"""["']""", re.I),
    re.compile(r"\bcargo\s+(?:\+\S+\s+)?run\b[^\n]*\b" + _NAME + r"\b|\b" + _NAME + r"\b[^\n]*\bcargo\s+(?:\+\S+\s+)?run\b", re.I),
)
GUARD_MESSAGE = (
    "Desktop control runs only through the desktop tool, which shows the person what it is about to do "
    "and asks first. This {tool} call runs its program directly, so it was not run. Use the desktop tool instead."
)


def runs_binary(text: str) -> bool:
    return any(pattern.search(text) for pattern in _RUNS)


def _strings(value: Any, depth: int = 0) -> Iterable[str]:
    if depth > 20:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item, depth + 1)


def guard(**kwargs: Any) -> dict[str, str] | None:
    """``pre_tool_call``: block a terminal or execute_code call that runs the desktop binary.

    Hermes waits on this hook and blocks the tool when it raises or stalls, so it only reads the
    arguments it is given and never raises."""
    tool = kwargs.get("tool_name")
    if not isinstance(tool, str) or tool not in SHELL_TOOLS:
        return None
    args = kwargs.get("args")
    if not isinstance(args, dict):
        return None
    try:
        hit = any(runs_binary(text) for text in _strings(args))
    except Exception:  # noqa: BLE001 - an unreadable argument blocks rather than slipping through.
        hit = True
    return {"action": "block", "message": GUARD_MESSAGE.format(tool=tool)} if hit else None
