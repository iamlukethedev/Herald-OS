"""Observer hooks: Hermes's work outside Herald OS reaches the Pet Room by name only, and only while a
running Herald OS asks for it.

A control file in the observe folder opens the gate and a fake control server stands in for Herald
OS. The sender thread is counted instead of started and tests send with ``_flush_once()``, except the
one test of the real thread."""

from __future__ import annotations

import collections
import hashlib
import importlib
import inspect
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import types

import pytest

SESSION = "20260101_101010_abc"
SECRET = "s3cr3t-never-sent"
KINDS = {"session.start", "session.end", "tool.start", "tool.end", "helper.start", "helper.end", "approval.start", "approval.end"}


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


def call_of(session, value):
    return hashlib.sha256(f"{session}:{value}".encode()).hexdigest()[:16]


class Clock:
    """The module's ``time``: a monotonic clock the test moves, and a fixed wall clock."""

    WALL = 1_760_000_000.5

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def time(self):
        return self.WALL


class FakeHerald:
    """A JSON-lines Unix socket server answering ``activity`` requests like Herald OS's main: with
    ``reply`` when set, else accepting the right token and refusing any other."""

    def __init__(self, path: str, token: str):
        self.path, self.token = path, token
        self.reply: dict | None = None
        self.requests: list[dict] = []
        self.raw: list[bytes] = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(8)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    part = conn.recv(65536)
                    if not part:
                        break
                    data += part
                request = json.loads(data.decode())
                self.raw.append(data)
                self.requests.append(request)
                if self.reply is not None:
                    reply = self.reply
                elif request.get("token") == self.token:
                    reply = {"ok": True, "accepted": len(request["events"])}
                else:
                    reply = {"ok": False, "error": "invalid activity token"}
                conn.sendall((json.dumps(reply) + "\n").encode())

    def close(self):
        self.server.close()
        try:
            os.unlink(self.path)
        except OSError:
            pass


@pytest.fixture
def starts(plugin, monkeypatch):
    """Sender starts the hooks ask for, counted instead of run; ``starts.real`` starts one for real."""
    observe = _mod(plugin, "observe")
    record = types.SimpleNamespace(count=0, real=observe._start_sender)

    def start():
        record.count += 1

    monkeypatch.setattr(observe, "_start_sender", start)
    return record


@pytest.fixture
def observe(plugin, starts, monkeypatch):
    """The module with fresh state; Hermes's session variables come from the environment, unset."""
    module = _mod(plugin, "observe")
    for name in ("HERALD_OS", "HERMES_SESSION_SOURCE", "HERMES_SESSION_PLATFORM"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setitem(sys.modules, "gateway.session_context", None)
    fresh = {
        "_queue": collections.deque(maxlen=module.QUEUE_MAX), "_wake": threading.Event(), "_sender": None,
        "_files": {}, "_endpoints": (), "_checked": float("-inf"), "_refused": set(), "_backoff": {},
        "_platforms": collections.OrderedDict(),
    }
    for name, value in fresh.items():
        monkeypatch.setattr(module, name, value)
    return module


@pytest.fixture
def clock(observe, monkeypatch):
    fake = Clock()
    monkeypatch.setattr(observe, "time", fake)
    return fake


def _short_folder() -> str:
    # AF_UNIX paths are capped at ~104 bytes on macOS; pytest's tmp_path is far longer.
    return tempfile.mkdtemp(prefix="hos-", dir="/tmp")


@pytest.fixture
def herald():
    folder = _short_folder()
    server = FakeHerald(os.path.join(folder, "c.sock"), "activity-token")
    yield server
    server.close()
    shutil.rmtree(folder, ignore_errors=True)


def control(home, pid=4242, *, live=True, path="/tmp/hos-none/c.sock", token="activity-token", mode=0o600):
    """Write a Herald OS's control file the way Herald OS does: atomically, 0600 in a 0700 folder."""
    folder = home / "herald-os" / "observe"
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    data = {"v": 1, "pid": pid, "live": live, **({"socket": path, "token": token} if live else {})}
    temporary = folder / f".{pid}.tmp"
    temporary.write_text(json.dumps(data))
    temporary.chmod(mode)
    os.replace(temporary, folder / f"{pid}.json")
    return folder / f"{pid}.json"


def bind(monkeypatch, variables: dict[str, str]) -> None:
    """Hermes's ``gateway.session_context`` with ``variables`` bound for the turn (others read "")."""
    package = types.ModuleType("gateway")
    package.__path__ = []
    module = types.ModuleType("gateway.session_context")
    module.get_session_env = lambda name, default="": variables.get(name, "")
    module.session_context_engaged = lambda: True
    monkeypatch.setitem(sys.modules, "gateway", package)
    monkeypatch.setitem(sys.modules, "gateway.session_context", module)


def tool_call(**over):
    """``pre_tool_call``'s kwargs as Hermes sends them, with content where a tool's arguments carry it."""
    return {
        "tool_name": "write_file",
        "args": {"path": "/Users/someone/Work/Budget.xlsx", "content": SECRET + "-content", "command": SECRET + "-command"},
        "task_id": "task-1", "session_id": SESSION, "tool_call_id": "call_1", "turn_id": "turn-1", "api_request_id": "req-1",
        "middleware_trace": [{"note": SECRET + "-trace"}], "telemetry_schema_version": "hermes.observer.v1",
        **over,
    }


def tool_result(**over):
    """``post_tool_call``'s kwargs: the call's, plus the result and Hermes's status."""
    return {
        **tool_call(), "result": json.dumps({"content": SECRET + "-result"}), "duration_ms": 12, "status": "ok",
        "error_type": None, "error_message": SECRET + "-error", **over,
    }


APPROVAL = {
    "command": SECRET + "-command", "description": SECRET + "-description", "pattern_key": SECRET + "-pattern",
    "pattern_keys": [SECRET + "-pattern"], "session_key": "agent:main:telegram:dm:" + SECRET, "surface": "gateway",
    "turn_id": "turn-1", "tool_call_id": "call_1", "session_id": SESSION,
}


def every_hook():
    """Each hook's kwargs in the order a turn fires them, with content wherever Hermes may put it."""
    return [
        ("on_session_start", {"session_id": SESSION, "model": SECRET + "-model", "platform": "telegram"}),
        ("pre_tool_call", tool_call()),
        ("pre_approval_request", dict(APPROVAL)),
        ("post_approval_response", {**APPROVAL, "choice": SECRET + "-choice"}),
        ("post_tool_call", tool_result(status="error", error_type="tool_error")),
        ("subagent_start", {"parent_session_id": SESSION, "parent_turn_id": "turn-1", "parent_subagent_id": None, "child_session_id": "child-1",
                            "child_subagent_id": "sa-1", "child_role": SECRET + "-role", "child_goal": SECRET + "-goal"}),
        ("subagent_stop", {"parent_session_id": SESSION, "parent_turn_id": "turn-1", "child_session_id": "child-1", "child_role": SECRET + "-role",
                           "child_summary": SECRET + "-summary", "child_status": "completed",
                           "tool_call_history": [{"tool_name": "read_file", "tool_input": SECRET + "-history"}], "duration_ms": 900}),
        ("on_session_end", {"session_id": SESSION, "task_id": "task-1", "turn_id": "turn-1", "completed": True, "failed": False, "interrupted": False,
                            "turn_exit_reason": SECRET + "-reason", "model": SECRET + "-model", "platform": "telegram"}),
    ]


def fire(observe, extra=None):
    for hook, kwargs in every_hook():
        assert observe.HOOKS[hook](**kwargs, **(extra or {})) is None


def wait_for(condition, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.01)
    return True


# The gate.


def test_nothing_is_recorded_while_no_herald_asks(observe, starts):
    fire(observe)
    assert not observe._queue and starts.count == 0
    assert not [thread for thread in threading.enumerate() if thread.name == observe.THREAD_NAME]


def test_a_herald_with_live_steps_off_gets_nothing(observe, starts, isolated_home):
    control(isolated_home, live=False)
    fire(observe)
    assert not observe._queue and starts.count == 0


def test_each_hook_queues_one_compact_record_while_a_herald_asks(observe, starts, isolated_home, clock):
    control(isolated_home)
    fire(observe)
    call = call_of(SESSION, "call_1")
    base = {"session": SESSION, "at": Clock.WALL, "source": "telegram"}
    assert list(observe._queue) == [
        {**base, "kind": "session.start"},
        {**base, "kind": "tool.start", "tool": "write_file", "target": "Budget.xlsx", "call": call},
        {**base, "kind": "approval.start", "call": call},
        {**base, "kind": "approval.end", "call": call, "status": "answered"},
        {**base, "kind": "tool.end", "tool": "write_file", "call": call, "status": "error"},
        {**base, "kind": "helper.start", "child": "child-1"},
        {**base, "kind": "helper.end", "child": "child-1", "status": "completed"},
        {**base, "kind": "session.end", "status": "completed"},
    ]
    assert starts.count == len(observe._queue)


def test_turning_live_steps_off_is_noticed_within_the_refresh_interval(observe, starts, isolated_home, clock):
    hook = observe.HOOKS["pre_tool_call"]
    control(isolated_home)
    hook(**tool_call())
    control(isolated_home, live=False)
    clock.now += observe.REFRESH_SECONDS / 2
    hook(**tool_call())
    assert len(observe._queue) == 2
    clock.now += observe.REFRESH_SECONDS / 2
    hook(**tool_call())
    assert len(observe._queue) == 2 and observe.live() is False

    control(isolated_home)
    clock.now += observe.REFRESH_SECONDS
    hook(**tool_call())
    assert len(observe._queue) == 3


def test_a_control_file_is_read_again_only_when_it_changes(observe, isolated_home, monkeypatch):
    monkeypatch.setattr(observe, "REFRESH_SECONDS", 0.0)
    reads = []
    read = observe._endpoint_at
    monkeypatch.setattr(observe, "_endpoint_at", lambda file, stamp: reads.append(file) or read(file, stamp))
    file = control(isolated_home)
    assert observe.live() and observe.live() and observe.live()
    assert len(reads) == 1
    control(isolated_home, token="another-token")
    assert observe.live() and len(reads) == 2
    # Permissions are part of what is checked, so a chmod counts as a change.
    file.chmod(0o640)
    assert observe.live() is False and len(reads) == 3
    file.unlink()
    assert observe.live() is False and observe._files == {}


@pytest.mark.parametrize("case", [
    "group-readable", "world-readable", "relative socket", "no socket", "empty token", "live as text",
    "not JSON", "a JSON list", "a link to a private file", "a name Herald OS does not use", "the folder is a file",
])
def test_a_control_file_that_is_not_private_or_not_well_formed_is_ignored(case, observe, starts, isolated_home, tmp_path):
    folder = isolated_home / "herald-os" / "observe"
    if case == "group-readable":
        control(isolated_home, mode=0o640)
    elif case == "world-readable":
        control(isolated_home, mode=0o604)
    elif case == "relative socket":
        control(isolated_home, path="run/c.sock")
    elif case == "no socket":
        control(isolated_home, path="")
    elif case == "empty token":
        control(isolated_home, token="")
    elif case == "live as text":
        control(isolated_home, live="true")
    elif case in ("not JSON", "a JSON list"):
        control(isolated_home).write_text("{not json" if case == "not JSON" else "[1, 2]")
    elif case == "a link to a private file":
        target = control(tmp_path)
        folder.mkdir(parents=True)
        (folder / "4242.json").symlink_to(target)
    elif case == "a name Herald OS does not use":
        control(isolated_home).rename(folder / "herald.json")
    else:
        folder.parent.mkdir(parents=True)
        folder.write_text("{}")
    fire(observe)
    assert not observe._queue and starts.count == 0


def test_a_profile_reads_the_root_homes_folder_too(observe, starts, tmp_path, monkeypatch):
    root = tmp_path / "root"
    profile = root / "profiles" / "work"
    profile.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    control(root)
    observe.HOOKS["pre_tool_call"](**tool_call())
    assert [event["kind"] for event in observe._queue] == ["tool.start"]


@pytest.mark.parametrize("check", ["in_herald_session", "herald_backend"])
def test_herald_os_own_work_is_left_to_the_room(check, plugin, observe, starts, isolated_home, monkeypatch):
    control(isolated_home)
    monkeypatch.setattr(_mod(plugin, "scope"), check, lambda: True)
    fire(observe)
    assert not observe._queue and starts.count == 0


def test_a_turn_hermes_binds_to_herald_os_is_skipped(observe, starts, isolated_home, monkeypatch):
    control(isolated_home)
    bind(monkeypatch, {"HERMES_SESSION_SOURCE": "herald_os"})
    fire(observe)
    assert not observe._queue
    bind(monkeypatch, {"HERMES_SESSION_PLATFORM": "telegram"})
    fire(observe)
    assert len(observe._queue) == len(every_hook())


class Ctx:
    def __init__(self):
        self.tools: dict[str, dict] = {}
        self.skills: list[str] = []
        self.hooks: list[tuple] = []

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_skill(self, name, path, description=""):
        self.skills.append(name)

    def register_hook(self, name, callback):
        self.hooks.append((name, callback))


def test_the_plugin_registers_the_hooks_beside_its_tools(plugin, observe, monkeypatch):
    ctx = Ctx()
    plugin.register(ctx)
    desktop = sys.modules[plugin.__name__ + ".bridge.desktop"]
    assert [name for name, _ in ctx.hooks] == [
        "pre_tool_call", "post_tool_call", "subagent_start", "subagent_stop",
        "on_session_start", "on_session_end", "pre_approval_request", "post_approval_response",
        "pre_tool_call",
    ]
    assert all(callback is observe.HOOKS[name] for name, callback in ctx.hooks[:-1])
    assert ctx.hooks[-1][1] is desktop.guard
    # Hermes hands a callback every field only when it takes **kwargs.
    assert all(any(p.kind is inspect.Parameter.VAR_KEYWORD for p in inspect.signature(callback).parameters.values()) for _, callback in ctx.hooks)
    assert ctx.tools and ctx.skills

    older = types.SimpleNamespace(hooks=[], register_tool=lambda **kwargs: None)
    older.register_hook = lambda name, callback: older.hooks.append(name)
    plugin.register(older)
    assert len(older.hooks) == len(observe.HOOKS) + 1
    plugin.register(types.SimpleNamespace(register_tool=lambda **kwargs: None))

    monkeypatch.setenv("HERALD_OS", "1")
    backend = Ctx()
    plugin.register(backend)
    # The backend's work is all Herald OS's, so no observer hook; the desktop control guard still holds there.
    assert backend.hooks == [("pre_tool_call", desktop.guard)] and backend.tools and backend.skills


# Queueing.


class Unreadable(dict):
    def get(self, *args, **kwargs):
        raise RuntimeError("no")


GARBAGE = {
    "nothing": {},
    "nones": {"args": None, "tool_name": None, "session_id": None, "task_id": None, "parent_session_id": None, "child_session_id": None},
    "args as a list": {"args": [1, 2], "tool_name": "read_file", "session_id": SESSION},
    "args as a huge string": {"args": "x" * 1_000_000, "tool_name": "read_file", "session_id": SESSION},
    "huge values": {"args": {"path": ["x" * 1_000_000], "url": "y" * 1_000_000}, "tool_name": "read_file", "session_id": SESSION},
    "args that raise": {"args": Unreadable(path="a.txt"), "tool_name": "read_file", "session_id": SESSION},
    "lone surrogates": {"args": {"path": "\ud800/x\udfff.txt"}, "tool_name": "read_file", "session_id": SESSION},
    "a broken address": {"args": {"url": "http://[::1"}, "tool_name": "browser_navigate", "session_id": SESSION},
    "a port out of range": {"args": {"url": "http://example.com:99999"}, "tool_name": "browser_navigate", "session_id": SESSION},
    "huge ids": {"session_id": "x" * 1_000_000, "task_id": "y" * 1_000_000, "tool_name": "z" * 1_000_000, "tool_call_id": "c" * 1_000_000},
    "wrong types": {
        "tool_name": 42, "session_id": 7, "task_id": object(), "tool_call_id": ["call"], "turn_id": {}, "status": {"x": 1}, "choice": ["once"],
        "surface": ["cli"], "platform": 3.5, "child_status": ["completed"], "interrupted": "yes", "parent_session_id": b"bytes", "child_session_id": 1.5,
    },
    "half right": {
        "session_id": SESSION, "parent_session_id": SESSION, "child_session_id": "c\n1", "surface": "cli", "choice": None, "status": None,
        "platform": "x" * 1_000_000, "tool_name": "read_file", "args": {"path": None, "file_path": 5}, "tool_call_id": "",
    },
}


@pytest.mark.parametrize("name", list(GARBAGE))
def test_hooks_return_none_and_never_raise_whatever_they_are_given(name, observe, starts, isolated_home):
    control(isolated_home)
    for callback in observe.HOOKS.values():
        assert callback(**GARBAGE[name]) is None
    for event in observe._queue:
        assert event["kind"] in KINDS and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", event["session"])
        assert len(event.get("target") or "") <= observe.LABEL_MAX
    json.dumps(list(observe._queue), ensure_ascii=False).encode("utf-8")


def test_a_sender_that_cannot_start_never_reaches_hermes(observe, isolated_home, monkeypatch):
    def refuse():
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(observe, "_start_sender", refuse)
    control(isolated_home)
    assert observe.HOOKS["pre_tool_call"](**tool_call()) is None
    assert len(observe._queue) == 1


def test_a_folder_that_cannot_be_read_leaves_the_gate_as_it_was(observe, starts, isolated_home, monkeypatch):
    def broken():
        raise OSError("no")

    monkeypatch.setattr(observe, "_folders", broken)
    fire(observe)
    assert not observe._queue


def test_hooks_take_microseconds(observe, starts, isolated_home):
    huge = tool_call(args={"path": "x" * 100_000, "content": "y" * 1_000_000})
    for asked in (False, True):
        if asked:
            control(isolated_home)
            observe._checked = float("-inf")
        begin = time.perf_counter()
        for _ in range(1000):
            observe.HOOKS["pre_tool_call"](**huge)
            observe.HOOKS["post_tool_call"](**huge, result=SECRET, status="ok")
        assert time.perf_counter() - begin < 0.5
    assert len(observe._queue) == observe.QUEUE_MAX


def test_the_queue_is_bounded_and_keeps_the_newest_events(observe, starts, isolated_home):
    control(isolated_home)
    for n in range(observe.QUEUE_MAX + 100):
        observe.HOOKS["pre_tool_call"](**tool_call(tool_call_id=f"call_{n}"))
    assert len(observe._queue) == observe.QUEUE_MAX
    assert observe._queue[0]["call"] == call_of(SESSION, "call_100")
    assert observe._queue[-1]["call"] == call_of(SESSION, f"call_{observe.QUEUE_MAX + 99}")


# Targets: names only.


@pytest.mark.parametrize(("tool", "args", "target"), [
    ("read_file", {"path": "~/Work/Budget.xlsx"}, "Budget.xlsx"),
    ("read_file", {"path": "C:\\Users\\someone\\Work\\Budget.xlsx"}, "Budget.xlsx"),
    ("search_files", {"path": "/srv/projects/site///"}, "site"),
    ("search_files", {"path": "D:\\Reports\\"}, "Reports"),
    ("read_file", {"path": "file:///Users/someone/Notes/plan.md?x=1#top"}, "plan.md"),
    ("read_file", {"path": "file://fileserver/share/Q3.pdf"}, "Q3.pdf"),
    ("read_file", {"path": "https://cdn.example.net/a/b.png"}, "cdn.example.net"),
    ("browser_navigate", {"url": "https://someone:pass@Example.COM:8443/private/path?q=1#f"}, "example.com:8443"),
    ("browser_navigate", {"url": "https://example.com:443/"}, "example.com"),
    ("browser_navigate", {"url": "http://[::1]:8080/x"}, "[::1]:8080"),
    ("browser_navigate", {"url": "localhost:3000/app"}, "localhost:3000"),
    ("browser_navigate", {"url": "not an address"}, None),
    ("web_extract", {"urls": [42, "https://news.example.org/story"]}, "news.example.org"),
    ("web_extract", {"urls": ["docs.example.com/guide", "https://other.example.net"]}, "docs.example.com"),
    ("write_file", {"path": "/tmp/" + "a" * 60 + ".txt"}, "a" * 39 + "…"),
    ("write_file", {"path": "/tmp/" + "ab " * 20}, ("ab " * 13).rstrip() + "…"),
    ("write_file", {"path": "/tmp/bad\x00name\n.txt"}, "bad name .txt"),
    ("read_file", {"path": "/x/" + "y" * 5000}, None),
    ("read_file", {"path": "."}, None),
    ("read_file", {"path": "~"}, None),
    ("read_file", {"path": "/"}, None),
    ("read_file", {"path": "../"}, None),
    ("patch", {"file_path": "a.py", "path": "b.py"}, "a.py"),
    ("patch", {"path": "   ", "new_path": "c.py"}, "c.py"),
    ("patch", {"path": ".", "new_path": "c.py"}, None),
    ("terminal", {"command": f"cat ~/{SECRET}.txt", "workdir": "/Users/someone/Projects/herald"}, "herald"),
    ("terminal", {"command": f"cd /srv && rm {SECRET}"}, None),
    ("terminal", {"command": "ls", "cwd": "/var/log/"}, "log"),
    ("terminal", {"command": "cat /etc/hosts", "path": "/etc/hosts"}, None),
    ("execute_code", {"code": f"open('{SECRET}')"}, None),
    ("memory", {"action": "add", "target": "memory", "content": SECRET}, None),
    ("send_message", {"target": "telegram:123", "message": SECRET}, None),
    ("clarify", {"question": SECRET, "choices": [SECRET]}, None),
    ("todo", {"todos": [{"content": SECRET}]}, None),
    ("delegate_task", {"goal": SECRET, "context": SECRET}, None),
    ("session_search", {"query": SECRET}, None),
    ("read_file", None, None),
    ("read_file", [1, 2], None),
    ("read_file", {"path": 7}, None),
])
def test_targets_are_names_only(observe, tool, args, target):
    assert observe.target_of(tool, args) == target


def test_no_content_ever_leaves_a_hook(observe, starts, isolated_home, herald):
    control(isolated_home, path=herald.path, token=herald.token)
    fire(observe, {"user_message": SECRET + "-user"})
    queued = json.dumps(list(observe._queue), ensure_ascii=False)
    while observe._flush_once():
        pass
    sent = b"".join(herald.raw).decode()
    assert len(herald.requests) == 1 and "Budget.xlsx" in sent
    for text in (queued, sent):
        assert SECRET not in text
        assert "someone" not in text and "Work" not in text


# Statuses and where a session runs.


@pytest.mark.parametrize(("status", "expected"), [
    ("ok", "ok"), ("error", "error"), ("timeout", "timeout"), ("blocked", "blocked"), ("cancelled", "cancelled"), ("something new", None), (None, None),
])
def test_a_tool_ends_with_hermes_status_in_the_rooms_words(status, expected, observe, starts, isolated_home):
    control(isolated_home)
    observe.HOOKS["post_tool_call"](**tool_result(status=status))
    [event] = observe._queue
    assert event["kind"] == "tool.end" and event.get("status") == expected


@pytest.mark.parametrize(("status", "expected"), [
    ("completed", "completed"), ("failed", "failed"), ("error", "error"), ("timeout", "timeout"), ("interrupted", "interrupted"), ("odd", None), (None, None),
])
def test_a_helper_ends_with_its_status(status, expected, observe, starts, isolated_home):
    control(isolated_home)
    observe.HOOKS["subagent_stop"](parent_session_id=SESSION, child_session_id="child-1", child_status=status, child_summary=SECRET)
    [event] = observe._queue
    assert (event["kind"], event["child"], event.get("status")) == ("helper.end", "child-1", expected)


def test_a_helper_is_named_by_its_session_else_its_subagent_id(observe, starts, isolated_home):
    control(isolated_home)
    observe.HOOKS["subagent_start"](parent_session_id=SESSION, child_session_id=None, child_subagent_id="sa-1", child_goal=SECRET)
    # Hermes names no subagent id at the end, so an end without the child's session pairs with nothing.
    observe.HOOKS["subagent_stop"](parent_session_id=SESSION, child_session_id=None, child_status="completed")
    observe.HOOKS["subagent_start"](parent_session_id=None, child_session_id="child-2")
    assert [(event["kind"], event["child"]) for event in observe._queue] == [("helper.start", "sa-1")]


@pytest.mark.parametrize(("flags", "expected"), [
    ({"completed": True, "failed": False, "interrupted": False}, "completed"),
    ({"completed": False, "failed": True, "interrupted": False}, "failed"),
    ({"completed": False, "failed": False, "interrupted": True}, "interrupted"),
    ({"completed": False, "failed": True, "interrupted": True}, "interrupted"),
    ({"completed": False, "failed": False, "interrupted": False}, None),
    ({"completed": "yes"}, None),
])
def test_a_session_end_says_how_the_turn_ended(flags, expected, observe, starts, isolated_home):
    control(isolated_home)
    observe.HOOKS["on_session_end"](session_id=SESSION, model=SECRET, **flags)
    [event] = observe._queue
    assert event["kind"] == "session.end" and event.get("status") == expected


def test_where_a_session_runs(observe, starts, isolated_home, monkeypatch):
    control(isolated_home)
    hook = observe.HOOKS["pre_tool_call"]
    hook(**tool_call())
    observe.HOOKS["on_session_start"](session_id=SESSION, model=SECRET, platform="CLI")
    hook(**tool_call())
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "telegram")
    hook(**tool_call())
    monkeypatch.setenv("HERMES_SESSION_SOURCE", "TUI")
    hook(**tool_call())
    monkeypatch.setenv("HERMES_SESSION_SOURCE", "not a source!")
    hook(**tool_call())
    # A turn Hermes binds hides what the process inherited.
    bind(monkeypatch, {"HERMES_SESSION_PLATFORM": "discord"})
    hook(**tool_call())
    assert [event.get("source") for event in observe._queue] == [None, "cli", "cli", "telegram", "tui", "telegram", "discord"]


# Approvals.


def test_only_prompts_a_person_answers_are_waits(observe, starts, isolated_home):
    control(isolated_home)
    ask = observe.HOOKS["pre_approval_request"]
    ask(**{**APPROVAL, "surface": "smart"})
    observe.HOOKS["post_approval_response"](**{**APPROVAL, "surface": "smart", "choice": "smart_approve", "decided_by": "aux_llm"})
    ask(**{**APPROVAL, "surface": "transport:pager"})
    # The session is Hermes's session id alone, never the gateway's session key.
    ask(**{**{key: value for key, value in APPROVAL.items() if key != "session_id"}, "surface": "cli", "session_key": SESSION})
    ask(**{**APPROVAL, "surface": "cli", "session_id": ""})
    assert not observe._queue

    ask(**{**APPROVAL, "surface": "cli"})
    ask(**{**APPROVAL, "tool_call_id": "", "turn_id": "turn-7"})
    ask(**{**APPROVAL, "tool_call_id": "", "turn_id": ""})
    assert [(event["kind"], event.get("call")) for event in observe._queue] == [
        ("approval.start", call_of(SESSION, "call_1")), ("approval.start", call_of(SESSION, "turn-7")), ("approval.start", None),
    ]


@pytest.mark.parametrize(("choice", "status"), [
    ("once", "answered"), ("session", "answered"), ("always", "answered"), ("deny", "answered"),
    ("timeout", "timeout"), ("cancelled", "cancelled"), ("notify_failed", "cancelled"), ("something new", "answered"),
])
def test_an_approval_ends_answered_timed_out_or_cancelled(choice, status, observe, starts, isolated_home):
    control(isolated_home)
    observe.HOOKS["post_approval_response"](**APPROVAL, choice=choice)
    assert [(event["kind"], event["status"]) for event in observe._queue] == [("approval.end", status)]


# The sender.


def test_events_reach_herald_in_batches_of_at_most_a_hundred(observe, starts, isolated_home, herald):
    control(isolated_home, path=herald.path, token=herald.token)
    for n in range(250):
        observe.HOOKS["pre_tool_call"](**tool_call(tool_call_id=f"call_{n}"))
    sizes = []
    while taken := observe._flush_once():
        sizes.append(taken)
    assert sizes == [100, 100, 50]
    assert [(request["cmd"], request["token"], len(request["events"])) for request in herald.requests] == [
        ("activity", herald.token, 100), ("activity", herald.token, 100), ("activity", herald.token, 50),
    ]
    assert [event["call"] for request in herald.requests for event in request["events"]] == [call_of(SESSION, f"call_{n}") for n in range(250)]
    # One compact JSON line per request.
    assert all(raw.count(b"\n") == 1 and b'": ' not in raw and b'", ' not in raw for raw in herald.raw)


def test_every_herald_that_asks_gets_the_events(observe, starts, isolated_home, herald):
    folder = _short_folder()
    other = FakeHerald(os.path.join(folder, "c.sock"), "other-token")
    try:
        control(isolated_home, 1001, path=herald.path, token=herald.token)
        control(isolated_home, 1002, path=other.path, token=other.token)
        observe.HOOKS["pre_tool_call"](**tool_call())
        observe._flush_once()
        assert [request["token"] for request in herald.requests] == [herald.token]
        assert [request["token"] for request in other.requests] == [other.token]
        assert herald.requests[0]["events"] == other.requests[0]["events"]
    finally:
        other.close()
        shutil.rmtree(folder, ignore_errors=True)


@pytest.mark.parametrize("refusal", ["invalid activity token", "live detail is off"])
def test_a_refusal_stops_sending_until_the_control_file_changes(refusal, observe, starts, isolated_home, herald, monkeypatch, clock):
    monkeypatch.setattr(observe, "BATCH_MAX", 1)
    if refusal == "invalid activity token":
        control(isolated_home, path=herald.path, token="stale-token")
    else:
        control(isolated_home, path=herald.path, token=herald.token)
        herald.reply = {"ok": False, "error": refusal}
    observe.HOOKS["pre_tool_call"](**tool_call())
    observe.HOOKS["post_tool_call"](**tool_result())
    assert observe._flush_once() == 1 and observe._flush_once() == 1
    assert len(herald.requests) == 1 and not observe._queue
    # The next hook reads the folder again at once and queues nothing more.
    observe.HOOKS["pre_tool_call"](**tool_call())
    assert not observe._queue and observe.live() is False

    herald.reply = None
    control(isolated_home, path=herald.path, token=herald.token + "-new")
    herald.token += "-new"
    clock.now += observe.REFRESH_SECONDS
    observe.HOOKS["pre_tool_call"](**tool_call())
    observe._flush_once()
    assert len(herald.requests) == 2 and herald.requests[-1]["token"] == herald.token


@pytest.mark.parametrize("gone", ["no socket file", "nobody listening"])
def test_a_herald_that_is_gone_loses_only_the_events(gone, observe, starts, isolated_home, monkeypatch):
    folder = _short_folder()
    try:
        path = os.path.join(folder, "c.sock")
        if gone == "nobody listening":
            stale = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            stale.bind(path)
            stale.close()
        control(isolated_home, path=path)
        observe.HOOKS["pre_tool_call"](**tool_call())
        assert observe._flush_once() == 1 and not observe._queue
        # Backed off: a batch within RETRY_SECONDS is dropped without trying.
        tried = []
        monkeypatch.setattr(observe, "_send", lambda endpoint, events: tried.append(endpoint))
        observe.HOOKS["pre_tool_call"](**tool_call())
        assert observe._flush_once() == 1 and tried == [] and not observe._queue
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def test_a_busy_herald_is_left_alone_for_a_second(observe, starts, isolated_home, herald, clock):
    control(isolated_home, path=herald.path, token=herald.token)
    herald.reply = {"ok": False, "error": "too many events"}
    observe.HOOKS["pre_tool_call"](**tool_call())
    observe._flush_once()
    herald.reply = None
    observe.HOOKS["pre_tool_call"](**tool_call())
    observe._flush_once()
    assert len(herald.requests) == 1
    clock.now += observe.BUSY_SECONDS
    observe.HOOKS["pre_tool_call"](**tool_call())
    observe._flush_once()
    assert len(herald.requests) == 2


def test_the_sender_thread_starts_with_the_first_event_and_stops_when_idle(observe, starts, isolated_home, herald, monkeypatch):
    monkeypatch.setattr(observe, "_start_sender", starts.real)
    monkeypatch.setattr(observe, "WAIT_SECONDS", 0.02)
    monkeypatch.setattr(observe, "IDLE_SECONDS", 0.2)
    control(isolated_home, path=herald.path, token=herald.token)
    for n in (1, 2):
        observe.HOOKS["pre_tool_call"](**tool_call(tool_call_id=f"call_{n}"))
        thread = observe._sender
        assert thread is not None and thread.name == observe.THREAD_NAME and thread.daemon
        assert wait_for(lambda: len(herald.requests) == n)
        thread.join(timeout=3.0)
        assert not thread.is_alive() and observe._sender is None
    assert [request["events"][0]["call"] for request in herald.requests] == [call_of(SESSION, "call_1"), call_of(SESSION, "call_2")]
