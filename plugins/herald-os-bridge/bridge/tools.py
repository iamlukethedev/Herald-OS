"""Tool schemas and handlers for the ``herald_os`` toolset.

Every handler follows the same shape: validate arguments, decide the permission tier for the
requested action, ``authorize`` (protected paths first, then the tier policy / approval gate),
execute through the host adapter, and ``audit.record`` the outcome. Handlers return JSON strings.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

from . import audit, documents, ui
from .host import HostNotSupported, host
from .host.base import FileSearch
from .permissions import Tier, authorize, load_policy, protected_root
from .util import data_dir, expand, fail, ok, os_env, run, truncate

_STR = {"type": "string"}
_INT = {"type": "integer"}
_BOOL = {"type": "boolean"}


def _enum(*values: str, description: str = "") -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "enum": list(values)}
    if description:
        schema["description"] = description
    return schema


def _desc(kind: dict[str, Any], description: str) -> dict[str, Any]:
    return {**kind, "description": description}


def _schema(name: str, description: str, properties: dict[str, Any], required: Iterable[str] = ()) -> dict[str, Any]:
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": list(required)}}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    schema: dict[str, Any]
    handler: Callable[..., str]
    emoji: str


def bridge_enabled() -> bool:
    """``herald_os.bridge.enabled`` in config.yaml (default on; the pre-rename ``hermes_os`` section is
    still read). ``HERALD_OS_BRIDGE_DISABLED=1`` turns the bridge off for one process."""
    if os_env("BRIDGE_DISABLED") == "1":
        return False
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
        section = config.get("herald_os") or config.get("hermes_os") or {}
        bridge = section.get("bridge") if isinstance(section, dict) else None
        if isinstance(bridge, dict) and bridge.get("enabled") is False:
            return False
    except Exception:  # noqa: BLE001 - config unreadable: keep the default.
        pass
    return True


def _int(args: dict[str, Any], key: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(args.get(key, default) or default)
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


def _finish(*, tool: str, tier: Tier, action: str | None, args: dict[str, Any], decision: str, ok_: bool, summary: str | None = None, error: str | None = None) -> None:
    audit.record(tool=tool, tier=tier.value, action=action, args=args, decision=decision, ok=ok_, summary=summary, error=error)


class PartialFailure(RuntimeError):
    """An error after part of the work was done; ``payload`` says what (and how to undo it)."""

    def __init__(self, message: str, payload: dict[str, Any]):
        super().__init__(message)
        self.payload = payload


def _guarded(tool: str, tier: Tier, action: str, summary: str, args: dict[str, Any], paths: Iterable[Path], execute: Callable[[], dict[str, Any]]) -> str:
    """Authorize, run, audit. Shared by every act/mutate/destructive handler."""
    decision = authorize(tool, tier, action, summary, paths=paths)
    if not decision.allowed:
        _finish(tool=tool, tier=tier, action=action, args=args, decision=decision.outcome, ok_=False, summary=summary, error=decision.message)
        return fail(decision.message or "not permitted", decision=decision.outcome, summary=summary)
    try:
        payload = execute()
    except HostNotSupported as exc:
        _finish(tool=tool, tier=tier, action=action, args=args, decision=decision.outcome, ok_=False, summary=summary, error=str(exc))
        return fail(str(exc))
    except PartialFailure as exc:
        _finish(tool=tool, tier=tier, action=action, args=args, decision=decision.outcome, ok_=False, summary=summary, error=str(exc))
        return fail(str(exc), summary=summary, **exc.payload)
    except Exception as exc:  # noqa: BLE001 - every host error becomes a tool result, never a crash.
        _finish(tool=tool, tier=tier, action=action, args=args, decision=decision.outcome, ok_=False, summary=summary, error=str(exc))
        return fail(str(exc), summary=summary)
    _finish(tool=tool, tier=tier, action=action, args=args, decision=decision.outcome, ok_=True, summary=summary)
    return ok(summary=summary, **payload)


def _read(tool: str, action: str | None, args: dict[str, Any], execute: Callable[[], dict[str, Any]]) -> str:
    return _guarded(tool, Tier.READ, action or "read", f"{tool} {action or ''}".strip(), args, (), execute)


# ---------------------------------------------------------------------------------------------
# system_info
# ---------------------------------------------------------------------------------------------

SYSTEM_INFO_SCHEMA = _schema(
    "system_info",
    "Read this computer's system facts: OS version, chip, cores, memory (total/used), load average, uptime, disks (total/used/free per volume) and battery. Use it to answer questions about the machine, before recommending cleanups, or to ground disk/memory advice in numbers.",
    {},
)


def handle_system_info(args: dict[str, Any], **_: Any) -> str:
    return _read("system_info", None, args, lambda: host().system_info())


# ---------------------------------------------------------------------------------------------
# system_processes
# ---------------------------------------------------------------------------------------------

SYSTEM_PROCESSES_SCHEMA = _schema(
    "system_processes",
    "Inspect running processes. action=top lists the heaviest processes by CPU or memory ('what is using the most CPU?'); action=find matches processes by name; action=port shows what is listening on a TCP/UDP port ('what's on port 3000?'). Read-only; use system_kill_process to stop something.",
    {
        "action": _enum("top", "find", "port", description="What to look up."),
        "sort": _enum("cpu", "memory", description="For action=top: ranking key (default cpu)."),
        "name": _desc(_STR, "For action=find: substring matched case-insensitively against the command path."),
        "port": _desc(_INT, "For action=port: the port number."),
        "limit": _desc(_INT, "Maximum rows (default 15, max 100)."),
    },
    required=("action",),
)


def handle_system_processes(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "top")
    limit = _int(args, "limit", 15, 1, 100)

    def execute() -> dict[str, Any]:
        adapter = host()
        if action == "top":
            sort = "memory" if str(args.get("sort") or "cpu") == "memory" else "cpu"
            return {"sort": sort, "processes": [row.to_dict() for row in adapter.list_processes(sort, limit)]}
        if action == "find":
            name = str(args.get("name") or "").strip()
            if not name:
                raise ValueError("name is required for action=find")
            return {"name": name, "processes": [row.to_dict() for row in adapter.find_processes(name, limit)]}
        if action == "port":
            port = _int(args, "port", 0, 1, 65535)
            if not args.get("port"):
                raise ValueError("port is required for action=port")
            listeners = adapter.listeners_on_port(port)
            return {"port": port, "listeners": [row.to_dict() for row in listeners], "note": None if listeners else f"Nothing is listening on port {port}."}
        raise ValueError(f"unknown action '{action}'")

    return _read("system_processes", action, args, execute)


# ---------------------------------------------------------------------------------------------
# system_disk_usage
# ---------------------------------------------------------------------------------------------

SYSTEM_DISK_USAGE_SCHEMA = _schema(
    "system_disk_usage",
    "Find what takes up disk space: the largest entries directly under a directory (default: the user's home), biggest first. Start broad, then call again on the biggest child to drill in. Slow on huge trees; bounded by a timeout. Read-only.",
    {
        "path": _desc(_STR, "Directory to measure (default ~). Supports ~ expansion."),
        "depth": _desc(_INT, "How many levels to report below path (default 1, max 3)."),
        "limit": _desc(_INT, "Maximum entries to return (default 20, max 100)."),
    },
)


def handle_system_disk_usage(args: dict[str, Any], **_: Any) -> str:
    target = expand(str(args.get("path") or "~"))
    depth = _int(args, "depth", 1, 1, 3)
    limit = _int(args, "limit", 20, 1, 100)

    def execute() -> dict[str, Any]:
        if not target.is_dir():
            raise ValueError(f"{target} is not a directory")
        return host().disk_usage(target, depth, limit, timeout=90.0)

    return _guarded("system_disk_usage", Tier.READ, "measure", f"measure disk usage under {target}", args, (target,), execute)


# ---------------------------------------------------------------------------------------------
# system_find_files
# ---------------------------------------------------------------------------------------------

SYSTEM_FIND_FILES_SCHEMA = _schema(
    "system_find_files",
    "Search this computer's files (Spotlight on macOS; plocate, fd or find on Linux). Combine: text (content or display name), name (filename substring), kind (image, screenshot, document, pdf, video, audio, folder, code, archive), when (today, yesterday, this_week, last_7_days, this_month) or explicit since/until dates, scope (a directory), extensions. Example: 'screenshots I took yesterday' -> kind=screenshot, when=yesterday. Returns paths newest first. Read-only.",
    {
        "text": _desc(_STR, "Words to match in file content or display name."),
        "name": _desc(_STR, "Filename substring (case-insensitive)."),
        "kind": _enum("any", "image", "screenshot", "document", "pdf", "video", "audio", "folder", "code", "archive"),
        "when": _enum("today", "yesterday", "this_week", "last_7_days", "this_month", description="Relative creation-date window."),
        "since": _desc(_STR, "Created on/after this date (YYYY-MM-DD or ISO 8601)."),
        "until": _desc(_STR, "Created before the end of this date (YYYY-MM-DD or ISO 8601)."),
        "scope": _desc(_STR, "Only search under this directory (e.g. ~/Desktop)."),
        "extensions": {"type": "array", "items": _STR, "description": "File extensions to match, e.g. [\"png\", \"jpg\"]."},
        "limit": _desc(_INT, "Maximum results (default 50, max 200)."),
    },
)


def resolve_when(when: str | None, today: date | None = None) -> tuple[str | None, str | None]:
    """Translate a relative window into inclusive ``since`` / exclusive-end ``until`` dates (pure; tested)."""
    if not when:
        return None, None
    today = today or date.today()
    if when == "today":
        return today.isoformat(), today.isoformat()
    if when == "yesterday":
        y = today - timedelta(days=1)
        return y.isoformat(), y.isoformat()
    if when == "this_week":
        start = today - timedelta(days=today.weekday())
        return start.isoformat(), today.isoformat()
    if when == "last_7_days":
        return (today - timedelta(days=7)).isoformat(), today.isoformat()
    if when == "this_month":
        return today.replace(day=1).isoformat(), today.isoformat()
    raise ValueError(f"unknown when '{when}'")


def handle_system_find_files(args: dict[str, Any], **_: Any) -> str:
    def execute() -> dict[str, Any]:
        since, until = args.get("since"), args.get("until")
        if args.get("when"):
            since, until = resolve_when(str(args["when"]))
        exts = args.get("extensions") or ()
        search = FileSearch(
            text=(args.get("text") or None), name=(args.get("name") or None), kind=str(args.get("kind") or "any"),
            since=since, until=until, scope=(args.get("scope") or None),
            extensions=tuple(str(e) for e in exts) if isinstance(exts, list) else (), limit=_int(args, "limit", 50, 1, 200),
        )
        results = host().find_files(search)
        return {"count": len(results), "files": [f.to_dict() for f in results], "note": None if results else "No matches. Spotlight only indexes locations the user allows; try a broader query or a different kind."}

    return _read("system_find_files", "search", args, execute)


# ---------------------------------------------------------------------------------------------
# system_apps
# ---------------------------------------------------------------------------------------------

SYSTEM_APPS_SCHEMA = _schema(
    "system_apps",
    "Applications on this computer. action=installed lists installed apps (optionally filtered by name); action=running lists apps currently open; action=quit asks an app to quit (force=true kills it). Use system_open to launch an app.",
    {
        "action": _enum("installed", "running", "quit"),
        "filter": _desc(_STR, "For installed/running: case-insensitive name substring."),
        "name": _desc(_STR, "For quit: the application name."),
        "force": _desc(_BOOL, "For quit: force-terminate instead of asking politely (loses unsaved work)."),
    },
    required=("action",),
)


def handle_system_apps(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "installed")
    needle = str(args.get("filter") or "").strip().lower()
    if action == "quit":
        name = str(args.get("name") or "").strip()
        if not name:
            return fail("name is required for action=quit")
        force = bool(args.get("force"))
        summary = f"{'force quit' if force else 'quit'} {name}"
        return _guarded("system_apps", Tier.DESTRUCTIVE, "quit", summary, args, (), lambda: (host().quit_app(name, force), {"app": name, "forced": force})[1])

    def execute() -> dict[str, Any]:
        adapter = host()
        apps = adapter.installed_apps() if action == "installed" else adapter.running_apps() if action == "running" else None
        if apps is None:
            raise ValueError(f"unknown action '{action}'")
        if needle:
            apps = [a for a in apps if needle in a.name.lower()]
        return {"count": len(apps), "apps": [a.to_dict() for a in apps[:300]]}

    return _read("system_apps", action, args, execute)


# ---------------------------------------------------------------------------------------------
# system_open
# ---------------------------------------------------------------------------------------------

EDITOR_APPS = {"vscode": "Visual Studio Code", "code": "Visual Studio Code", "cursor": "Cursor", "xcode": "Xcode", "zed": "Zed", "finder": None, "terminal": "Terminal", "iterm": "iTerm"}
# editor=auto opens the first of these that is installed.
AUTO_EDITORS = ("Visual Studio Code", "Cursor", "Zed")

SYSTEM_OPEN_SCHEMA = _schema(
    "system_open",
    "Open things for the user. Inside Herald OS, target=url opens the page in a Herald OS window, target=path opens files in the Herald OS viewer (PDFs, images, text, media) or shows them in Files, and target=reveal shows the item in the Files page; pass app=... only when the user names a Mac app to use. target=app launches an application by name ('Open Safari'); target=url opens a URL (optionally in a specific browser); target=path opens a file or folder with its default app or a named app; target=reveal shows a file in Finder; target=editor opens a folder/file in a code editor (editor=auto, the default, picks the first installed of VS Code, Cursor and Zed; pass vscode|cursor|xcode|zed|terminal when the user names one), e.g. 'open this repo in my editor'; target=settings opens a System Settings pane (pane=privacy_and_security, wifi, bluetooth, sound, displays, notifications, screen_recording, accessibility_privacy, automation, ...). Runs immediately; every call is audited.",
    {
        "target": _enum("app", "url", "path", "reveal", "editor", "settings"),
        "app": _desc(_STR, "Application name (for target=app, or the app to open a url/path with)."),
        "url": _desc(_STR, "For target=url."),
        "path": _desc(_STR, "For target=path / reveal / editor. Supports ~."),
        "editor": _enum("auto", "vscode", "cursor", "xcode", "zed", "terminal", "iterm", description="For target=editor (default auto: the first installed of VS Code, Cursor and Zed)."),
        "pane": _desc(_STR, "For target=settings: the System Settings pane name."),
        "args": {"type": "array", "items": _STR, "description": "For target=app: extra launch arguments."},
    },
    required=("target",),
)


def _open_in_shell(target: str, args: dict[str, Any]) -> str | None:
    """Inside Herald OS, pages, files and folders open in the OS itself, not in macOS apps.

    Returns the tool result, or ``None`` when the shell is not running (or the request is one only
    the host can serve: a named app, an editor, System Settings), so the caller falls back to the host.
    """
    try:
        ui.control_endpoint()
    except ui.ShellUnavailable:
        return None
    if args.get("app"):
        return None
    if target == "url":
        url = str(args.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            return None
        return handle_os_ui({"action": "run", "command": "web.open", "args": {"url": url}})
    if target in ("path", "reveal"):
        raw = str(args.get("path") or "").strip()
        if not raw:
            return None
        path = expand(raw)
        if not path.exists():
            return fail(f"{path} does not exist")
        if target == "reveal" or path.is_dir():
            return handle_os_ui({"action": "run", "command": "files.show", "args": {"path": str(path)}})
        return handle_os_ui({"action": "run", "command": "file.open", "args": {"name": str(path)}})
    return None


def handle_system_open(args: dict[str, Any], **_: Any) -> str:
    target = str(args.get("target") or "")
    adapter = host()
    in_shell = _open_in_shell(target, args)
    if in_shell is not None:
        return in_shell
    if target == "app":
        name = str(args.get("app") or "").strip()
        if not name:
            return fail("app is required for target=app")
        extra = [str(a) for a in (args.get("args") or [])]
        return _guarded("system_open", Tier.ACT, "app", f"open {name}", args, (), lambda: (adapter.open_app(name, extra), {"opened": name})[1])
    if target == "settings":
        pane = str(args.get("pane") or "general")
        return _guarded("system_open", Tier.ACT, "settings", f"open System Settings > {pane}", args, (), lambda: {"pane": pane, "opened": adapter.open_settings(pane)})
    if target == "url":
        url = str(args.get("url") or "").strip()
        if url.lower().startswith("x-apple.systempreferences:"):
            return _guarded("system_open", Tier.ACT, "settings", f"open System Settings ({url})", args, (), lambda: (adapter.open_url(url), {"opened": url})[1])
        if not url.lower().startswith(("http://", "https://", "mailto:", "file://")):
            return fail("url must start with http://, https://, mailto: or file://")
        app = args.get("app") or None
        return _guarded("system_open", Tier.ACT, "url", f"open {url}" + (f" in {app}" if app else ""), args, (), lambda: (adapter.open_url(url, app), {"opened": url, "app": app})[1])
    if target in ("path", "reveal", "editor"):
        raw = str(args.get("path") or "").strip()
        if not raw:
            return fail("path is required")
        path = expand(raw)
        if not path.exists():
            return fail(f"{path} does not exist")
        if target == "reveal":
            return _guarded("system_open", Tier.ACT, "reveal", f"reveal {path} in Finder", args, (path,), lambda: (adapter.reveal(path), {"revealed": str(path)})[1])
        if target == "editor":
            editor = str(args.get("editor") or "auto").lower()
            if editor == "auto":
                try:
                    app = next((name for name in AUTO_EDITORS if adapter.resolve_app(name)), None)
                except HostNotSupported as exc:
                    return fail(str(exc))
                if app is None:
                    return fail(f"no code editor is installed (looked for {', '.join(AUTO_EDITORS)}); pass editor=... to name one")
            else:
                app = EDITOR_APPS.get(editor, editor)
            if app is None:
                return _guarded("system_open", Tier.ACT, "reveal", f"reveal {path} in Finder", args, (path,), lambda: (adapter.reveal(path), {"revealed": str(path)})[1])
            return _guarded("system_open", Tier.ACT, "editor", f"open {path} in {app}", args, (path,), lambda: (adapter.open_path(path, app), {"opened": str(path), "app": app})[1])
        app = args.get("app") or None
        return _guarded("system_open", Tier.ACT, "path", f"open {path}" + (f" with {app}" if app else ""), args, (path,), lambda: (adapter.open_path(path, app), {"opened": str(path), "app": app})[1])
    return fail(f"unknown target '{target}'")


# ---------------------------------------------------------------------------------------------
# system_kill_process
# ---------------------------------------------------------------------------------------------

SYSTEM_KILL_PROCESS_SCHEMA = _schema(
    "system_kill_process",
    "Stop a process. Identify it by pid, by the port it listens on ('kill the process on port 3000'), or by name (must match exactly one process unless all=true). Sends SIGTERM; force=true sends SIGKILL. Destructive: the user is always asked to confirm.",
    {
        "pid": _desc(_INT, "Process id."),
        "port": _desc(_INT, "Stop whatever is listening on this port."),
        "name": _desc(_STR, "Process name / command substring."),
        "all": _desc(_BOOL, "For name: stop every match instead of requiring exactly one."),
        "force": _desc(_BOOL, "SIGKILL instead of SIGTERM."),
    },
)


def handle_system_kill_process(args: dict[str, Any], **_: Any) -> str:
    adapter = host()
    force = bool(args.get("force"))
    targets: list[dict[str, Any]] = []
    try:
        if args.get("pid"):
            pid = int(args["pid"])
            match = adapter.find_processes("", 5000)
            row = next((r for r in match if r.pid == pid), None)
            targets = [{"pid": pid, "name": row.name if row else "unknown", "command": row.command if row else ""}]
        elif args.get("port"):
            port = int(args["port"])
            listeners = adapter.listeners_on_port(port)
            if not listeners:
                return fail(f"Nothing is listening on port {port}.")
            targets = [{"pid": l.pid, "name": l.command, "command": l.command, "port": port} for l in listeners]
        elif args.get("name"):
            name = str(args["name"]).strip()
            rows = [r for r in adapter.find_processes(name, 200) if r.pid != os.getpid()]
            if not rows:
                return fail(f"No process matches '{name}'.")
            if len(rows) > 1 and not args.get("all"):
                return fail(f"'{name}' matches {len(rows)} processes; pass pid or all=true.", candidates=[r.to_dict() for r in rows[:20]])
            targets = [{"pid": r.pid, "name": r.name, "command": r.command} for r in rows]
        else:
            return fail("provide pid, port or name")
    except (TypeError, ValueError) as exc:
        return fail(str(exc))

    if any(t["pid"] in (0, 1, os.getpid(), os.getppid()) for t in targets):
        return fail("Refusing to stop a system-critical process or Hermes itself.")
    label = ", ".join(f"{t['name']} (pid {t['pid']})" for t in targets)
    summary = f"{'force kill' if force else 'terminate'} {label}"

    def execute() -> dict[str, Any]:
        stopped, errors = [], []
        for t in targets:
            try:
                adapter.kill(int(t["pid"]), force)
                stopped.append(t)
            except ProcessLookupError:
                errors.append({**t, "error": "already exited"})
            except PermissionError:
                errors.append({**t, "error": "permission denied (owned by another user)"})
        return {"stopped": stopped, "errors": errors, "signal": "SIGKILL" if force else "SIGTERM"}

    return _guarded("system_kill_process", Tier.DESTRUCTIVE, "kill", summary, args, (), execute)


# ---------------------------------------------------------------------------------------------
# system_files
# ---------------------------------------------------------------------------------------------

SYSTEM_FILES_SCHEMA = _schema(
    "system_files",
    "Organise files and folders on this computer. action=mkdir creates a folder (path); action=move moves/renames one item (path -> to); action=copy copies a file or folder (path -> to); action=trash moves items to the Trash (paths; never permanent deletion); action=batch applies a list of operations [{op: mkdir|move|copy|trash, path, to}] in one confirmation, ideal for 'organise these files'. Set dry_run=true first to show the plan: it says where each item lands and lists problems (missing items, names already taken: nothing is ever overwritten). The user confirms mutating actions once per batch. "
    "When the user says 'undo that' or 'put it back', use action=undo: it replays the exact reverse of the most recent batch applied in this conversation (moved items go back, copies go to the Trash; undo_id picks an earlier one) and asks again; never retype the paths yourself. Use the write_file tool to create file contents.",
    {
        "action": _enum("mkdir", "move", "copy", "trash", "batch", "undo"),
        "undo_id": _desc(_STR, "For undo: the undo_id an applied batch returned, to reverse that one instead of the most recent."),
        "path": _desc(_STR, "Target path for mkdir/move/copy/trash."),
        "to": _desc(_STR, "Destination for move/copy (a folder, or the new full path)."),
        "paths": {"type": "array", "items": _STR, "description": "For trash: several items."},
        "operations": {
            "type": "array",
            "description": "For batch: ordered operations.",
            "items": {"type": "object", "properties": {"op": _enum("mkdir", "move", "copy", "trash"), "path": _STR, "to": _STR}, "required": ["op", "path"]},
        },
        "dry_run": _desc(_BOOL, "Only describe what would happen."),
    },
    required=("action",),
)


def tilde(path: Path) -> str:
    """The path with the home folder written as ``~`` (for lines a person reads)."""
    home, text = str(Path.home()), str(path)
    return "~" + text[len(home):] if text == home or text.startswith(home + os.sep) else text


@dataclass
class FileOp:
    op: str
    path: Path
    to: Path | None = None

    def describe(self, target: Path | None = None, show: Callable[[Path], str] = str) -> str:
        """One line for the plan; ``target`` is where a move or copy lands (``to`` itself when unknown)."""
        if self.op == "mkdir":
            return f"create folder {show(self.path)}"
        if self.op == "trash":
            return f"trash {show(self.path)}"
        landing = target or self.to
        assert landing is not None
        if self.op == "move" and landing.parent == self.path.parent:
            return f"rename {show(self.path)} -> {landing.name}"
        return f"{self.op} {show(self.path)} -> {show(landing)}"

    def touched(self) -> list[Path]:
        return [p for p in (self.path, self.to) if p is not None]


def plan_operations(args: dict[str, Any]) -> list[FileOp]:
    """Normalise the tool arguments into an ordered operation list (pure; tested)."""
    action = str(args.get("action") or "")
    ops: list[FileOp] = []
    if action == "batch":
        for raw in args.get("operations") or []:
            if not isinstance(raw, dict):
                continue
            op = str(raw.get("op") or "")
            if op not in ("mkdir", "move", "copy", "trash") or not raw.get("path"):
                raise ValueError(f"invalid operation {raw}")
            ops.append(FileOp(op, expand(str(raw["path"])), expand(str(raw["to"])) if raw.get("to") else None))
    elif action == "mkdir":
        if not args.get("path"):
            raise ValueError("path is required")
        ops.append(FileOp("mkdir", expand(str(args["path"]))))
    elif action in ("move", "copy"):
        if not args.get("path") or not args.get("to"):
            raise ValueError(f"path and to are required for {action}")
        ops.append(FileOp(action, expand(str(args["path"])), expand(str(args["to"]))))
    elif action == "trash":
        raw_paths = list(args.get("paths") or ([] if not args.get("path") else [args["path"]]))
        if not raw_paths:
            raise ValueError("paths (or path) is required for trash")
        ops.extend(FileOp("trash", expand(str(p))) for p in raw_paths)
    else:
        raise ValueError(f"unknown action '{action}'")
    for op in ops:
        if op.op in ("move", "copy") and op.to is None:
            raise ValueError(f"{op.op} of {op.path} needs 'to'")
    return ops


def _resolve_move_target(source: Path, to: Path) -> Path:
    return to / source.name if to.is_dir() else to


def _same_file(a: Path, b: Path) -> bool:
    """True when both names reach one file (a case-only rename on a case-insensitive disk)."""
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def plan_targets(ops: list[FileOp]) -> tuple[list[Path | None], list[str]]:
    """Where each move or copy lands (into a folder keeps the item's name) and what would go wrong.
    Walks the batch in order, so a folder created earlier in it counts and two items cannot land on
    the same name; nothing is ever overwritten (tested)."""
    created: set[Path] = set()   # Folders that will exist.
    arrived: set[Path] = set()   # Files that will exist.
    gone: set[Path] = set()      # Items moved away or trashed.

    def exists(path: Path) -> bool:
        return path in created or path in arrived or (path not in gone and os.path.lexists(path))

    def is_dir(path: Path) -> bool:
        return path in created or (path not in gone and path not in arrived and path.is_dir())

    targets: list[Path | None] = []
    problems: list[str] = []
    for op in ops:
        if op.op == "mkdir":
            if exists(op.path) and not is_dir(op.path):
                problems.append(f"{op.path} exists and is not a folder")
            created.add(op.path)
            gone.discard(op.path)
            targets.append(None)
            continue
        if not exists(op.path):
            problems.append(f"{op.path} does not exist")
            targets.append(None)
            continue
        source_is_dir = is_dir(op.path)
        if op.op == "trash":
            gone.add(op.path)
            created.discard(op.path)
            arrived.discard(op.path)
            targets.append(None)
            continue
        assert op.to is not None
        target = op.to / op.path.name if is_dir(op.to) else op.to
        if target == op.path:
            problems.append(f"{op.path} is already there")
        elif exists(target) and not (target not in arrived and target not in created and _same_file(target, op.path)):
            problems.append(f"{target} already exists; not overwriting")
        elif source_is_dir and op.path in target.parents:
            problems.append(f"cannot put {op.path} inside itself")
        if op.op == "move":
            gone.add(op.path)
            created.discard(op.path)
            arrived.discard(op.path)
        (created if source_is_dir else arrived).add(target)
        gone.discard(target)
        targets.append(target)
    return targets, problems


# What each applied batch would take to reverse, per Hermes session (newest last), so "undo that"
# replays the exact operations instead of the model retyping long paths. Paths only, a few per session.
UNDO_PER_SESSION = 10
UNDO_SESSIONS = 20


def _undo_journal_path() -> Path:
    return data_dir() / "file-undo.json"


def _load_undo_journal() -> dict[str, list[dict[str, Any]]]:
    try:
        data = json.loads(_undo_journal_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, list)} if isinstance(data, dict) else {}


def _save_undo_journal(journal: dict[str, list[dict[str, Any]]]) -> None:
    path = _undo_journal_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    kept = dict(list(journal.items())[-UNDO_SESSIONS:])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(kept, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def record_undo(session: str, undo: list[dict[str, str]], summary: str) -> str:
    """Keep the reverse of an applied batch for ``action=undo``; returns its undo_id."""
    journal = _load_undo_journal()
    entry_id = uuid.uuid4().hex[:8]
    entries = [*journal.pop(session, []), {"id": entry_id, "ts": datetime.now().isoformat(timespec="seconds"), "summary": summary, "undo": undo}]
    journal[session] = entries[-UNDO_PER_SESSION:]
    _save_undo_journal(journal)
    return entry_id


def find_undo(session: str, undo_id: str | None) -> dict[str, Any] | None:
    entries = _load_undo_journal().get(session, [])
    if undo_id:
        return next((entry for entry in entries if entry.get("id") == undo_id), None)
    return entries[-1] if entries else None


def drop_undo(session: str, undo_id: str) -> None:
    journal = _load_undo_journal()
    journal[session] = [entry for entry in journal.get(session, []) if entry.get("id") != undo_id]
    if not journal[session]:
        del journal[session]
    _save_undo_journal(journal)


def handle_system_files(args: dict[str, Any], **context: Any) -> str:
    # Hermes passes the conversation's session id to plugin tools; undo stays within it.
    session = str(context.get("session_id") or context.get("task_id") or "default")
    undoing: dict[str, Any] | None = None
    if str(args.get("action") or "") == "undo":
        undoing = find_undo(session, str(args.get("undo_id") or "").strip() or None)
        if undoing is None:
            return fail("Nothing to undo: no batch applied with system_files in this conversation is on record" + (f" under undo_id {args['undo_id']}" if args.get("undo_id") else "") + ".")
        args = {"action": "batch", "operations": undoing["undo"], "dry_run": args.get("dry_run")}
    try:
        ops = plan_operations(args)
    except ValueError as exc:
        return fail(str(exc))
    if not ops:
        return fail("nothing to do")
    tier = Tier.DESTRUCTIVE if any(op.op == "trash" for op in ops) else Tier.MUTATE
    targets, problems = plan_targets(ops)
    plan = [op.describe(target) for op, target in zip(ops, targets)]
    if args.get("dry_run"):
        audit.record(tool="system_files", tier=tier.value, action="plan", args=args, decision="dry_run", ok=not problems, summary=f"{len(ops)} operation(s) planned")
        return ok(dry_run=True, tier=tier.value, plan=plan, problems=problems, note="Call again with dry_run=false to apply; the user will be asked to confirm.")
    if problems:
        return fail("; ".join(problems), plan=plan)
    # The approval card shows this line in full: what moves, its new name and where it goes.
    lines = [op.describe(target, tilde) for op, target in zip(ops, targets)]
    summary = lines[0] if len(lines) == 1 else f"{len(lines)} file operations: " + "; ".join(truncate(line, 200) for line in lines[:8]) + (f"; and {len(lines) - 8} more" if len(lines) > 8 else "")

    def execute() -> dict[str, Any]:
        adapter = host()
        done: list[str] = []
        undo: list[dict[str, str]] = []
        created: list[str] = []
        try:
            for op in ops:
                landing: Path | None = None
                if op.op == "mkdir":
                    if not op.path.is_dir():
                        op.path.mkdir(parents=True, exist_ok=True)
                        created.append(str(op.path))
                elif op.op in ("move", "copy"):
                    # Resolved again: the disk may have changed while the person read the approval card.
                    landing = _resolve_move_target(op.path, op.to)  # type: ignore[arg-type]
                    if os.path.lexists(landing) and not _same_file(landing, op.path):
                        raise FileExistsError(f"{landing} already exists; not overwriting")
                    landing.parent.mkdir(parents=True, exist_ok=True)
                    if op.op == "move":
                        shutil.move(str(op.path), str(landing))
                        undo.append({"op": "move", "path": str(landing), "to": str(op.path)})
                    else:
                        if op.path.is_dir():
                            shutil.copytree(str(op.path), str(landing))
                        else:
                            shutil.copy2(str(op.path), str(landing))
                        undo.append({"op": "trash", "path": str(landing)})
                elif op.op == "trash":
                    adapter.trash([op.path])
                done.append(op.describe(landing))
        except Exception as exc:
            if not done:
                raise
            payload: dict[str, Any] = {"applied": done, "undo": undo[::-1], "created_folders": created}
            if undo and undoing is None:
                payload["undo_id"] = record_undo(session, undo[::-1], summary)
            raise PartialFailure(f"{exc} (stopped after {len(done)} of {len(ops)} operations)", payload) from exc
        result: dict[str, Any] = {"applied": done}
        if undoing is not None:
            # Undone: the record goes, so the next undo reaches the batch before it.
            drop_undo(session, undoing["id"])
            result["undone"] = undoing.get("summary")
        elif undo:
            result["undo"] = undo[::-1]
            result["undo_id"] = record_undo(session, undo[::-1], summary)
            result["undo_note"] = "If the user asks to undo this, call system_files action=undo: moved items go back, copies go to the Trash."
        if created:
            result["created_folders"] = created
        return result

    touched = [p for op in ops for p in op.touched()]
    action = "undo" if undoing is not None else "batch" if len(ops) > 1 else ops[0].op
    return _guarded("system_files", tier, action, summary, args, touched, execute)


# ---------------------------------------------------------------------------------------------
# system_documents
# ---------------------------------------------------------------------------------------------

SYSTEM_DOCUMENTS_SCHEMA = _schema(
    "system_documents",
    "Read what documents say, and find where this person files them. "
    "action=read (paths: files, or folders meaning the PDFs and images directly inside them): per document the text page by page (the PDF's text layer; scanned pages and photos of documents through OCR on this computer), page_count, sha256 (equal values mean duplicate files), "
    "hints read from the text (kind: invoice, receipt, statement, quote, credit note, payslip, contract, order or other; vendor and other candidates; date (issued), due_date, number, total with currency; date_ambiguous when day and month could swap) and suggested_name (YYYY-MM-DD Vendor kind number total). "
    "Hints are heuristics: check them against the text before relying on them. "
    "action=places: the folders documents are already filed in (Invoices, Receipts, Finances, Bills, Tax, Statements and similar under Documents, Desktop, the home folder and cloud drives), each with its layout (by year, by month, by vendor or topic, flat), subfolders and newest file names, so new files follow the same structure and naming. "
    "Read-only; rename and move with system_files. To find, rename and file documents, follow skill_view name=\"herald-os-bridge:file-documents\".",
    {
        "action": _enum("read", "places", description="read (default) or places."),
        "paths": {"type": "array", "items": _STR, "description": "For read: files or folders (a folder means the PDFs and images directly inside it). Supports ~."},
        "path": _desc(_STR, "For read: one file or folder, the same as paths with one entry."),
        "max_pages": _desc(_INT, "For read: pages to read per document (default 3, max 20); page_count always gives the total."),
        "max_chars": _desc(_INT, "For read: characters of text per document (default 4000 for up to 3 documents, 800 per document when reading more; max 20000)."),
        "ocr": _desc(_BOOL, "For read: read scanned pages and images with OCR (default true)."),
        "limit": _desc(_INT, "For read: documents per call (default 15, max 50); the rest are listed under skipped."),
        "roots": {"type": "array", "items": _STR, "description": "For places: folders to look in instead of Documents, Desktop, the home folder and cloud drives."},
    },
)

# Reading stops after this many seconds; the documents not reached are listed under skipped.
DOCUMENTS_BUDGET_SECONDS = 120.0


def _flag(args: dict[str, Any], key: str, default: bool) -> bool:
    value = args.get(key)
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "no", "off")
    return bool(value)


def read_one_document(path: Path, max_pages: int, max_chars: int, ocr: bool) -> dict[str, Any]:
    """One entry of a read result: facts about the file, its text, the hints and a suggested name.
    A document that cannot be read gets ``error`` instead of failing the whole call."""
    try:
        stat = path.stat()
    except OSError as exc:
        return {"path": str(path), "name": path.name, "error": exc.strerror or str(exc)}
    entry: dict[str, Any] = {
        "path": str(path), "name": path.name, "type": documents.document_type(path), "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }
    if stat.st_size > documents.MAX_DOCUMENT_BYTES:
        entry["error"] = f"larger than {documents.MAX_DOCUMENT_BYTES // (1024 * 1024)} MB; not read"
        return entry
    entry["sha256"] = documents.sha256_file(path)
    try:
        doc = host().read_document(path, max_pages, ocr)
    except HostNotSupported:
        raise
    except Exception as exc:  # noqa: BLE001 - an unreadable document is reported, the others still read.
        entry["error"] = str(exc)
        return entry
    full = "\n".join(doc.pages)
    text, truncated = documents.join_pages(doc, max_chars)
    hints = documents.detect_fields(full)
    entry.update({
        "page_count": doc.page_count, "pages_read": len(doc.pages), "ocr_pages": doc.ocr_pages, "engine": doc.engine,
        "text": text, "truncated": truncated, "hints": hints, "suggested_name": documents.suggest_name(hints, path.suffix),
    })
    notes = list(doc.notes)
    if not full.strip():
        notes.append("No text found: the document may be blank, or a scan that OCR could not read.")
    if notes:
        entry["notes"] = notes
    return entry


def handle_system_documents(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "read").strip().lower()
    if action == "places":
        given = [expand(str(r)) for r in args.get("roots") or [] if str(r).strip()]
        roots = [(root, 3) for root in given] or documents.default_roots()

        def find_places() -> dict[str, Any]:
            policy = load_policy()
            return documents.find_places(roots, skip=lambda p: protected_root(p, policy) is not None)

        return _guarded("system_documents", Tier.READ, "places", "look for the folders documents are filed in", args, given, find_places)
    if action != "read":
        return fail("action must be read or places")
    raw = [str(p) for p in (args.get("paths") or []) if str(p).strip()]
    if str(args.get("path") or "").strip():
        raw.append(str(args["path"]))
    if not raw:
        return fail("paths (or path) is required for action=read")
    targets = [expand(p) for p in raw]
    max_pages = _int(args, "max_pages", 3, 1, 20)
    limit = _int(args, "limit", 15, 1, 50)
    ocr = _flag(args, "ocr", True)

    def execute() -> dict[str, Any]:
        files, skipped = documents.collect_documents(targets, limit)
        max_chars = _int(args, "max_chars", 4000 if len(files) <= 3 else 800, 200, 20000)
        policy = load_policy()
        started = time.monotonic()
        read: list[dict[str, Any]] = []
        for path in files:
            if protected_root(path, policy) is not None:
                skipped.append({"path": str(path), "reason": "inside a protected location"})
            elif time.monotonic() - started > DOCUMENTS_BUDGET_SECONDS:
                skipped.append({"path": str(path), "reason": "time budget reached; read it in another call"})
            else:
                read.append(read_one_document(path, max_pages, max_chars, ocr))
        by_hash: dict[str, list[str]] = {}
        for entry in read:
            if entry.get("sha256"):
                by_hash.setdefault(entry["sha256"], []).append(entry["path"])
        duplicates = [paths for paths in by_hash.values() if len(paths) > 1]
        note = None if read else "No PDFs or images to read there."
        if len(skipped) > 25:
            skipped[25:] = [{"path": "…", "reason": f"{len(skipped) - 25} more not listed: list them with system_find_files (scope = the folder) and read them in batches with paths"}]
        return {"count": len(read), "documents": read, "duplicates": duplicates, "skipped": skipped, "note": note}

    return _guarded("system_documents", Tier.READ, "read", f"read documents: {truncate(', '.join(raw), 160)}", args, targets, execute)


# ---------------------------------------------------------------------------------------------
# system_network
# ---------------------------------------------------------------------------------------------

SYSTEM_NETWORK_SCHEMA = _schema(
    "system_network",
    "Connectivity on this computer. action=status: online/offline, default interface, gateway, DNS, each active interface with its IPv4, and the Wi-Fi link (connected, channel, rate, signal; macOS hides the network name unless Location Services is granted). action=bluetooth: power state, connected and paired devices. Read-only.",
    {"action": _enum("status", "bluetooth", description="Default status.")},
)


def handle_system_network(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "status")

    def execute() -> dict[str, Any]:
        if action == "bluetooth":
            return {"bluetooth": host().bluetooth_status()}
        return host().network_status()

    return _read("system_network", action, args, execute)


# ---------------------------------------------------------------------------------------------
# system_control
# ---------------------------------------------------------------------------------------------

SYSTEM_CONTROL_SCHEMA = _schema(
    "system_control",
    "Read or change device settings. Reads: audio (output/input/alert volume, mute), appearance (dark mode, displays). Actions: set_volume (percent and/or muted), set_dark_mode (enabled), notify (title, body: a system notification), open_settings (pane, e.g. privacy_and_security, screen_recording, wifi, bluetooth, sound, displays, notifications), sleep_display, lock_screen, set_wifi (enabled). "
    "Herald OS Linux also has: wifi_networks (networks in range), wifi_connect (ssid, password for a new secured network), bluetooth_power (enabled), bluetooth_connect / bluetooth_disconnect (device: a name), audio_devices (outputs and inputs), set_audio_output (device: part of its name, e.g. headphones, HDMI), set_brightness (percent), power_profile (read the power mode), set_power_profile (profile: performance, balanced or power-saver). "
    "Actions run immediately and are audited; set_wifi, wifi_connect and bluetooth_power ask first.",
    {
        "action": _enum(
            "audio", "appearance", "set_volume", "set_dark_mode", "notify", "open_settings", "sleep_display", "lock_screen", "set_wifi",
            "wifi_networks", "wifi_connect", "bluetooth_power", "bluetooth_connect", "bluetooth_disconnect",
            "audio_devices", "set_audio_output", "set_brightness", "power_profile", "set_power_profile",
        ),
        "percent": _desc(_INT, "For set_volume (0-100) and set_brightness (1-100)."),
        "muted": _desc(_BOOL, "For set_volume."),
        "enabled": _desc(_BOOL, "For set_dark_mode / set_wifi / bluetooth_power."),
        "title": _desc(_STR, "For notify."),
        "body": _desc(_STR, "For notify."),
        "pane": _desc(_STR, "For open_settings: a System Settings pane name."),
        "ssid": _desc(_STR, "For wifi_connect: the network name."),
        "password": _desc(_STR, "For wifi_connect: only for a secured network not joined before."),
        "device": _desc(_STR, "For bluetooth_connect / bluetooth_disconnect / set_audio_output: the device name (or part of it)."),
        "profile": _enum("performance", "balanced", "power-saver", description="For set_power_profile."),
    },
    required=("action",),
)

_CONTROL_NAME = re.compile(r"^[^-\s][^\n]{0,127}$")


def handle_system_control(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "")
    adapter = host()
    if action == "audio":
        return _read("system_control", action, args, lambda: {"audio": adapter.audio_status()})
    if action == "appearance":
        return _read("system_control", action, args, lambda: adapter.appearance_status())
    if action == "set_volume":
        percent = args.get("percent")
        muted = args.get("muted")
        if percent is None and muted is None:
            return fail("set_volume needs percent and/or muted")
        parts = [f"volume {int(percent)}%" if percent is not None else "", ("mute" if muted else "unmute") if muted is not None else ""]
        summary = "set " + " and ".join(p for p in parts if p)
        return _guarded("system_control", Tier.ACT, action, summary, args, (), lambda: {"audio": adapter.set_volume(int(percent) if percent is not None else None, bool(muted) if muted is not None else None)})
    if action == "set_dark_mode":
        enabled = bool(args.get("enabled", True))
        return _guarded("system_control", Tier.ACT, action, f"turn dark mode {'on' if enabled else 'off'}", args, (), lambda: (adapter.set_dark_mode(enabled), {"dark_mode": enabled})[1])
    if action == "notify":
        title = str(args.get("title") or "Hermes")
        body = str(args.get("body") or "")
        if not body:
            return fail("notify needs body")
        return _guarded("system_control", Tier.ACT, action, f"notify: {title}", args, (), lambda: (adapter.notify(title, body), {"notified": True})[1])
    if action == "open_settings":
        pane = str(args.get("pane") or "general")
        return _guarded("system_control", Tier.ACT, action, f"open System Settings > {pane}", args, (), lambda: {"opened": adapter.open_settings(pane)})
    if action == "sleep_display":
        return _guarded("system_control", Tier.ACT, action, "put the display to sleep", args, (), lambda: (adapter.sleep_display(), {"display": "sleeping"})[1])
    if action == "lock_screen":
        return _guarded("system_control", Tier.ACT, action, "lock the screen", args, (), lambda: (adapter.lock_screen(), {"locked": True})[1])
    if action == "set_wifi":
        enabled = bool(args.get("enabled", True))
        return _guarded("system_control", Tier.MUTATE, action, f"turn Wi-Fi {'on' if enabled else 'off'}", args, (), lambda: (adapter.set_wifi_power(enabled), {"wifi": enabled})[1])
    if action == "wifi_networks":
        return _read("system_control", action, args, lambda: {"networks": adapter.wifi_networks()})
    if action == "audio_devices":
        return _read("system_control", action, args, adapter.audio_devices)
    if action == "power_profile":
        return _read("system_control", action, args, adapter.power_profiles)
    # Names end up as command-line arguments; one that starts with "-" could be taken for an option.
    name_key = {"wifi_connect": "ssid", "bluetooth_connect": "device", "bluetooth_disconnect": "device", "set_audio_output": "device"}.get(action)
    name = str(args.get(name_key) or "").strip() if name_key else ""
    if name_key and not _CONTROL_NAME.match(name):
        return fail(f"{name_key} is required for action={action} and must not start with '-'")
    if action == "wifi_connect":
        password = str(args.get("password") or "") or None
        return _guarded("system_control", Tier.MUTATE, action, f"join the Wi-Fi network {name}", args, (), lambda: (adapter.wifi_connect(name, password), {"connected": name})[1])
    if action == "bluetooth_power":
        enabled = bool(args.get("enabled", True))
        return _guarded("system_control", Tier.MUTATE, action, f"turn Bluetooth {'on' if enabled else 'off'}", args, (), lambda: (adapter.bluetooth_set_power(enabled), {"bluetooth": enabled})[1])
    if action in ("bluetooth_connect", "bluetooth_disconnect"):
        connect = action == "bluetooth_connect"
        return _guarded("system_control", Tier.ACT, action, f"{'connect' if connect else 'disconnect'} {name}", args, (), lambda: adapter.bluetooth_connect(name, connect))
    if action == "set_audio_output":
        return _guarded("system_control", Tier.ACT, action, f"play sound through {name}", args, (), lambda: adapter.set_audio_output(name))
    if action == "set_brightness":
        if args.get("percent") is None:
            return fail("set_brightness needs percent")
        percent = _int(args, "percent", 50, 1, 100)
        return _guarded("system_control", Tier.ACT, action, f"set the brightness to {percent}%", args, (), lambda: (adapter.set_brightness(percent), {"brightness": percent})[1])
    if action == "set_power_profile":
        profile = str(args.get("profile") or "")
        if profile not in ("performance", "balanced", "power-saver"):
            return fail("profile must be performance, balanced or power-saver")
        return _guarded("system_control", Tier.ACT, action, f"switch to the {profile} power mode", args, (), lambda: (adapter.set_power_profile(profile), {"profile": profile})[1])
    return fail(f"unknown action '{action}'")


# ---------------------------------------------------------------------------------------------
# system_logs
# ---------------------------------------------------------------------------------------------

SYSTEM_LOGS_SCHEMA = _schema(
    "system_logs",
    "Diagnostics. action=log (default) reads the system log: minutes (default 10, max 240), level error|fault|any (default error), optional process name filter, limit (default 40, max 200); returns the most recent matching lines. "
    "action=crashes lists recent crashes of the user's programs (macOS crash reports, Linux core dumps), newest first. "
    "action=crash_report reads one crash: report = the report path from action=crashes (macOS) or the crashed pid (Linux); returns the exception, termination reason, app messages and the crashed thread's top frames (macOS) or coredumpctl's summary with the stack trace (Linux). "
    "To explain a crash to the user, follow skill_view name=\"herald-os-bridge:diagnose-crash\". "
    "Read-only; can take several seconds.",
    {
        "action": _enum("log", "crashes", "crash_report", description="What to read (default log)."),
        "minutes": _INT,
        "level": _enum("error", "fault", "any"),
        "process": _desc(_STR, "Only lines from this process (e.g. WindowServer, kernel)."),
        "limit": _INT,
        "report": _desc(_STR, "For action=crash_report: a crash report path or file name (macOS) or the crashed pid (Linux)."),
    },
)


def handle_system_logs(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "log")
    limit = _int(args, "limit", 40, 1, 200)
    if action == "crashes":
        return _read("system_logs", "crashes", args, lambda: {"crashes": host().crash_reports(min(limit, 50))})
    if action == "crash_report":
        ref = str(args.get("report") or "").strip()
        if not ref:
            return fail("report is required for action=crash_report (see action=crashes)")
        paths = (expand(ref),) if "/" in ref else ()
        return _guarded("system_logs", Tier.READ, "crash_report", f"read the crash report {truncate(ref, 80)}", args, paths, lambda: host().crash_report(ref))
    if action != "log":
        return fail(f"unknown action '{action}'")
    minutes = _int(args, "minutes", 10, 1, 240)
    level = str(args.get("level") or "error")
    process = (args.get("process") or None) and str(args["process"])
    return _read("system_logs", level, args, lambda: {"minutes": minutes, "level": level, "process": process, "lines": host().system_logs(minutes, level, process, limit)})


# ---------------------------------------------------------------------------------------------
# system_os
# ---------------------------------------------------------------------------------------------

SYSTEM_OS_SCHEMA = _schema(
    "system_os",
    "Herald OS Linux's control surface: the same `herald-os` commands the user's hotkeys and menu run. "
    "Software: install_app (name: a dnf package or Flatpak id), install_webapp (name, url, icon_url?: pins a website as an app), remove_app, remove_webapp. "
    "The install catalog (curated, works on Fedora, Arch and the image): catalog_list (JSON of groups: AI coding agents and local models, languages through mise, editors, terminals, games, the Windows VM, media, services, web apps; each entry says installed / available / why not), "
    "catalog_install (id), catalog_remove (id). Prefer the catalog over install_app when the software is in it. "
    "Widget plugins: plugin_list, plugin_add (url: a git repository; it arrives turned off), plugin_update (id), plugin_disable (id), plugin_remove (id). "
    "Turning a plugin on is the user's call after reading what it asks for: point them to Settings > Plugins. "
    "Reminders: reminder (duration like 20m or 1h30m, message), reminders_list, reminders_clear. "
    "notice (kind=time|battery|weather) shows a status notice. screenshot captures the screen and hands it to Hermes; ocr reads the text on screen. "
    "lock locks the session; suspend puts the computer to sleep. Themes: theme_list, theme_set (name), theme_current. update updates Herald OS. "
    "Hermes shell: show_page (page: overview, hermes, missions, memory, files, automations, connections, settings), open_window (window=terminal|system|chat-popout), launch (name: an installed app), notify (title, body?). "
    "Spaces: focus_workspace (name), close_focused_window. install/remove/update and suspend ask the user to confirm. "
    "Only available on Herald OS Linux; on macOS this tool is unavailable (use system_open / system_control instead).",
    {
        "action": _enum(
            "install_app", "install_webapp", "remove_app", "remove_webapp",
            "catalog_list", "catalog_install", "catalog_remove",
            "plugin_list", "plugin_add", "plugin_update", "plugin_disable", "plugin_remove",
            "reminder", "reminders_list", "reminders_clear", "notice",
            "screenshot", "ocr", "lock", "suspend",
            "theme_list", "theme_set", "theme_current", "update",
            "show_page", "open_window", "launch", "notify",
            "focus_workspace", "close_focused_window",
            description="What to do.",
        ),
        "name": _desc(_STR, "For install_app / remove_app (package or Flatpak id), install_webapp / remove_webapp (web app name), theme_set (theme name), launch (app name or desktop id), focus_workspace (Space name)."),
        "id": _desc(_STR, "For catalog_install / catalog_remove: the catalog id from catalog_list, e.g. claude-code, node, zed, steam, windows. For plugin_update / plugin_disable / plugin_remove: the plugin id from plugin_list."),
        "url": _desc(_STR, "For install_webapp: the site to pin (http:// or https://). For plugin_add: the plugin's git repository (https://, ssh:// or git@)."),
        "icon_url": _desc(_STR, "For install_webapp: optional icon image URL (http:// or https://)."),
        "duration": _desc(_STR, "For reminder: how long from now, e.g. 90s, 20m, 1h, 1h30m, or a plain number of minutes."),
        "message": _desc(_STR, "For reminder: what to remind the user about."),
        "kind": _enum("time", "battery", "weather", description="For notice."),
        "page": _desc(_STR, "For show_page: the Hermes page id (overview, hermes, missions, memory, files, automations, connections, settings)."),
        "window": _enum("terminal", "system", "chat-popout", description="For open_window."),
        "title": _desc(_STR, "For notify."),
        "body": _desc(_STR, "For notify: optional body text."),
    },
    required=("action",),
)

HERALD_OS_BIN = "herald-os"
_LONG_RUNNING_OS_ACTIONS = frozenset({"install_app", "install_webapp", "remove_app", "update", "catalog_install", "catalog_remove", "plugin_add", "plugin_update"})
_CATALOG_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_PLUGIN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
_PLUGIN_URL = re.compile(r"^(https://|ssh://|git@)[^\s]+$")
_OS_TIMEOUT_LONG = 1200.0
_OS_TIMEOUT_SHORT = 60.0
_OS_OUTPUT_LIMIT = 4000
_DURATION = re.compile(r"^\d+(s|m|h)(\d+(m|s))?$")

SYSTEM_OS_TIERS: dict[str, Tier] = {
    "theme_list": Tier.READ, "theme_current": Tier.READ, "reminders_list": Tier.READ, "notice": Tier.READ, "catalog_list": Tier.READ,
    "catalog_install": Tier.MUTATE, "catalog_remove": Tier.DESTRUCTIVE,
    "plugin_list": Tier.READ, "plugin_disable": Tier.ACT, "plugin_add": Tier.MUTATE, "plugin_update": Tier.MUTATE, "plugin_remove": Tier.DESTRUCTIVE,
    "show_page": Tier.READ, "open_window": Tier.READ, "focus_workspace": Tier.READ,
    "launch": Tier.ACT, "notify": Tier.ACT, "screenshot": Tier.ACT, "ocr": Tier.ACT, "lock": Tier.ACT,
    "reminder": Tier.ACT, "theme_set": Tier.ACT, "close_focused_window": Tier.ACT,
    "install_app": Tier.MUTATE, "install_webapp": Tier.MUTATE, "remove_webapp": Tier.MUTATE, "reminders_clear": Tier.MUTATE, "update": Tier.MUTATE,
    "remove_app": Tier.DESTRUCTIVE, "suspend": Tier.DESTRUCTIVE,
}


def _os_arg(args: dict[str, Any], key: str, label: str | None = None) -> str:
    """A required free-text argument: non-empty and not shaped like a CLI flag."""
    value = str(args.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required for action={label or args.get('action')}")
    if value.startswith("-"):
        raise ValueError(f"{key} must not start with '-'")
    return value


def _os_url(args: dict[str, Any], key: str, required: bool) -> str | None:
    value = str(args.get(key) or "").strip()
    if not value:
        if required:
            raise ValueError(f"{key} is required for action={args.get('action')}")
        return None
    if not value.lower().startswith(("http://", "https://")):
        raise ValueError(f"{key} must start with http:// or https://")
    return value


def normalise_duration(raw: Any) -> str:
    """Accept ``90s`` / ``20m`` / ``1h`` / ``1h30m`` or a plain number of minutes (pure; tested)."""
    text = str(raw or "").strip().lower().replace(" ", "")
    if not text:
        raise ValueError("duration is required for action=reminder")
    if text.isdigit():
        if int(text) <= 0:
            raise ValueError("duration must be positive")
        return f"{int(text)}m"
    if not _DURATION.match(text):
        raise ValueError("duration must look like 90s, 20m, 1h or 1h30m (or a plain number of minutes)")
    return text


def compact_catalog(stdout: str) -> dict[str, list[str]]:
    """`herald-os catalog list --json` as one short line per entry, grouped (pure; tested).

    The full listing is too long for a tool result; "id: Label (state)" is what choosing needs."""
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"catalog list returned unreadable output: {exc}") from exc
    out: dict[str, list[str]] = {}
    for group in data.get("groups", []):
        lines = []
        for entry in group.get("entries", []):
            state = "installed" if entry.get("installed") else ("available" if entry.get("available") else f"unavailable: {entry.get('reason', 'not here')}")
            lines.append(f"{entry.get('id')}: {entry.get('label')} ({state})")
        out[str(group.get("label") or group.get("id"))] = lines
    return out


def plan_system_os(args: dict[str, Any]) -> tuple[list[str], str]:
    """Map the tool arguments to a ``herald-os`` argv and a human summary (pure; tested).

    Raises ``ValueError`` for unknown actions and invalid or missing arguments."""
    action = str(args.get("action") or "")
    if action == "install_app":
        name = _os_arg(args, "name")
        return ["install", "app", name], f"install app {name}"
    if action == "install_webapp":
        name, url, icon = _os_arg(args, "name"), _os_url(args, "url", True), _os_url(args, "icon_url", False)
        return ["install", "webapp", name, url, *([icon] if icon else [])], f"install web app {name} ({url})"  # type: ignore[list-item]
    if action == "remove_app":
        name = _os_arg(args, "name")
        return ["remove", "app", name], f"remove app {name}"
    if action == "remove_webapp":
        name = _os_arg(args, "name")
        return ["remove", "webapp", name], f"remove web app {name}"
    if action == "catalog_list":
        return ["catalog", "list", "--json"], "list the install catalog"
    if action in ("catalog_install", "catalog_remove"):
        entry = str(args.get("id") or "").strip().lower()
        if not _CATALOG_ID.match(entry):
            raise ValueError("id must be a catalog id from catalog_list (lowercase letters, digits and dashes)")
        verb = "install" if action == "catalog_install" else "remove"
        return ["catalog", verb, entry], f"{verb} {entry} from the catalog"
    if action == "plugin_list":
        return ["plugin", "list"], "list widget plugins"
    if action == "plugin_add":
        url = str(args.get("url") or "").strip()
        if not _PLUGIN_URL.match(url):
            raise ValueError("url must be a git repository (https://, ssh:// or git@)")
        return ["plugin", "add", url], f"install the plugin at {url} (turned off)"
    if action in ("plugin_update", "plugin_disable", "plugin_remove"):
        plugin = str(args.get("id") or "").strip().lower()
        if not _PLUGIN_ID.match(plugin):
            raise ValueError("id must be a plugin id from plugin_list (lowercase letters, digits and dashes)")
        verb = action.removeprefix("plugin_")
        return ["plugin", verb, plugin], f"{verb} the plugin {plugin}"
    if action == "reminder":
        duration = normalise_duration(args.get("duration"))
        message = _os_arg(args, "message")
        return ["reminder", duration, message], f"remind in {duration}: {truncate(message, 60)}"
    if action == "reminders_list":
        return ["reminder", "list"], "list reminders"
    if action == "reminders_clear":
        return ["reminder", "clear"], "clear all reminders"
    if action == "notice":
        kind = str(args.get("kind") or "").strip().lower()
        if kind not in ("time", "battery", "weather"):
            raise ValueError("kind must be one of time, battery, weather")
        return ["notice", kind], f"show the {kind} notice"
    if action == "screenshot":
        return ["screenshot"], "take a screenshot"
    if action == "ocr":
        return ["ocr"], "read the text on screen (OCR)"
    if action == "lock":
        return ["lock"], "lock the session"
    if action == "suspend":
        return ["suspend"], "suspend the computer"
    if action == "theme_list":
        return ["theme", "list"], "list themes"
    if action == "theme_set":
        name = _os_arg(args, "name")
        return ["theme", "set", name], f"set theme {name}"
    if action == "theme_current":
        return ["theme", "current"], "show the current theme"
    if action == "update":
        return ["update"], "update Herald OS"
    if action == "show_page":
        page = _os_arg(args, "page")
        return ["page", page], f"show the {page} page"
    if action == "open_window":
        window = str(args.get("window") or "").strip().lower()
        if window not in ("terminal", "system", "chat-popout"):
            raise ValueError("window must be one of terminal, system, chat-popout")
        return ["open", window], f"open the {window} window"
    if action == "launch":
        name = _os_arg(args, "name")
        return ["launch", name], f"launch {name}"
    if action == "notify":
        title = _os_arg(args, "title")
        body = str(args.get("body") or "").strip()
        return ["notify", title, *([body] if body else [])], f"notify: {title}"
    if action == "focus_workspace":
        name = _os_arg(args, "name")
        return ["wm", "focus-workspace", name], f"focus Space {name}"
    if action == "close_focused_window":
        return ["wm", "close-window"], "close the focused window"
    raise ValueError(f"unknown action '{action}'")


def system_os_handler(args: dict[str, Any], **_: Any) -> str:
    if host().platform != "linux":
        return fail("system_os is only available on Herald OS Linux")
    action = str(args.get("action") or "")
    try:
        cli_args, summary = plan_system_os(args)
    except ValueError as exc:
        return fail(str(exc))
    tier = SYSTEM_OS_TIERS[action]
    timeout = _OS_TIMEOUT_LONG if action in _LONG_RUNNING_OS_ACTIONS else _OS_TIMEOUT_SHORT
    argv = [HERALD_OS_BIN, *cli_args]

    def execute() -> dict[str, Any]:
        result = run(argv, timeout=timeout)
        if result.code == 127:
            raise HostNotSupported("The herald-os command is not installed (it ships with Herald OS Linux as /usr/local/bin/herald-os).")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"herald-os exited {result.code}")
        if action == "catalog_list":
            return {"action": action, "catalog": compact_catalog(result.stdout)}
        return {"action": action, "output": truncate(result.stdout.strip(), _OS_OUTPUT_LIMIT)}

    return _guarded("system_os", tier, action, summary, args, (), execute)


handle_system_os = system_os_handler


# ---------------------------------------------------------------------------------------------
# os_ui: drive the Herald OS shell (both macOS and Linux) through its command registry
# ---------------------------------------------------------------------------------------------

OS_UI_SCHEMA = _schema(
    "os_ui",
    "Operate the Herald OS user interface the user is looking at: open pages (missions, memory, files, automations, connections, settings) and apps (terminal, system), focus/close windows, show or add memories, list/run/pause automations, start missions, open web pages inside the OS, change appearance and voice settings. "
    "Use action=list once to see every command with its arguments, then action=run with command=<id> and args. action=state tells you which page and windows are on screen, on the Files page the folder it shows and the selected file (what \"this folder\" and \"this file\" mean), and in `office` the documents open in Herald Docs, Sheets and Slides, the one in front and what is selected in each (what \"this document\", \"these cells\" and \"this slide\" mean; the docs, sheets and slides tools work on them). "
    "Prefer this over describing where things are: when the user asks to open, show, add, find or change something in Herald OS, do it and then say what you did. "
    "After using other tools whose result lives on a page (memory, cronjob, files), run page.open so the user sees it. Destructive commands (forget, delete, trash) ask the user for approval. "
    "When the user asks you to build, create or make something new (a website, app, landing page, store, game), do not write it yourself in a scratch or temporary folder: run command=build.start with args={\"goal\": \"<what they asked for>\"}. It creates a project folder, starts a session that builds it there and opens the Studio so they watch it happen; then just tell them it has started. "
    "Changing Herald OS itself is different: for widgets, themes, fonts, the menu bar, control-menu entries, branding or keybindings, first read skill_view name=\"herald-os-bridge:herald-os-tailor\", which has the formats. "
    "A Herald OS widget is a folder in ~/.config/herald-os/plugins/<id> with a manifest.json; it is not a Hermes Desktop plugin or a build.start project, and the user turns it on in Settings > Plugins. "
    "How to act as this computer's operating environment: skill_view name=\"herald-os-bridge:herald-os\".",
    {
        "action": {"type": "string", "enum": ["run", "list", "state"], "description": "run a command, list the catalogue, or read the screen state"},
        "command": {"type": "string", "description": "Command id for action=run, e.g. page.open, memory.add, automation.pause"},
        "args": {"type": "object", "description": "Arguments for the command (see list)", "additionalProperties": True},
    },
    ["action"],
)

_UI_TIERS = {"read": Tier.READ, "act": Tier.ACT, "mutate": Tier.MUTATE, "destructive": Tier.DESTRUCTIVE}
_UI_CATALOGUE: dict[str, dict[str, Any]] = {}


def _ui_catalogue() -> dict[str, dict[str, Any]]:
    """Command id -> summary, fetched from the shell and cached for the life of the process."""
    if not _UI_CATALOGUE:
        for entry in ui.list_commands():
            if isinstance(entry, dict) and entry.get("id"):
                _UI_CATALOGUE[str(entry["id"])] = entry
    return _UI_CATALOGUE


def ui_tier_for(command: str, catalogue: dict[str, dict[str, Any]]) -> Tier:
    """The registry's declared tier drives approval; unknown commands are treated as mutating (pure; tested)."""
    entry = catalogue.get(command) or {}
    return _UI_TIERS.get(str(entry.get("tier") or ""), Tier.MUTATE)


def ui_summary(command: str, args: dict[str, Any], catalogue: dict[str, dict[str, Any]]) -> str:
    """One line for the approval card and the audit log (pure; tested)."""
    entry = catalogue.get(command) or {}
    title = str(entry.get("title") or command)
    detail = ", ".join(f"{k}={truncate(str(v), 40)}" for k, v in args.items() if v not in (None, ""))
    return f"{title} ({detail})" if detail else title


def handle_os_ui(args: dict[str, Any], **_: Any) -> str:
    action = str(args.get("action") or "run").strip().lower()
    try:
        if action == "list":
            return _read("os_ui", "list", args, lambda: {"commands": ui.summarise_commands(list(_ui_catalogue().values()))})
        if action == "state":
            return _read("os_ui", "state", args, ui.shell_state)
        if action != "run":
            return fail("action must be one of run, list, state")
        command = str(args.get("command") or "").strip()
        if not command:
            return fail("command is required for action=run (use action=list to see them)")
        raw_args = args.get("args")
        # Some models send the arguments as a JSON string; accept both.
        if isinstance(raw_args, str) and raw_args.strip().startswith("{"):
            try:
                raw_args = json.loads(raw_args)
            except json.JSONDecodeError:
                raw_args = {}
        command_args = raw_args if isinstance(raw_args, dict) else {}
        catalogue = _ui_catalogue()
        if catalogue and command not in catalogue:
            known = ", ".join(sorted(catalogue)[:40])
            return fail(f"unknown command '{command}'; known commands: {known}")
        tier = ui_tier_for(command, catalogue)
        summary = ui_summary(command, command_args, catalogue)

        def execute() -> dict[str, Any]:
            reply = ui.run_command(command, command_args)
            if not reply.get("ok"):
                raise RuntimeError(str(reply.get("error") or reply.get("summary") or "the shell refused the command"))
            # The shell's own one-liner ("Opened Memory") rides along as `result`; `summary` stays the audit line.
            payload = {k: v for k, v in reply.items() if k not in ("ok", "summary")}
            payload["result"] = reply.get("summary")
            payload["command"] = command
            return payload

        return _guarded("os_ui", tier, command, summary, {"command": command, "args": command_args}, (), execute)
    except ui.ShellUnavailable as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------------------------
# canvas: Herald Canvas, the layered image editor, through the shell's canvas.* commands
# ---------------------------------------------------------------------------------------------

_NUM = {"type": "number"}

CANVAS_ACTIONS: dict[str, str] = {
    "status": "canvas.status",
    "open": "canvas.open",
    "new": "canvas.new",
    "layers": "canvas.layers",
    "add_layer": "canvas.addLayer",
    "set_layer": "canvas.setLayer",
    "remove_layer": "canvas.removeLayer",
    "group": "canvas.group",
    "add_adjustment": "canvas.addAdjustment",
    "auto_adjust": "canvas.autoAdjust",
    "set_adjustment": "canvas.setAdjustment",
    "set_effects": "canvas.setEffects",
    "mask": "canvas.mask",
    "add_text": "canvas.addText",
    "set_text": "canvas.setText",
    "add_shape": "canvas.addShape",
    "set_shape": "canvas.setShape",
    "resize": "canvas.resize",
    "crop": "canvas.crop",
    "align": "canvas.align",
    "guides": "canvas.guides",
    "export": "canvas.export",
    "save": "canvas.save",
    "preview": "canvas.preview",
    "undo": "canvas.undo",
    "redo": "canvas.redo",
    "history": "canvas.history",
    "place_image": "canvas.placeImage",
    "remove_background": "canvas.removeBackground",
    "content_fill": "canvas.contentFill",
    "filter": "canvas.filter",
}

# What each action passes on; anything else in the call is dropped.
CANVAS_ARGS: dict[str, tuple[str, ...]] = {
    "status": (),
    "open": ("path",),
    "new": ("name", "width", "height", "background", "resolution", "folder"),
    "layers": ("project",),
    "add_layer": ("project", "source", "color", "gradient", "style", "angle", "fit", "x", "y", "width", "height", "name", "opacity", "blend", "above", "folder", "clip"),
    "set_layer": ("project", "layer", "name", "visible", "opacity", "blend", "x", "y", "width", "height", "rotation", "flipX", "flipY", "clip", "order", "folder"),
    "remove_layer": ("project", "layer"),
    "group": ("project", "layers", "name", "above", "folder"),
    "add_adjustment": ("project", "kind", "settings", "name", "opacity", "blend", "above", "folder", "clip"),
    "auto_adjust": ("project", "kind", "cutoff", "name", "above", "folder", "clip"),
    "set_adjustment": ("project", "layer", "settings", "opacity", "blend"),
    "set_effects": ("project", "layer", "effects", "from", "clear"),
    "mask": ("project", "layer", "mask"),
    "add_text": ("project", "content", "x", "y", "width", "height", "font", "size", "color", "align", "tracking", "leading", "name", "opacity", "blend", "above", "folder", "clip"),
    "set_text": ("project", "layer", "content", "font", "size", "color", "align", "tracking", "leading"),
    "add_shape": ("project", "kind", "x", "y", "width", "height", "color", "radius", "lineWidth", "name", "opacity", "blend", "above", "folder", "clip"),
    "set_shape": ("project", "layer", "kind", "color", "radius", "lineWidth"),
    "resize": ("project", "width", "height", "anchor", "scale", "image", "resample"),
    "crop": ("project", "x", "y", "width", "height", "ratio", "angle"),
    "align": ("project", "layers", "edge", "to", "margin", "distribute"),
    "guides": ("project", "guide", "axis", "position", "margins", "columns", "gutter", "center"),
    "export": ("project", "to", "format", "quality", "scale", "overwrite"),
    "save": ("project", "to", "overwrite"),
    "preview": ("project", "size"),
    "undo": ("project", "steps"),
    "redo": ("project", "steps"),
    "history": ("project",),
    "place_image": ("project", "source", "x", "y", "width", "height", "fit", "mask_image", "name", "opacity", "blend", "above", "folder", "clip"),
    "remove_background": ("project", "layer", "mode", "threshold", "feather", "refine"),
    "content_fill": ("project", "layer", "x", "y", "width", "height", "newLayer", "sampling"),
    "filter": ("project", "layer", "kind", "settings", "inSelection"),
}

# Loading, rendering and saving a large image can take a while.
CANVAS_TIMEOUT = 100.0

CANVAS_SCHEMA = _schema(
    "canvas",
    "Herald Canvas, the layered image editor built into Herald OS (layers, folders, masks, blend modes, adjustment layers, like Photoshop). "
    "Use it to make or change pictures: posters, banners, thumbnails, collages, photo fixes. The person watches every change land in the Canvas window, and each one is a step they can undo. "
    "Start with action=new (a new project; it answers with the path) or action=open (an image or a .comp project), then add_layer, add_text, add_shape, set_layer, set_text, set_shape, add_adjustment, set_adjustment, group and remove_layer; align lines layers up (or distributes them) exactly; auto_adjust fixes a photo's tone or colour cast as an editable Levels layer; guides lays out margins, columns and centre lines; set_effects adds drop shadows, strokes, glows and overlays (or copies them from another layer); mask shows or hides parts of a layer; resize and crop change the canvas. "
    "Look at your work with action=preview: it answers with a PNG file you can view. action=layers lists the layers with ids and placement; action=history lists every step (undo or redo with steps to move through them); action=export writes PNG, JPEG, WebP or a layered PSD; action=open takes .psd files with their layers. "
    "On-device tools: remove_background (hides a layer's background with a mask, or cuts the subject out) and content_fill (fills a box from the pixels around it, to remove something); filter sharpens, denoises or blurs a layer's pixels. place_image puts a picture in an exact box, optionally masked (mask_image), which is how a generated picture lands where the person asked. "
    "Coordinates are canvas pixels from the top-left. Before a real design job read skill_view name=\"herald-os-bridge:herald-canvas\": the workflow, good design habits, the .comp format and every adjustment setting.",
    {
        "action": _enum(*CANVAS_ACTIONS, description="What to do"),
        "project": _desc(_STR, "The .comp project (full path or ~/...); the image in front when left out"),
        "path": _desc(_STR, "open: an image or .comp project to show"),
        "name": _desc(_STR, "new: the project name; add_layer, add_text, add_shape, group, add_adjustment: the layer name; set_layer: a new name"),
        "width": _desc(_NUM, "new: canvas width (1920); add_layer, set_layer, add_shape, place_image: width in canvas pixels; add_text: a paragraph box this wide; resize: the new canvas width; crop: the width kept; content_fill: the width of the area to fill"),
        "height": _desc(_NUM, "new: canvas height (1080); add_layer, set_layer, add_shape, place_image: height in canvas pixels; add_text: the paragraph box height; resize: the new canvas height; crop: the height kept; content_fill: the height of the area to fill"),
        "background": _desc(_STR, "new: white, black, transparent or any CSS colour"),
        "resolution": _desc(_NUM, "new: pixels per inch (72)"),
        "source": _desc(_STR, "add_layer: an image file or an http(s) URL"),
        "color": _desc(_STR, "add_layer: a solid fill; add_text, set_text: the text colour; add_shape, set_shape: the fill (any CSS colour)"),
        "content": _desc(_STR, "add_text, set_text: the words (\\n starts a new line)"),
        "font": _desc(_STR, "add_text, set_text: an installed font family with a style if wanted, e.g. \"Helvetica Neue Bold\", \"Georgia Italic\""),
        "align": _enum("left", "center", "right", description="add_text, set_text: text alignment; for point text x is the left edge, centre or right edge accordingly"),
        "tracking": _desc(_NUM, "add_text, set_text: extra space between letters, in pixels (-100 to 1000)"),
        "leading": _desc(_NUM, "add_text, set_text: line spacing from baseline to baseline, in pixels (0 to 5000; 0 is automatic, 120% of the size)"),
        "radius": _desc(_NUM, "add_shape, set_shape: corner radius of a rectangle, in pixels"),
        "lineWidth": _desc(_NUM, "add_shape, set_shape: thickness of a line, in pixels (4); add_shape's line runs from (x, y) to (x + width, y + height)"),
        "anchor": _enum("center", "top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right", description="resize: where the canvas grows or shrinks from (center)"),
        "image": _desc(_BOOL, "resize: scale the whole image to width/height instead of changing the canvas"),
        "resample": _desc(_BOOL, "resize: when scaling, recalculate layer pixels too (default true)"),
        "gradient": _desc(_STR, "add_layer: the gradient's colours first to last, comma-separated, each with an optional position, e.g. \"#000 0%, #335 60%, #fff\"; transparent colours (#00000000) fade"),
        "style": _enum("linear", "radial", "angle", "reflected", "diamond", description="add_layer: how the gradient lies: linear (the default), radial (from the centre out), angle (a sweep around the centre), reflected (mirrored from the centre line) or diamond"),
        "angle": _desc(_NUM, "add_layer: gradient direction in degrees (0 left to right, 90 top to bottom); crop: degrees to turn the picture clockwise first, to level a horizon (negative turns it counterclockwise), then the crop keeps the largest box with no empty corners"),
        "ratio": _desc(_STR, "crop: width:height to hold the box to, e.g. 1:1, 4:5, 3:2, 16:9, 9:16 or original; alone it keeps the largest centred box of that shape"),
        "fit": _enum("contain", "cover", "none", "stretch", description="add_layer: how a picture fills the canvas when no box is given; place_image: cover (the default), contain or stretch in its box"),
        "x": _desc(_NUM, "Left edge in canvas pixels (add_text with align=center or right: the centre or right edge)"),
        "y": _desc(_NUM, "Top edge in canvas pixels"),
        "rotation": _desc(_NUM, "set_layer: degrees clockwise around the layer's centre"),
        "flipX": _desc(_BOOL, "set_layer: mirror left to right"),
        "flipY": _desc(_BOOL, "set_layer: mirror top to bottom"),
        "opacity": _desc(_NUM, "0 to 1"),
        "blend": _desc(_STR, "Blend mode, e.g. Normal, Multiply, Screen, Overlay, Soft Light, Color, Luminosity"),
        "layer": _desc(_STR, "set_layer, set_text, set_shape, remove_layer, set_adjustment, set_effects, mask: the layer's id or name; remove_background, content_fill: the layer (the active one when left out)"),
        "layers": _desc(_STR, "group: comma-separated layer ids or names; align: the layers to line up or distribute"),
        "edge": _desc(_STR, "align: left, center, right, top, middle or bottom; two separated by a comma align both ways, e.g. \"bottom,right\" or \"center,middle\""),
        "margin": _desc(_NUM, "align with to=canvas: pixels to keep from the canvas edges"),
        "distribute": _desc(_STR, "align: space three or more layers evenly instead: horizontal or vertical (equal gaps), or left, center, right, top, middle or bottom"),
        "visible": _desc(_BOOL, "set_layer: show or hide"),
        "order": _enum("up", "down", "top", "bottom", description="set_layer: move among its neighbours"),
        "above": _desc(_STR, "Put the new layer right above this one"),
        "folder": _desc(_STR, "new: where the project goes; add_layer, add_adjustment: put it in this folder; set_layer: move into it (\"none\" takes it out)"),
        "clip": _desc(_BOOL, "Clip to the layer below (shows only where it has pixels); false lets go"),
        "kind": _desc(_STR, "add_adjustment: Hue/Saturation, Levels, Curves, Exposure, Gradient Map, Grain, Invert, Black & White, Color Balance, Gaussian Blur, Motion Blur or Add Noise, or Herald's own Brightness/Contrast, Vibrance, Photo Filter, Channel Mixer, Selective Color, Posterize, Threshold or Color Lookup (settings {\"table\": \"~/LUTs/Film.cube\"}); add_shape, set_shape: rectangle, rounded, ellipse or line; auto_adjust: tone (the default), contrast or color; filter: unsharp mask (sharpen), smart sharpen, reduce noise, gaussian blur, motion blur, high pass, add noise or median"),
        "inSelection": _desc(_BOOL, "filter: only inside what the person selected in the open window"),
        "cutoff": _desc(_NUM, "auto_adjust: percentage of the darkest and of the lightest pixels to ignore, 0 to 10 (0.1)"),
        "settings": {"type": "object", "description": "add_adjustment: settings over the defaults, e.g. {\"saturation\": 25} or {\"brightness\": 20, \"contrast\": 15}; set_adjustment: settings merged over the layer's own; Color Lookup: {\"table\": \"a .cube file\"}; filter: the filter's settings, e.g. {\"amount\": 120, \"radius\": 1.2}", "additionalProperties": True},
        "effects": {
            "type": "object",
            "description": "set_effects: per effect (stroke, shadow, innerShadow, outerGlow, innerGlow, colorOverlay) an object merged over its settings or defaults, false to remove it, {\"enabled\": false} to hide it; e.g. {\"shadow\": {\"distance\": 12, \"blur\": 24, \"opacity\": 0.4}}",
            "additionalProperties": True,
        },
        "clear": _desc(_BOOL, "set_effects: remove every effect first"),
        "from": _desc(_STR, "set_effects: a layer (id or name) whose effects to copy onto this one, replacing its own; effects then changes them further"),
        "mask": _enum("reveal", "hide", "revealSelection", "hideSelection", "invert", "apply", "enable", "disable", "remove", "link", "unlink", description="mask: what to do to the layer's mask (reveal and hide make one showing or hiding everything)"),
        "to": _desc(_STR, "export: the file to write; save: a new project path; align: what to line up with: canvas (the default for one layer), layers (each other, the default for several) or selection"),
        "format": _enum("png", "jpeg", "webp", "psd", description="export: the format (from the file name when left out); psd keeps the layers"),
        "quality": _desc(_NUM, "export: JPEG or WebP quality, 0 to 1"),
        "scale": _desc(_NUM, "export: size relative to the canvas; resize: scale the whole image by this much (0.5 is half)"),
        "overwrite": _desc(_BOOL, "export, save: replace an existing file (asks the person first)"),
        "size": _desc(_NUM, "preview: longest side in pixels (1024); add_text, set_text: font size in pixels (72)"),
        "mask_image": _desc(_STR, "place_image: a grayscale image over the same box (white shows the picture, black hides it), such as the mask Herald saved for generative fill"),
        "mode": _enum("mask", "cutout", description="remove_background: hide the background with a layer mask (mask, the default) or put just the subject on a new layer (cutout)"),
        "threshold": _desc(_NUM, "remove_background: where the edge sits, 0 to 1 (0.5); lower keeps more"),
        "feather": _desc(_NUM, "remove_background: softens the edge, in pixels"),
        "refine": _desc(_BOOL, "remove_background: snap the edge to the picture's own outlines such as hair (default true)"),
        "newLayer": _desc(_BOOL, "content_fill: put the fill on a new layer above instead of into the layer"),
        "sampling": _enum("around", "all", description="content_fill: copy from around the box (around, the default) or from anywhere in the layer"),
        "steps": _desc(_NUM, "undo, redo: how many steps to take (1); action=history lists them"),
        "guide": _enum("add", "remove", "clear", "list", description="guides: what to do with the guides (lines layers, crops and selections snap to; they never export)"),
        "axis": _enum("vertical", "horizontal", description="guides: vertical is a line down the canvas at an x, horizontal a line across at a y"),
        "position": _desc(_STR, "guides: pixels from the left (vertical) or top (horizontal), or a percentage like \"50%\""),
        "margins": _desc(_STR, "guides add: four guides this far in from the edges, pixels or a percentage of the short side"),
        "columns": _desc(_NUM, "guides add: equal columns between the margins"),
        "gutter": _desc(_NUM, "guides add: pixels between columns"),
        "center": _desc(_BOOL, "guides add: lines through the middle, both ways"),
    },
    ["action"],
)


def canvas_command(args: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """``(action, command id, command args)`` for a canvas call (pure; tested)."""
    action = str(args.get("action") or "").strip().lower()
    if action not in CANVAS_ACTIONS:
        raise ValueError(f"action must be one of {', '.join(CANVAS_ACTIONS)}")
    command_args = {key: args[key] for key in CANVAS_ARGS[action] if key in args and args[key] not in (None, "")}
    # The shell takes adjustment settings and layer effects as JSON text.
    for key in ("settings", "effects"):
        if isinstance(command_args.get(key), (dict, list)):
            command_args[key] = json.dumps(command_args[key])
    # `action` already names the tool's action, so the mask's own one travels as `mask`.
    if action == "mask" and "mask" in command_args:
        command_args["action"] = command_args.pop("mask")
    # The guides' own action travels as `guide` for the same reason.
    if action == "guides" and "guide" in command_args:
        command_args["action"] = command_args.pop("guide")
    # `mask` is taken by the mask action, so place_image's mask file travels as `mask_image`.
    if action == "place_image" and "mask_image" in command_args:
        command_args["mask"] = command_args.pop("mask_image")
    return action, CANVAS_ACTIONS[action], command_args


_TIER_ORDER = [Tier.READ, Tier.ACT, Tier.MUTATE, Tier.DESTRUCTIVE]


def canvas_tier(action: str, command: str, command_args: dict[str, Any], catalogue: dict[str, dict[str, Any]]) -> Tier:
    """The registry's tier, raised to mutate when the call would replace a file the person has (pure; tested)."""
    tier = ui_tier_for(command, catalogue)
    target = command_args.get("to")
    replaces = action in ("export", "save") and (command_args.get("overwrite") is True or (isinstance(target, str) and target.strip() and expand(target).exists()))
    if replaces and _TIER_ORDER.index(tier) < _TIER_ORDER.index(Tier.MUTATE):
        return Tier.MUTATE
    return tier


def handle_canvas(args: dict[str, Any], **_: Any) -> str:
    try:
        action, command, command_args = canvas_command(args)
    except ValueError as exc:
        return fail(str(exc))
    try:
        catalogue = _ui_catalogue()
        if catalogue and command not in catalogue:
            return fail("Herald Canvas is not in this version of Herald OS; update Herald OS first")
        tier = canvas_tier(action, command, command_args, catalogue)
        summary = ui_summary(command, command_args, catalogue)

        def execute() -> dict[str, Any]:
            reply = ui.run_command(command, command_args, timeout=CANVAS_TIMEOUT)
            if not reply.get("ok"):
                raise RuntimeError(str(reply.get("error") or reply.get("summary") or "Herald Canvas refused that"))
            payload = {k: v for k, v in reply.items() if k not in ("ok", "summary")}
            payload["result"] = reply.get("summary")
            return payload

        return _guarded("canvas", tier, action, summary, {"action": action, **command_args}, (), execute)
    except ui.ShellUnavailable as exc:
        return fail(str(exc))


# ---------------------------------------------------------------------------------------------
# docs and sheets: Herald Docs and Herald Sheets through the shell's docs.* and sheets.* commands
# ---------------------------------------------------------------------------------------------

DOCS_ACTIONS: dict[str, str] = {
    "list": "docs.list",
    "list_all": "office.list",
    "open": "docs.open",
    "new": "docs.new",
    "read": "docs.read",
    "find": "docs.find",
    "write": "docs.write",
    "replace": "docs.replace",
    "format": "docs.format",
    "table": "docs.insertTable",
    "image": "docs.insertImage",
    "page": "docs.setPage",
    "edit": "docs.edit",
    "insert_range": "docs.insertRange",
    "save": "docs.save",
    "export_pdf": "docs.exportPdf",
    "undo": "docs.undo",
    "redo": "docs.redo",
}

# What each action passes on; anything else in the call is dropped.
DOCS_ARGS: dict[str, tuple[str, ...]] = {
    "list": (),
    "list_all": (),
    "open": ("path",),
    "new": ("name", "content", "template", "path"),
    "read": ("document", "part", "heading", "maxChars"),
    "find": ("document", "text", "caseSensitive", "wholeWord", "regex"),
    "write": ("document", "content", "format", "at", "heading", "mode"),
    "replace": ("document", "find", "replacement", "all", "caseSensitive", "wholeWord", "regex"),
    "format": ("document", "at", "heading", "text", "style", "bold", "italic", "underline", "strike", "color", "highlight", "font", "size", "link", "align", "lineSpacing", "clear", "caseSensitive", "wholeWord", "regex"),
    "table": ("document", "cells", "rows", "cols", "header", "at", "heading", "mode"),
    "image": ("document", "source", "alt", "width", "at", "heading", "mode"),
    "page": ("document", "size", "orientation", "margins"),
    "edit": ("document", "edits"),
    "insert_range": ("document", "workbook", "range", "sheet", "header", "at", "heading", "mode"),
    "save": ("document", "to", "overwrite"),
    "export_pdf": ("document", "to", "overwrite"),
    "undo": ("document", "steps"),
    "redo": ("document", "steps"),
}

SHEETS_ACTIONS: dict[str, str] = {
    "list": "sheets.list",
    "list_all": "office.list",
    "open": "sheets.open",
    "new": "sheets.new",
    "read": "sheets.read",
    "find": "sheets.find",
    "write": "sheets.write",
    "fill": "sheets.fill",
    "format": "sheets.format",
    "sort": "sheets.sort",
    "filter": "sheets.filter",
    "freeze": "sheets.freeze",
    "add_sheet": "sheets.addSheet",
    "rename_sheet": "sheets.renameSheet",
    "remove_sheet": "sheets.removeSheet",
    "replace": "sheets.replace",
    "clean": "sheets.clean",
    "recommend_charts": "sheets.recommendCharts",
    "insert_chart": "sheets.insertChart",
    "list_charts": "sheets.listCharts",
    "describe_chart": "sheets.describeChart",
    "update_chart": "sheets.updateChart",
    "move_chart": "sheets.moveChart",
    "remove_chart": "sheets.removeChart",
    "summarize": "sheets.summarize",
    "refresh_summary": "sheets.refreshSummary",
    "list_summaries": "sheets.listSummaries",
    "remove_duplicates": "sheets.removeDuplicates",
    "split_text": "sheets.splitText",
    "trim_text": "sheets.trimText",
    "change_case": "sheets.changeCase",
    "convert_to_numbers": "sheets.convertToNumbers",
    "convert_to_dates": "sheets.convertToDates",
    "fill_down": "sheets.fillDown",
    "highlight_duplicates": "sheets.highlightDuplicates",
    "sort_by": "sheets.sortBy",
    "list_names": "sheets.listNames",
    "create_name": "sheets.createName",
    "update_name": "sheets.updateName",
    "delete_name": "sheets.deleteName",
    "go_to_name": "sheets.goToName",
    "set_validation": "sheets.setValidation",
    "get_validation": "sheets.getValidation",
    "clear_validation": "sheets.clearValidation",
    "list_comments": "sheets.listComments",
    "add_comment": "sheets.addComment",
    "reply_to_comment": "sheets.replyToComment",
    "resolve_comment": "sheets.resolveComment",
    "delete_comment": "sheets.deleteComment",
    "list_notes": "sheets.listNotes",
    "set_note": "sheets.setNote",
    "remove_note": "sheets.removeNote",
    "edit": "sheets.edit",
    "save": "sheets.save",
    "export_pdf": "sheets.exportPdf",
    "undo": "sheets.undo",
    "redo": "sheets.redo",
}

_CHART_SETTINGS = ("kind", "title", "series", "categories", "legend", "labels", "axes", "stacking", "palette", "hole")

SHEETS_ARGS: dict[str, tuple[str, ...]] = {
    "list": (),
    "list_all": (),
    "open": ("path",),
    "new": ("name", "values", "template", "path"),
    "read": ("workbook", "range", "sheet", "formulas"),
    "find": ("workbook", "text", "sheet", "caseSensitive", "wholeCell", "formulas"),
    "write": ("workbook", "range", "values", "sheet"),
    "fill": ("workbook", "range", "formula", "sheet"),
    "format": ("workbook", "range", "format", "sheet"),
    "sort": ("workbook", "range", "by", "ascending", "header", "sheet"),
    "filter": ("workbook", "range", "by", "values", "condition", "clear", "sheet"),
    "freeze": ("workbook", "rows", "columns", "sheet"),
    "add_sheet": ("workbook", "name", "index"),
    "rename_sheet": ("workbook", "sheet", "name"),
    "remove_sheet": ("workbook", "sheet"),
    "replace": ("workbook", "find", "replacement", "range", "sheet", "all", "caseSensitive", "wholeCell", "formulas"),
    "clean": ("workbook", "range", "clean", "header", "by", "delimiter", "overwrite", "dateFormat", "order", "case", "sheet"),
    "recommend_charts": ("workbook", "range", "sheet"),
    "insert_chart": ("workbook", "range", *_CHART_SETTINGS, "at", "width", "height", "sheet"),
    "list_charts": ("workbook", "sheet"),
    "describe_chart": ("workbook", "chart"),
    "update_chart": ("workbook", "chart", *_CHART_SETTINGS, "range"),
    "move_chart": ("workbook", "chart", "at", "width", "height"),
    "remove_chart": ("workbook", "chart"),
    "summarize": ("workbook", "range", "rowFields", "columnFields", "valueFields", "filters", "destination", "preview", "sheet"),
    "refresh_summary": ("workbook", "summary", "sheet"),
    "list_summaries": ("workbook", "sheet"),
    "remove_duplicates": ("workbook", "range", "by", "header", "preview", "sheet"),
    "split_text": ("workbook", "range", "delimiter", "consecutive", "destination", "overwrite", "header", "preview", "sheet"),
    "trim_text": ("workbook", "range", "sheet"),
    "change_case": ("workbook", "range", "case", "sheet"),
    "convert_to_numbers": ("workbook", "range", "preview", "sheet"),
    "convert_to_dates": ("workbook", "range", "order", "dateFormat", "preview", "sheet"),
    "fill_down": ("workbook", "range", "sheet"),
    "highlight_duplicates": ("workbook", "range", "color", "clear", "sheet"),
    "sort_by": ("workbook", "range", "keys", "header", "sheet"),
    "list_names": ("workbook",),
    "create_name": ("workbook", "name", "refersTo", "scope", "comment"),
    "update_name": ("workbook", "name", "newName", "refersTo", "comment", "scope"),
    "delete_name": ("workbook", "name", "scope"),
    "go_to_name": ("workbook", "name", "scope"),
    "set_validation": ("workbook", "range", "rule", "allowBlank", "dropdown", "input", "alert", "sheet"),
    "get_validation": ("workbook", "range", "sheet"),
    "clear_validation": ("workbook", "range", "sheet"),
    "list_comments": ("workbook", "sheet"),
    "add_comment": ("workbook", "cell", "text", "sheet"),
    "reply_to_comment": ("workbook", "cell", "commentId", "text", "sheet"),
    "resolve_comment": ("workbook", "cell", "commentId", "resolved", "sheet"),
    "delete_comment": ("workbook", "cell", "commentId", "sheet"),
    "list_notes": ("workbook", "sheet"),
    "set_note": ("workbook", "cell", "text", "sheet"),
    "remove_note": ("workbook", "cell", "sheet"),
    "edit": ("workbook", "edits"),
    "save": ("workbook", "to", "overwrite"),
    "export_pdf": ("workbook", "to", "overwrite"),
    "undo": ("workbook", "steps"),
    "redo": ("workbook", "steps"),
}

SLIDES_ACTIONS: dict[str, str] = {
    "list": "slides.list",
    "list_all": "office.list",
    "open": "slides.open",
    "new": "slides.new",
    "read": "slides.read",
    "find": "slides.find",
    "add_slide": "slides.addSlide",
    "set_slide": "slides.setSlide",
    "duplicate_slide": "slides.duplicateSlide",
    "move_slide": "slides.moveSlide",
    "remove_slide": "slides.removeSlide",
    "add_text": "slides.addText",
    "add_shape": "slides.addShape",
    "add_image": "slides.addImage",
    "add_table": "slides.addTable",
    "set_theme": "slides.setTheme",
    "replace": "slides.replace",
    "edit": "slides.edit",
    "from_document": "slides.fromDocument",
    "insert_range": "slides.insertRange",
    "save": "slides.save",
    "export_pdf": "slides.exportPdf",
    "undo": "slides.undo",
    "redo": "slides.redo",
}

SLIDES_ARGS: dict[str, tuple[str, ...]] = {
    "list": (),
    "list_all": (),
    "open": ("path",),
    "new": ("name", "slides", "theme", "size", "path"),
    "read": ("presentation", "slide"),
    "find": ("presentation", "text", "caseSensitive"),
    "add_slide": ("presentation", "layout", "title", "body", "notes", "after"),
    "set_slide": ("presentation", "slide", "title", "body", "notes", "layout", "hidden", "background"),
    "duplicate_slide": ("presentation", "slide"),
    "move_slide": ("presentation", "slide", "to"),
    "remove_slide": ("presentation", "slide"),
    "add_text": ("presentation", "slide", "text", "x", "y", "width", "height", "size", "color", "bold", "align"),
    "add_shape": ("presentation", "slide", "kind", "x", "y", "width", "height", "fill", "text"),
    "add_image": ("presentation", "slide", "source", "x", "y", "width", "height", "fit"),
    "add_table": ("presentation", "slide", "cells", "rows", "columns", "x", "y", "width"),
    "set_theme": ("presentation", "theme"),
    "replace": ("presentation", "find", "replacement", "all", "caseSensitive"),
    "edit": ("presentation", "edits"),
    "from_document": ("document", "presentation", "level", "notes"),
    "insert_range": ("presentation", "slide", "workbook", "range", "sheet", "x", "y", "width"),
    "save": ("presentation", "to", "overwrite"),
    "export_pdf": ("presentation", "to", "overwrite"),
    "undo": ("presentation", "steps"),
    "redo": ("presentation", "steps"),
}

# Reading, rewriting and writing back a long document, a big workbook or a deck can take a while.
OFFICE_TIMEOUT = 100.0

_ROWS = {"type": "array", "items": {"type": "array", "items": _STR}}
_OBJECTS = {"type": "array", "items": {"type": "object", "additionalProperties": True}}

DOCS_SCHEMA = _schema(
    "docs",
    "Herald Docs, the word processor built into Herald OS: letters, reports, essays, resumes, notes and any other document, in the Docs window the person watches or in Word (.docx), Markdown (.md) and text files. "
    "Look before you change anything: action=list shows the documents open in Herald Docs (list_all: everything open in Herald Docs, Sheets and Slides, with what is selected in each), read gives a document's outline and its content as Markdown (part=selection: the selected and the marked text), find finds text; open shows a file, and new starts a document (blank, from a template, or with the content you write from the person's brief). "
    "Change it with write (Markdown: headings, bold and italic, lists, tables, links, pictures from files), replace, format (paragraph styles, bold, colour, highlight, size, alignment, links), table, image, page (paper, orientation, margins) and insert_range (a Herald Sheets range as a table: work across documents, such as a budget's figures in a report). "
    "Every call is one step the person can undo, so land a whole change in one call; action=edit makes several changes as ONE step. When the request says text is marked for it, read part=selection and write the answer with at=marked, which replaces the marked text. "
    "document is a file (~/... or /...) or an open document's name as its tab shows it (\"Untitled 2\", \"Report.docx\"); left out, the one in front. An open document changes in its window; a file that is not open is changed on disk, which asks the person first. "
    "Never save unless the person asks: saving over a file asks them, and the first time shows what Herald cannot keep. "
    "Before drafting or editing a real document read skill_view name=\"herald-os-bridge:herald-docs\": the workflow, templates, rewriting marked text, formatting, tables and saving.",
    {
        "action": _enum(*DOCS_ACTIONS, description="What to do"),
        "document": _desc(_STR, "The document: a file (full path or ~/...) or an open document's name as its tab shows it; the one in front in Herald Docs when left out. insert_range: the document the table goes in"),
        "path": _desc(_STR, "open: a .docx, .md or .txt file to show; new: save the new document here at once (a new .docx, .md or .txt file, never one that exists)"),
        "name": _desc(_STR, "new: the tab's name, and the file name it is offered when saved"),
        "content": _desc(_STR, "new: what the document starts with; write: what to write. Markdown: # headings, **bold**, *italic*, lists, - [ ] tasks, tables, [links](https://...), > quotes, `code`, pictures from files as ![what it shows](~/path.png)"),
        "template": _desc(_STR, "new: letter, cover letter, report, memo, meeting notes, resume, proposal or essay; write the person's content into it afterwards"),
        "part": _desc(_STR, "read: markdown (the default), text, outline, or selection (the selected text and the text marked for this request, in an open document)"),
        "heading": _desc(_STR, "read: only this heading's section; write, table, image, insert_range with at=heading, and format with at=heading or section: the heading, by its text or its number in the outline from 1"),
        "maxChars": _desc(_NUM, "read: at most this many characters of content (20000); read a long document section by section"),
        "text": _desc(_STR, "find: what to find; format with at=text: the words to format, wherever they appear"),
        "caseSensitive": _desc(_BOOL, "find, replace, format at=text: match upper and lower case exactly"),
        "wholeWord": _desc(_BOOL, "find, replace, format at=text: whole words only"),
        "regex": _desc(_BOOL, "find, replace, format at=text: the text is a regular expression"),
        "format": _desc(_STR, "write: markdown (the default) or text"),
        "at": _desc(_STR, "write, table, image, insert_range: where it goes: end (the default), start, selection (in place of what is selected, or at the caret), marked (in place of the text Herald marked for this request), after (under the paragraph the selection is in) or heading; format: what to format: selection (the default), marked, all, heading (the heading line), section (the heading and its section) or text"),
        "mode": _desc(_STR, "With heading: append (at the end of its section, the default), prepend (right under the heading) or replace (in place of the section, keeping the heading)"),
        "find": _desc(_STR, "replace: the text to replace"),
        "replacement": _desc(_STR, "replace: what goes in its place (left out deletes the matches); each replacement keeps the formatting where its match starts"),
        "all": _desc(_BOOL, "replace: every match (true, the default) or only the first (false)"),
        "style": _desc(_STR, "format: the paragraph style: normal, title, subtitle, heading1 to heading6, quote or code"),
        "bold": _desc(_BOOL, "format: bold on (true) or off (false)"),
        "italic": _desc(_BOOL, "format: italic on or off"),
        "underline": _desc(_BOOL, "format: underline on or off"),
        "strike": _desc(_BOOL, "format: strikethrough on or off"),
        "color": _desc(_STR, "format: the text colour (any CSS colour), or none"),
        "highlight": _desc(_STR, "format: a highlight colour, or none"),
        "font": _desc(_STR, "format: a font family, or none"),
        "size": _desc(_STR, "format: the font size in points, e.g. \"14\" (0 goes back to the style's); page: the paper, a4 or letter"),
        "link": _desc(_STR, "format: a web address to link the text to, or none"),
        "align": _desc(_STR, "format: left, center, right or justify"),
        "lineSpacing": _desc(_NUM, "format: line spacing as a multiple: 1, 1.15, 1.5 or 2"),
        "clear": _desc(_BOOL, "format: clear the formatting first"),
        "cells": _desc(_ROWS, "table: the rows of cells as text, the header row first: [[\"Item\", \"Cost\"], [\"Rent\", \"1,200\"]]"),
        "rows": _desc(_NUM, "table: rows of an empty table, instead of cells"),
        "cols": _desc(_NUM, "table: columns of an empty table, instead of cells"),
        "header": _desc(_BOOL, "table, insert_range: the first row is a header row (true, the default)"),
        "source": _desc(_STR, "image: the picture file, PNG, JPEG, GIF, WebP, BMP or SVG (full path or ~/...)"),
        "alt": _desc(_STR, "image: what the picture shows, for screen readers"),
        "width": _desc(_NUM, "image: width in pixels (never wider than the text)"),
        "orientation": _desc(_STR, "page: portrait or landscape"),
        "margins": _desc(_STR, "page: all four margins, in points or with a unit (\"1in\", \"2cm\", \"20mm\")"),
        "edits": _desc(_OBJECTS, "edit: the changes, made in order as ONE step to undo, each seeing the document as the ones before left it; each has an op and that op's arguments: write (content, format, at, heading, mode), replace (find, replacement, all, caseSensitive, wholeWord, regex), format (the format arguments), table (cells or rows and cols, header, at, heading, mode), image (source, alt, at, heading, mode), pageBreak (at, heading, mode) and page (size, orientation, margins). E.g. [{\"op\": \"write\", \"content\": \"## Summary\\n...\", \"at\": \"start\"}, {\"op\": \"replace\", \"find\": \"draft\", \"replacement\": \"final\"}]"),
        "workbook": _desc(_STR, "insert_range: the Herald Sheets workbook, a file or an open workbook's name (the one in front in Herald Sheets when left out)"),
        "range": _desc(_STR, "insert_range: the cells, like A1:D12 or 'Q1 sales'!B2:F9, or selection; the workbook's selection, or else its cells that hold something, when left out"),
        "sheet": _desc(_STR, "insert_range: the sheet, when the range does not name it"),
        "to": _desc(_STR, "save: save as this new file instead (.docx, .md or .txt; full path or ~/...); export_pdf: the PDF to write (a new file in ~/Documents when left out)"),
        "overwrite": _desc(_BOOL, "save, export_pdf: replace the file at to (asks the person first)"),
        "steps": _desc(_NUM, "undo, redo: how many steps (1)"),
    },
    ["action"],
)

SHEETS_SCHEMA = _schema(
    "sheets",
    "Herald Sheets, the spreadsheet built into Herald OS: Excel workbooks (.xlsx) and CSV files, in the Sheets window the person watches or on disk. "
    "Read before you change anything: action=list shows the workbooks open in Herald Sheets (list_all: everything open in Herald Docs, Sheets and Slides, with what is selected in each), read gives the sheets and a range's values, formulas and what the cells show (without range, the cells that hold something; range=selection, what is selected), find finds text; open shows a file, and new starts a workbook (blank, from a template, or with rows of values and formulas). "
    "write puts rows of values from a cell (text starting with = is a formula, English function names and commas between arguments; plain numbers become numbers), fill copies a formula down or across, format sets number formats, fonts, colours and borders; sort, filter, freeze, replace, clean (dedupe, trim, numbers, dates, split, case), add_sheet, rename_sheet and remove_sheet do what they say. "
    "It also makes charts (recommend_charts first, then insert_chart; the others take the chart's id), pivot-style summaries in live formulas (summarize), named ranges, validation (dropdown lists, input messages, error alerts), and comments and notes on cells (yours are signed Hermes); its data tools remove duplicates, split, trim, recase and convert text, fill down, highlight duplicates and sort by several columns, and preview=true shows a big change before it lands. "
    "Every call is one step the person can undo (comment threads aside), so land a whole change in one call; action=edit makes several changes as ONE step. "
    "workbook is a file (~/... or /...) or an open workbook's name as its tab shows it; left out, the one in front. An open workbook changes in its window; a file that is not open is changed on disk, which asks the person first. "
    "Never save unless the person asks: saving over a file asks them, and the first time shows what Herald cannot keep; a CSV file keeps only values. A range goes into a document with the docs tool's insert_range. "
    "Before building, cleaning or analysing a real spreadsheet read skill_view name=\"herald-os-bridge:herald-sheets\": the workflow, formulas, filling from examples, cleaning data, charts, summaries, names, validation, comments and building a workbook.",
    {
        "action": _enum(*SHEETS_ACTIONS, description="What to do"),
        "workbook": _desc(_STR, "The workbook: a file (full path or ~/...) or an open workbook's name as its tab shows it; the one in front in Herald Sheets when left out"),
        "path": _desc(_STR, "open: an .xlsx or .csv file to show; new: save the new workbook here at once (a new .xlsx or .csv file, never one that exists)"),
        "name": _desc(_STR, "new: the tab's name, and the file name it is offered when saved; add_sheet: the new sheet's name (at most 31 characters, none of [ ] : * ? / \\); rename_sheet: the sheet's new name; create_name, update_name, delete_name, go_to_name: the named range, like TaxRate (update_name: as it is now)"),
        "template": _desc(_STR, "new: budget, expenses, todo, schedule or invoice"),
        "values": _desc(_ROWS, "write, new: rows of cells from the first cell: [[\"Item\", \"Cost\"], [\"Rent\", \"1200\"], [\"Total\", \"=SUM(B2:B2)\"]]; text starting with = is a formula, plain numbers become numbers, a leading ' keeps text as text, and one value ([[\"0\"]]) fills every cell of a range. filter: what to keep, as the cells show it: [[\"Paid\", \"Due\"]]"),
        "range": _desc(_STR, "The cells: like B2, B2:D9, C:C or 'Q1 sales'!A1:F20, or selection for what is selected. read: the cells that hold something when left out; write: the first cell (the rows go from there) or exactly the range's size; fill: the cells to fill, the first one included; filter: the rows, the header row first; recommend_charts, insert_chart, summarize and the data tools: the data with its headers, where one cell stands for the table around it; update_chart: other cells to lay the chart's series out from; set_validation, get_validation, clear_validation: the cells the rules cover"),
        "sheet": _desc(_STR, "The sheet, when the range does not name it (the one in front when left out); find, replace, list_charts, list_summaries, list_comments, list_notes: only this sheet; rename_sheet, remove_sheet: the sheet to rename or remove; insert_chart: the sheet the chart goes on (the data's when left out); refresh_summary: the summaries' sheet"),
        "formulas": _desc(_BOOL, "read: include formulas (true, the default); find: look in formulas too; replace: change formulas too"),
        "text": _desc(_STR, "find: what to find; add_comment, reply_to_comment: the comment or the reply; set_note: the note"),
        "caseSensitive": _desc(_BOOL, "find, replace: match upper and lower case exactly"),
        "wholeCell": _desc(_BOOL, "find, replace: the whole cell has to match"),
        "formula": _desc(_STR, "fill: the first cell's formula, e.g. \"=B2*C2\"; its relative references move for each cell and $ keeps one fixed. Without it the first cell's own formula is filled"),
        "format": {
            "type": "object",
            "description": "format: what to set, e.g. {\"numberFormat\": \"#,##0.00\", \"bold\": true}: numberFormat (\"#,##0.00\", \"0%\", \"yyyy-mm-dd\", \"$#,##0\"), bold, italic, underline, strikethrough, font, size, color, background, align (left, center, right, general), verticalAlign (top, middle, bottom), wrap, border ({\"edges\": all, outside, inside, top, bottom, left, right or none, \"style\": thin, medium, thick, dashed, dotted or double, \"color\": \"#999999\"})",
            "additionalProperties": True,
        },
        "by": _desc(_STR, "sort, filter: the column: a letter (C), a header in the first row (Cost) or a number from the range's first column (1); clean dedupe, remove_duplicates: the columns that make a row a repeat, comma-separated letters or headers (every column when left out)"),
        "ascending": _desc(_BOOL, "sort: A to Z, smallest first (true, the default); false for descending"),
        "header": _desc(_BOOL, "sort, clean, remove_duplicates, split_text, sort_by: the first row is a header row and stays as it is (remove_duplicates and sort_by read it from the data when left out)"),
        "condition": {
            "type": "object",
            "description": "filter: keep the rows whose cell meets this, e.g. {\"operator\": \"greaterThan\", \"value\": 100}; operator is equal, notEqual, greaterThan, greaterThanOrEqual, lessThan or lessThanOrEqual",
            "additionalProperties": True,
        },
        "clear": _desc(_BOOL, "filter: take the sheet's filter off; highlight_duplicates: take the duplicate highlight off instead"),
        "rows": _desc(_NUM, "freeze: rows to keep in view from the top (0 with columns 0 unfreezes)"),
        "columns": _desc(_NUM, "freeze: columns to keep in view from the left (0)"),
        "index": _desc(_NUM, "add_sheet: its place among the sheets, from 0 (at the end when left out)"),
        "find": _desc(_STR, "replace: the text to replace, in text cells (numbers and dates are left alone)"),
        "replacement": _desc(_STR, "replace: what goes in its place (left out deletes it)"),
        "all": _desc(_BOOL, "replace: every match (true, the default) or only the first"),
        "clean": _desc(_STR, "clean: what to do: dedupe (remove rows repeating an earlier one; the rest move up), trim (spaces at the ends and doubled inside), numbers (numbers kept as text, like \"1,200\", \"$5\", \"(300)\" or \"12%\", become numbers), dates (dates kept as text become real dates), split (one column split at delimiter into the columns to its right) or case (upper, lower or title); formulas are kept"),
        "delimiter": _desc(_STR, "clean split, split_text: where to split: a character, or comma (the default), semicolon, space, tab or pipe"),
        "overwrite": _desc(_BOOL, "clean split, split_text: write over data where the parts go; save, export_pdf: replace the file at to (asks the person first)"),
        "dateFormat": _desc(_STR, "clean dates, convert_to_dates: the date format the dates get (yyyy-mm-dd)"),
        "order": _desc(_STR, "clean dates, convert_to_dates: dmy (day first), mdy (month first) or ymd for dates like 03/04/2025, when the data does not say"),
        "case": _desc(_STR, "clean case: upper, lower, title (the default) or sentence; change_case: upper, lower, title or sentence"),
        "chart": _desc(_STR, "describe_chart, update_chart, move_chart, remove_chart: the chart's id (from list_charts or insert_chart), its title, or its number in list_charts"),
        "kind": _desc(_STR, "insert_chart, update_chart: column, bar, line, area, pie, doughnut, scatter or combo (columns and lines); insert_chart picks the best for the data when left out"),
        "title": _desc(_STR, "insert_chart, update_chart: the chart's title (none takes it off; a one-series chart is titled from its data)"),
        "series": _desc(_OBJECTS, "insert_chart, update_chart: the whole list of series, in place of those laid out from range: [{\"values\": \"B2:B13\", \"name\": \"Sales\", \"categories\": \"A2:A13\", \"color\": \"#4472c4\"}]; also nameCell (\"B1\"), and for combo charts type (column, line or area) and secondary (a second value axis); smooth and markers for lines"),
        "categories": _desc(_STR, "insert_chart, update_chart: the category labels (a scatter chart's x values) for every series, cells like A2:A13 (none for none)"),
        "legend": _desc(_STR, "insert_chart, update_chart: where the legend goes: top, bottom, left, right or none"),
        "labels": _desc(_STR, "insert_chart, update_chart: data labels: none, value, percent or category"),
        "axes": {
            "type": "object",
            "description": "insert_chart, update_chart: {\"x\": {...}, \"y\": {...}, \"y2\": {...}} (the category axis, the value axis, a combo chart's second value axis), each with title, min, max, gridlines, format (\"0%\", \"#,##0\"), hidden and reverse (the other way round); null for a key takes it off",
            "additionalProperties": True,
        },
        "stacking": _desc(_STR, "insert_chart, update_chart: none, stacked or percent (columns, bars, lines and areas)"),
        "palette": _desc(_STR, "insert_chart, update_chart: the series' colours in turn, comma-separated (\"#4472c4, #ed7d31\"), or workbook for the workbook theme's"),
        "hole": _desc(_NUM, "insert_chart, update_chart: a doughnut's hole as a percentage of its size, 0 to 90 (50)"),
        "at": _desc(_STR, "insert_chart, move_chart: a cell for the chart's top-left corner (H2), or cells for it to cover (H2:N18); insert_chart puts it beside the data when left out"),
        "width": _desc(_NUM, "insert_chart, move_chart: the chart's width in pixels, 80 to 4000 (480 for a new one)"),
        "height": _desc(_NUM, "insert_chart, move_chart: the chart's height in pixels, 80 to 4000 (288 for a new one)"),
        "rowFields": {"type": "array", "items": _STR, "description": "summarize: the columns whose values go down the summary, by header or letter: [\"Region\"]"},
        "columnFields": {"type": "array", "items": _STR, "description": "summarize: columns whose values go across it: [\"Quarter\"]"},
        "valueFields": _desc(_OBJECTS, "summarize: what is worked out for each label: [{\"field\": \"Amount\", \"fn\": \"sum\"}]; fn is sum, count, average, min or max (sum for numbers, count for the rest, when left out)"),
        "filters": _desc(_OBJECTS, "summarize: the rows to count in: [{\"field\": \"Status\", \"values\": [\"Paid\", \"Due\"]}]; \"(blank)\" stands for empty cells"),
        "destination": _desc(_STR, "summarize: where the summary goes: new (a new sheet, the default), a sheet's name, or its first cell like 'Report'!B2; split_text: the first cell the parts go to (the column itself when left out)"),
        "preview": _desc(_BOOL, "remove_duplicates, split_text, convert_to_numbers, convert_to_dates, summarize: say what would change, and change nothing"),
        "summary": _desc(_STR, "refresh_summary: the summary's id (summary-1), its number on the sheet, or a cell inside it; every summary on the sheet when left out"),
        "consecutive": _desc(_BOOL, "split_text: runs of the delimiter count as one"),
        "color": _desc(_STR, "highlight_duplicates: the fill, like #ffc7ce (Excel's light red with dark red text when left out)"),
        "keys": _desc(_OBJECTS, "sort_by: the columns to sort by, the first first: [{\"column\": \"Region\", \"ascending\": true}, {\"column\": \"C\", \"ascending\": false}]; a column is a header, a letter or a number from 1"),
        "refersTo": _desc(_STR, "create_name, update_name: what the name stands for: cells like Data!B2:D9 (on the sheet in front without a sheet name), selection, or a constant or formula like =0.07"),
        "scope": _desc(_STR, "create_name: workbook (the default) or a sheet's name, for a name only that sheet's formulas see; update_name, delete_name, go_to_name: which one, when a sheet and the workbook both have the name"),
        "comment": _desc(_STR, "create_name, update_name: the name's comment, as the Name manager shows it (none takes it off); not a comment on a cell"),
        "newName": _desc(_STR, "update_name: the name's new name"),
        "rule": {
            "type": "object",
            "description": "set_validation: what the cells take: {\"type\": \"list\", \"items\": [\"Yes\", \"No\"]} or {\"type\": \"list\", \"source\": \"Lists!A2:A9\"}; {\"type\": \"whole\", \"operator\": \"between\", \"min\": 1, \"max\": 10}, or decimal, date (yyyy-mm-dd) or textLength with an operator (between, notBetween, equal, notEqual, greaterThan, lessThan, greaterThanOrEqual, lessThanOrEqual) and a value, or min and max (a bound can be a formula like =TODAY()); {\"type\": \"custom\", \"formula\": \"=B2<=C2\"} (TRUE for what is allowed); {\"type\": \"any\"} for an input message alone",
            "additionalProperties": True,
        },
        "allowBlank": _desc(_BOOL, "set_validation: empty cells are allowed (true, the default)"),
        "dropdown": _desc(_BOOL, "set_validation: a list shows its arrow in the cell (true, the default)"),
        "input": {
            "type": "object",
            "description": "set_validation: the message shown when a cell is selected: {\"title\": \"Status\", \"message\": \"Pick one from the list\"}",
            "additionalProperties": True,
        },
        "alert": {
            "type": "object",
            "description": "set_validation: the error alert after a value the rule does not allow: {\"style\": \"stop\", \"title\": \"Not on the list\", \"message\": \"Pick Yes or No\"}; style is stop (the value is refused, the default), warning (the person may keep it), information, or none for no alert",
            "additionalProperties": True,
        },
        "cell": _desc(_STR, "add_comment, set_note, remove_note: the cell, like B2 or 'Q1 sales'!C3, or selection; reply_to_comment, resolve_comment, delete_comment: the comment's cell (or give commentId)"),
        "commentId": _desc(_STR, "reply_to_comment, resolve_comment, delete_comment: a comment's id from list_comments, instead of cell; a reply's id deletes only that reply"),
        "resolved": _desc(_BOOL, "resolve_comment: resolved (true, the default) or open again (false)"),
        "edits": _desc(_OBJECTS, "edit: the changes, made in order as ONE step to undo; each has an op and that op's arguments: write (range, values, sheet), fill (range, formula), format (range, format), sort (range, by, ascending, header), filter (range, by, values, condition, clear), freeze (rows, columns, sheet), addSheet (name, index), renameSheet (sheet, name), removeSheet (sheet), clean (range and action: dedupe, trim, numbers, dates, split or case, with the clean arguments) and replace (the replace arguments); and, each with the arguments of the action of the same words (no preview): insertChart, updateChart, moveChart, removeChart, summarize, refreshSummary, removeDuplicates, splitText, trimText, changeCase, convertToNumbers, convertToDates, fillDown, highlightDuplicates, sortBy, createName, updateName, deleteName, setValidation, clearValidation, addComment, replyToComment, resolveComment, deleteComment (comments stay out of the undo step), setNote and removeNote. E.g. [{\"op\": \"write\", \"range\": \"A1\", \"values\": [[\"Month\", \"Sales\"]]}, {\"op\": \"format\", \"range\": \"A1:B1\", \"format\": {\"bold\": true}}, {\"op\": \"insertChart\", \"range\": \"A1:B13\", \"kind\": \"line\"}]"),
        "to": _desc(_STR, "save: save as this new file instead (.xlsx or .csv; full path or ~/...); export_pdf: the PDF to write (a new file in ~/Documents when left out)"),
        "steps": _desc(_NUM, "undo, redo: how many steps (1)"),
    },
    ["action"],
)

SLIDES_SCHEMA = _schema(
    "slides",
    "Herald Slides, the presentation editor built into Herald OS: decks for talks, reviews, pitches and lessons, in the Slides window the person watches or in PowerPoint (.pptx) files. "
    "Read before you change anything: action=list shows the presentations open in Herald Slides (list_all: everything open in Herald Docs, Sheets and Slides, with what is selected in each), read gives every slide's number, layout, title, text, speaker notes and elements (slide= for one), find finds text; open shows a file. "
    "Make a whole deck in one call: action=new with slides (you write the titles, short bullets and speaker notes from the person's brief), or from_document to turn a Herald Docs document into slides; insert_range puts a Herald Sheets range on a slide as a table. "
    "Change it with add_slide, set_slide (title, text, speaker notes, layout, hidden, background), duplicate_slide, move_slide, remove_slide, add_text, add_shape, add_image, add_table, set_theme and replace. "
    "Every call is one step the person can undo, so land a whole change in one call; action=edit makes several changes as ONE step. "
    "slide is a number (1 is the first), an id or a title, the slide in front when left out; presentation is a .pptx file (~/... or /...) or an open presentation's name as its tab shows it, the one in front when left out. An open presentation changes in its window; a file that is not open is changed on disk, which asks the person first. "
    "Never save unless the person asks: saving over a file asks them, and the first time shows what Herald cannot keep. "
    "Before making or reworking a real deck read skill_view name=\"herald-os-bridge:herald-slides\": outlines, layouts, themes, speaker notes and saving.",
    {
        "action": _enum(*SLIDES_ACTIONS, description="What to do"),
        "presentation": _desc(_STR, "The presentation: a .pptx file (full path or ~/...) or an open presentation's name as its tab shows it; the one in front in Herald Slides when left out. from_document: add the slides to the end of this one (a new presentation named after the document when left out)"),
        "path": _desc(_STR, "open: a .pptx file to show; new: save the new presentation here at once (a new .pptx file, never one that exists)"),
        "name": _desc(_STR, "new: the tab's name, and the file name it is offered when saved"),
        "slides": _desc(_OBJECTS, "new: the whole deck, one object a slide with layout, title, body and notes: [{\"layout\": \"title\", \"title\": \"Q3 review\", \"body\": \"Finance team\"}, {\"title\": \"Results\", \"body\": \"Revenue up 12%\\nCosts flat\", \"notes\": \"Lead with revenue\"}]; the first is a title slide unless its layout says otherwise, the rest title-content"),
        "theme": _desc(_STR, "new, set_theme: herald (white with navy text and blue accents; the default), midnight (dark navy with light text), paper (warm cream with serif type), graphite (dark grey with yellow accents), forest (pale with green accents), coral (warm peach and coral), mono (black and white with a red accent) or ocean (pale blue and teal)"),
        "size": _desc(_STR, "new: wide (16:9, the default) or standard (4:3); add_text: the font size in points, e.g. \"28\" (24)"),
        "slide": _desc(_STR, "A slide: its number (1 is the first), its id, or its title; the slide in front when left out. read: only this slide; remove_slide: the slide to remove"),
        "text": _desc(_STR, "find: what to find; add_text: what the text box says, a paragraph a line; add_shape: text centred in the shape"),
        "caseSensitive": _desc(_BOOL, "find, replace: match upper and lower case exactly"),
        "layout": _desc(_STR, "add_slide, set_slide: title, title-content (the default), two-content, comparison, section, title-only, blank or picture-caption"),
        "title": _desc(_STR, "add_slide, set_slide: the slide's title"),
        "body": _desc(_STR, "add_slide, set_slide: the slide's text, one line a bullet (two spaces or a tab at the start go a level deeper); two-content and comparison: a JSON list of two bodies, [\"Pros\\nFast\", \"Cons\\nCostly\"]"),
        "notes": _desc(_STR, "add_slide, set_slide: the speaker notes; from_document: true puts every paragraph in the speaker notes and keeps the bullets short (a talk with a script)"),
        "after": _desc(_STR, "add_slide: put it after this slide (number, id or title); at the end when left out"),
        "hidden": _desc(_BOOL, "set_slide: skip the slide when presenting (true) or show it again (false)"),
        "background": _desc(_STR, "set_slide: the background colour: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background); theme goes back to the theme's"),
        "to": _desc(_STR, "move_slide: its new number (1 is the first), or first or last; save: save as this new .pptx file instead (full path or ~/...); export_pdf: the PDF to write (a new file in ~/Documents when left out)"),
        "x": _desc(_NUM, "add_text, add_shape, add_image, add_table, insert_range: the left edge in points from the slide's left (a wide slide is 960 by 540 points, a standard one 720 by 540); centred when left out"),
        "y": _desc(_NUM, "add_text, add_shape, add_image, add_table, insert_range: the top edge in points from the slide's top; centred when left out"),
        "width": _desc(_NUM, "add_text (480 when left out), add_shape, add_image, add_table, insert_range: width in points"),
        "height": _desc(_NUM, "add_text (as tall as its text when left out), add_shape, add_image: height in points"),
        "color": _desc(_STR, "add_text: the text colour: #rrggbb, a name like navy or teal, or a theme colour (accent1 to accent6, text, background)"),
        "bold": _desc(_BOOL, "add_text: bold"),
        "align": _desc(_STR, "add_text: left (the default), center, right or justify"),
        "kind": _desc(_STR, "add_shape: rect (the default), roundRect, ellipse, triangle, rtTriangle, diamond, parallelogram, trapezoid, pentagon, hexagon, octagon, plus, star5, rightArrow, leftArrow, upArrow, downArrow, leftRightArrow, chevron, homePlate, wedgeRectCallout or wedgeRoundRectCallout; words like rectangle, circle, star, arrow or callout work too"),
        "fill": _desc(_STR, "add_shape: the fill colour: #rrggbb, a name, a theme colour or none (the theme's first accent when left out)"),
        "source": _desc(_STR, "add_image: the picture file, PNG, JPEG, GIF, WebP or BMP (full path or ~/...)"),
        "fit": _desc(_STR, "add_image with width and height: contain (the default: all of it, at its proportions), cover (fills the box, cut to fit) or stretch; slide fills the whole slide, cut to fit"),
        "cells": _desc(_ROWS, "add_table: the rows of cells as text, the header row first: [[\"Item\", \"Cost\"], [\"Rent\", \"1,200\"]]"),
        "rows": _desc(_NUM, "add_table: rows of an empty table, instead of cells"),
        "columns": _desc(_NUM, "add_table: columns of an empty table, instead of cells"),
        "find": _desc(_STR, "replace: the text to replace, in titles, text, shapes, tables and speaker notes"),
        "replacement": _desc(_STR, "replace: what goes in its place (left out deletes the matches); each replacement keeps the formatting where its match starts"),
        "all": _desc(_BOOL, "replace: every match (true, the default) or only the first (false)"),
        "edits": _desc(_OBJECTS, "edit: the changes, made in order as ONE step to undo (if one fails, none is made); each has an op and that op's arguments: addSlide (layout, title, body, notes, after), setSlide (slide, title, body, notes, layout, hidden, background), duplicateSlide (slide), moveSlide (slide, to), removeSlide (slide), addText (slide, text, x, y, width, height, size, color, bold, align), addShape (slide, kind, x, y, width, height, fill, text), addImage (slide, source, x, y, width, height, fit), addTable (slide, cells, x, y, width), setTheme (theme) and replace (find, replacement, all, caseSensitive). A slide one edit adds can be named by its title in the next, and an edit without a slide lands where the one before went. E.g. [{\"op\": \"addSlide\", \"title\": \"Risks\", \"body\": \"Supply\\nHiring\"}, {\"op\": \"addShape\", \"slide\": \"Risks\", \"kind\": \"star\", \"x\": 820, \"y\": 40, \"width\": 80, \"height\": 80}, {\"op\": \"setTheme\", \"theme\": \"paper\"}]"),
        "document": _desc(_STR, "from_document: the document to make slides from, a .docx, .md or .txt file or an open document's name (the one in front in Herald Docs when left out); it is only read"),
        "level": _desc(_NUM, "from_document: the heading level that starts a slide, 1 to 6 (the document's top level below its title when left out)"),
        "workbook": _desc(_STR, "insert_range: the Herald Sheets workbook, a file or an open workbook's name (the one in front in Herald Sheets when left out)"),
        "range": _desc(_STR, "insert_range: the cells, like A1:D12 or 'Q1 sales'!B2:F9, or selection; the workbook's selection, or else its cells that hold something, when left out"),
        "sheet": _desc(_STR, "insert_range: the sheet, when the range does not name it"),
        "overwrite": _desc(_BOOL, "save, export_pdf: replace the file at to (asks the person first)"),
        "steps": _desc(_NUM, "undo, redo: how many steps (1)"),
    },
    ["action"],
)


def _office_args(args: dict[str, Any], actions: dict[str, str], names: dict[str, tuple[str, ...]]) -> tuple[str, dict[str, Any]]:
    action = str(args.get("action") or "").strip().lower()
    if action not in actions:
        raise ValueError(f"action must be one of {', '.join(actions)}")
    return action, {key: args[key] for key in names[action] if key in args and args[key] not in (None, "")}


def _office_json(command_args: dict[str, Any]) -> dict[str, Any]:
    # The shell takes table cells, edits, rows of values, cell formats, filter conditions, a deck's
    # slides and a two-column slide's bodies as JSON text; and a chart's series and axes, a
    # summary's fields and filters, sort keys, and a validation rule with its messages.
    for key in ("cells", "edits", "values", "format", "condition", "slides", "body", "series", "axes", "rowFields", "columnFields", "valueFields", "filters", "keys", "rule", "input", "alert"):
        if isinstance(command_args.get(key), (dict, list)):
            command_args[key] = json.dumps(command_args[key])
    return command_args


def docs_command(args: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """``(action, command id, command args)`` for a docs call (pure; tested)."""
    action, command_args = _office_args(args, DOCS_ACTIONS, DOCS_ARGS)
    return action, DOCS_ACTIONS[action], _office_json(command_args)


def sheets_command(args: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """``(action, command id, command args)`` for a sheets call (pure; tested)."""
    action, command_args = _office_args(args, SHEETS_ACTIONS, SHEETS_ARGS)
    # The schema's values are rows, but a filter keeps a flat list of what the cells show.
    if action == "filter" and isinstance(command_args.get("values"), list):
        command_args["values"] = [cell for row in command_args["values"] for cell in (row if isinstance(row, list) else [row])]
    # `action` already names the tool's action, so clean's own one travels as `clean`.
    if action == "clean" and "clean" in command_args:
        command_args["action"] = command_args.pop("clean")
    return action, SHEETS_ACTIONS[action], _office_json(command_args)


def slides_command(args: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """``(action, command id, command args)`` for a slides call (pure; tested)."""
    action, command_args = _office_args(args, SLIDES_ACTIONS, SLIDES_ARGS)
    return action, SLIDES_ACTIONS[action], _office_json(command_args)


# The argument naming what a call changes; any other file it names (the document slides are made
# from, the workbook a range comes from) is only read.
_OFFICE_TARGETS = {"docs": "document", "sheets": "workbook", "slides": "presentation"}


def _file_on_disk(action: str, command: str, command_args: dict[str, Any], catalogue: dict[str, dict[str, Any]]) -> Path | None:
    """The existing file a change names by its path: unless it is open, the change is written to it on disk.
    A preview only says what the change would do, and the shell writes nothing for it."""
    if action in ("save", "export_pdf") or ui_tier_for(command, catalogue) is Tier.READ or command_args.get("preview") is True:
        return None
    target = command_args.get(_OFFICE_TARGETS.get(command.split(".")[0], ""))
    if not isinstance(target, str) or not target.strip().startswith(("/", "~")):
        return None
    file = expand(target)
    return file if file.exists() else None


def _edit_tier(command: str, command_args: dict[str, Any], catalogue: dict[str, dict[str, Any]]) -> Tier:
    """The most guarded tier among a batch's ops that are commands of their own, so removing a sheet
    or a slide in an edit asks as it does alone."""
    edits = command_args.get("edits")
    if isinstance(edits, str):
        try:
            edits = json.loads(edits)
        except json.JSONDecodeError:
            edits = None
    app = command.split(".")[0]
    # The shell takes an op in any case and with spaces round it, so the batch is matched the same way.
    known = {name.lower(): name for name in catalogue}
    ops = {known.get(f"{app}.{str(edit.get('op') or '').strip()}".lower()) for edit in edits if isinstance(edit, dict)} if isinstance(edits, list) else set()
    return max((ui_tier_for(op, catalogue) for op in ops if op), key=_TIER_ORDER.index, default=Tier.READ)


def office_tier(action: str, command: str, command_args: dict[str, Any], catalogue: dict[str, dict[str, Any]], open_paths: Iterable[str]) -> Tier:
    """The registry's tier (for an edit batch, at least its most guarded op's), raised to destructive
    when the call would write over a file: saving over one, exporting over one, or changing a file
    that is not open, which goes straight to disk (pure; tested)."""
    tier = ui_tier_for(command, catalogue)
    if action == "edit":
        tier = max(tier, _edit_tier(command, command_args, catalogue), key=_TIER_ORDER.index)
    target = command_args.get("to")
    named = isinstance(target, str) and bool(target.strip())
    replaces = command_args.get("overwrite") is True or (named and expand(target).exists())
    file = _file_on_disk(action, command, command_args, catalogue)
    over = (action == "save" and (replaces or not named)) or (action == "export_pdf" and replaces) or (file is not None and file not in {expand(path) for path in open_paths})
    return Tier.DESTRUCTIVE if over else tier


def _open_office_paths() -> set[str]:
    """The files open in Herald Docs, Sheets and Slides; none when the shell cannot say, so every file counts as closed."""
    try:
        reply = ui.run_command("office.list", {}, timeout=OFFICE_TIMEOUT)
    except Exception:  # noqa: BLE001 - not knowing what is open guards the call as if nothing were.
        return set()
    data = reply.get("data") if reply.get("ok") else None
    documents = data.get("documents") if isinstance(data, dict) else None
    return {str(entry["path"]) for entry in documents or () if isinstance(entry, dict) and entry.get("path")}


def _handle_office(tool: str, app: str, plan: Callable[[dict[str, Any]], tuple[str, str, dict[str, Any]]], args: dict[str, Any]) -> str:
    try:
        action, command, command_args = plan(args)
    except ValueError as exc:
        return fail(str(exc))
    try:
        catalogue = _ui_catalogue()
        if catalogue and command not in catalogue:
            return fail(f"{app} is not in this version of Herald OS; update Herald OS first")
        open_paths = _open_office_paths() if _file_on_disk(action, command, command_args, catalogue) else set()
        tier = office_tier(action, command, command_args, catalogue, open_paths)
        summary = ui_summary(command, command_args, catalogue)

        def execute() -> dict[str, Any]:
            reply = ui.run_command(command, command_args, timeout=OFFICE_TIMEOUT)
            if not reply.get("ok"):
                raise RuntimeError(str(reply.get("error") or reply.get("summary") or f"{app} refused that"))
            payload = {k: v for k, v in reply.items() if k not in ("ok", "summary")}
            payload["result"] = reply.get("summary")
            return payload

        return _guarded(tool, tier, action, summary, {"action": action, **command_args}, (), execute)
    except ui.ShellUnavailable as exc:
        return fail(str(exc))


def handle_docs(args: dict[str, Any], **_: Any) -> str:
    return _handle_office("docs", "Herald Docs", docs_command, args)


def handle_sheets(args: dict[str, Any], **_: Any) -> str:
    return _handle_office("sheets", "Herald Sheets", sheets_command, args)


def handle_slides(args: dict[str, Any], **_: Any) -> str:
    return _handle_office("slides", "Herald Slides", slides_command, args)


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec("os_ui", OS_UI_SCHEMA, handle_os_ui, "🪟"),
    ToolSpec("canvas", CANVAS_SCHEMA, handle_canvas, "🎨"),
    ToolSpec("docs", DOCS_SCHEMA, handle_docs, "📝"),
    ToolSpec("sheets", SHEETS_SCHEMA, handle_sheets, "📊"),
    ToolSpec("slides", SLIDES_SCHEMA, handle_slides, "🎞️"),
    ToolSpec("system_network", SYSTEM_NETWORK_SCHEMA, handle_system_network, "📶"),
    ToolSpec("system_control", SYSTEM_CONTROL_SCHEMA, handle_system_control, "🎛️"),
    ToolSpec("system_logs", SYSTEM_LOGS_SCHEMA, handle_system_logs, "📜"),
    ToolSpec("system_info", SYSTEM_INFO_SCHEMA, handle_system_info, "🖥️"),
    ToolSpec("system_processes", SYSTEM_PROCESSES_SCHEMA, handle_system_processes, "📈"),
    ToolSpec("system_disk_usage", SYSTEM_DISK_USAGE_SCHEMA, handle_system_disk_usage, "💽"),
    ToolSpec("system_find_files", SYSTEM_FIND_FILES_SCHEMA, handle_system_find_files, "🔍"),
    ToolSpec("system_apps", SYSTEM_APPS_SCHEMA, handle_system_apps, "🧩"),
    ToolSpec("system_open", SYSTEM_OPEN_SCHEMA, handle_system_open, "↗️"),
    ToolSpec("system_kill_process", SYSTEM_KILL_PROCESS_SCHEMA, handle_system_kill_process, "⛔"),
    ToolSpec("system_files", SYSTEM_FILES_SCHEMA, handle_system_files, "🗂️"),
    ToolSpec("system_documents", SYSTEM_DOCUMENTS_SCHEMA, handle_system_documents, "📄"),
    ToolSpec("system_os", SYSTEM_OS_SCHEMA, system_os_handler, "🐧"),
)

__all__ = ["TOOL_SPECS", "ToolSpec", "bridge_enabled", "canvas_command", "canvas_tier", "docs_command", "drop_undo", "find_undo", "handle_canvas", "handle_docs", "handle_os_ui", "handle_sheets", "handle_slides", "handle_system_documents", "normalise_duration", "office_tier", "plan_operations", "plan_system_os", "plan_targets", "read_one_document", "record_undo", "resolve_when", "sheets_command", "slides_command", "system_os_handler", "tilde", "ui_summary", "ui_tier_for", "json"]
