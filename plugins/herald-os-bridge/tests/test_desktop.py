"""Contracts for the ``desktop`` tool: tiers, argv, approvals that name their element, batches.

The desktop control binary is never executed; ``run`` is monkeypatched to answer with its JSON
envelope and ``authorize`` (or Hermes's approval channel) to record what would be asked."""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


READ = {"snapshot", "find", "get", "is", "wait", "list-apps", "list-windows", "list-displays", "list-surfaces", "list-notifications", "status", "permissions", "version"}
MUTATE = {"click", "type", "set-value", "select", "toggle", "scroll", "press", "launch", "focus", "clipboard-set", "screenshot", "clipboard-get"}
DESTRUCTIVE = {"close-app", "notification-action", "dismiss-notification", "dismiss-all-notifications", "clipboard-clear"}

SNAPSHOT = {
    "app": "Text Editor",
    "window": {"id": "w1", "title": "Untitled"},
    "snapshot_id": "s8f3k2p9",
    "complete": True,
    "tree": {
        "role": "window",
        "name": "Untitled",
        "children": [
            {"ref_id": "@s8f3k2p9:e1", "role": "button", "name": "Save"},
            {"ref_id": "@s8f3k2p9:e2", "role": "text", "name": "Document"},
            {"ref_id": "@e3", "role": "password text", "name": "Passphrase"},
            {"ref_id": "@s8f3k2p9:e4", "role": "check box", "name": "Spell check"},
            {"ref_id": "@s8f3k2p9:e5", "role": "combo box", "name": "Language"},
            {"ref_id": "@s8f3k2p9:e6", "role": "scroll pane"},
            {"ref_id": "@s8f3k2p9:e7", "role": "push button", "name": "OK\n(approve everything)\u202e “quoted”"},
        ],
    },
}
BROWSER = {"app": "Firefox", "snapshot_id": "sfirefox1", "tree": {"role": "window", "children": [{"ref_id": "@sfirefox1:e1", "role": "button", "name": "Reload"}]}}

# command -> (arguments, the argv after the binary)
ARGV = {
    "snapshot": ({"app": "Text Editor"}, ["snapshot", "--app=Text Editor", "--interactive-only", "--compact"]),
    "find": ({"app": "Firefox", "role": "button", "name": "Reload", "first": True}, ["find", "--app=Firefox", "--role=button", "--name=Reload", "--first"]),
    "get": ({"ref": "@s8f3k2p9:e2", "property": "value"}, ["get", "@s8f3k2p9:e2", "--property=value"]),
    "is": ({"ref": "@s8f3k2p9:e4", "property": "checked"}, ["is", "@s8f3k2p9:e4", "--property=checked"]),
    "wait": ({"ms": 500}, ["wait", "500"]),
    "list-apps": ({}, ["list-apps"]),
    "list-windows": ({"app": "Firefox"}, ["list-windows", "--app=Firefox"]),
    "list-displays": ({}, ["list-displays"]),
    "list-surfaces": ({}, ["list-surfaces"]),
    "list-notifications": ({"limit": 5}, ["list-notifications", "--limit=5"]),
    "status": ({}, ["status"]),
    "permissions": ({}, ["permissions"]),
    "version": ({}, ["version"]),
    "click": ({"ref": "@s8f3k2p9:e1"}, ["click", "@s8f3k2p9:e1"]),
    "type": ({"ref": "@s8f3k2p9:e2", "text": "-rf hello"}, ["type", "@s8f3k2p9:e2", "--", "-rf hello"]),
    "set-value": ({"ref": "@s8f3k2p9:e2", "value": "Dear Sam"}, ["set-value", "@s8f3k2p9:e2", "--", "Dear Sam"]),
    "select": ({"ref": "@s8f3k2p9:e5", "value": "English"}, ["select", "@s8f3k2p9:e5", "--", "English"]),
    "toggle": ({"ref": "@s8f3k2p9:e4"}, ["toggle", "@s8f3k2p9:e4"]),
    "scroll": ({"ref": "@s8f3k2p9:e6", "direction": "up", "amount": 5}, ["scroll", "@s8f3k2p9:e6", "--direction=up", "--amount=5"]),
    "press": ({"key": "Ctrl+S"}, ["press", "ctrl+s"]),
    "launch": ({"app": "Text Editor"}, ["launch", "--", "Text Editor"]),
    "focus": ({"ref": "@s8f3k2p9:e2"}, ["focus", "@s8f3k2p9:e2"]),
    "clipboard-set": ({"text": "--version"}, ["clipboard-set", "--", "--version"]),
    "screenshot": ({"app": "Firefox"}, None),
    "clipboard-get": ({}, ["clipboard-get", "--format=text"]),
    "close-app": ({"app": "Text Editor", "force": True}, ["close-app", "--force", "--", "Text Editor"]),
    "notification-action": ({"index": 2, "action": "Reply", "expected_app": "Chat"}, ["notification-action", "--expected-app=Chat", "--", "2", "Reply"]),
    "dismiss-notification": ({"index": 1, "expected_title": "Update ready"}, ["dismiss-notification", "--expected-title=Update ready", "--", "1"]),
    "dismiss-all-notifications": ({"app": "Chat"}, ["dismiss-all-notifications", "--app=Chat"]),
    "clipboard-clear": ({}, ["clipboard-clear"]),
}


@pytest.fixture
def desktop(plugin):
    module = _mod(plugin, "desktop")
    module.forget()
    module.remember(SNAPSHOT)
    module.remember(BROWSER)
    yield module
    module.forget()


class Binary:
    """The desktop control binary: records each argv and answers with an envelope."""

    def __init__(self, util):
        self.util = util
        self.calls: list[list[str]] = []
        self.replies: dict[str, dict] = {}

    def run(self, argv, *, timeout=15.0, **_):
        self.calls.append(list(argv))
        command = argv[1]
        reply = self.replies.get(command, {"ok": True, "command": command, "data": {"action": command, "disposition": {"delivery": "delivered_unverified", "retry": "unsafe"}}})
        return self.util.ExecResult(0 if reply.get("ok") else 1, json.dumps(reply), "")


class Asked:
    def __init__(self, perm):
        self.perm = perm
        self.calls: list[tuple] = []

    def authorize(self, tool, tier, action, summary, *, paths=(), scope=None):
        assert tool == "desktop"
        self.calls.append((tier.value, action, summary, scope))
        return self.perm.Decision(True, "allowed")


@pytest.fixture
def linux(plugin, monkeypatch, desktop):
    tools = _mod(plugin, "tools")
    binary = Binary(_mod(plugin, "util"))
    asked = Asked(_mod(plugin, "permissions"))
    monkeypatch.setattr(tools, "host", lambda: types.SimpleNamespace(platform="linux"))
    monkeypatch.setattr(tools, "run", binary.run)
    monkeypatch.setattr(tools, "authorize", asked.authorize)
    monkeypatch.setattr(desktop, "binary", lambda: Path("/usr/libexec/herald-os/agent-desktop"))
    return types.SimpleNamespace(tools=tools, binary=binary, asked=asked)


def call(linux, **args):
    return json.loads(linux.tools.handle_desktop(args))


# Tiers.


def test_every_command_has_its_tier(desktop):
    tiers = {command: tier.value for command, tier in desktop.TIERS.items()}
    assert set(tiers) == READ | MUTATE | DESTRUCTIVE
    assert {c for c, t in tiers.items() if t == "read"} == READ
    assert {c for c, t in tiers.items() if t == "mutate"} == MUTATE
    assert {c for c, t in tiers.items() if t == "destructive"} == DESTRUCTIVE
    assert desktop.COMMANDS == (*desktop.TIERS, "batch")


@pytest.mark.parametrize("command", sorted(ARGV))
def test_each_command_runs_its_argv_at_its_tier(command, linux):
    args, argv = ARGV[command]
    result = call(linux, command=command, **args)
    assert result["success"], result
    expected = "read" if command in READ else "mutate" if command in MUTATE else "destructive"
    assert [tier for tier, *_ in linux.asked.calls] == [expected]
    ran = linux.binary.calls[-1]
    assert ran[0] == "/usr/libexec/herald-os/agent-desktop"
    if argv is not None:
        assert ran[1:] == argv


def test_the_schema_offers_every_command_and_the_manifest_lists_the_tool(plugin, desktop):
    tools = _mod(plugin, "tools")
    assert tools.DESKTOP_SCHEMA["parameters"]["properties"]["command"]["enum"] == list(desktop.COMMANDS)
    step = tools.DESKTOP_SCHEMA["parameters"]["properties"]["steps"]["items"]["properties"]["command"]["enum"]
    assert "batch" not in step and set(step) == set(desktop.TIERS)
    assert dict((spec.name, spec.handler) for spec in tools.TOOL_SPECS)["desktop"] is tools.handle_desktop
    manifest = (Path(plugin.__file__).parent / "plugin.yaml").read_text()
    assert "  - desktop\n" in manifest


def test_screenshot_and_clipboard_reads_ask_first_through_the_policy(plugin, desktop):
    perm = _mod(plugin, "permissions")
    policy = perm.load_policy()
    for command in ("screenshot", "clipboard-get"):
        assert policy.mode(desktop.TIERS[command]) == "confirm"
    assert all(policy.mode(desktop.TIERS[c]) == "allow" for c in READ)


# Approvals that say what they act on.


def test_the_approval_names_the_element_from_the_snapshot(linux):
    call(linux, command="click", ref="@s8f3k2p9:e1")
    call(linux, command="toggle", ref="@s8f3k2p9:e4")
    call(linux, command="click", ref="@sfirefox1:e1")
    summaries = [summary for _, _, summary, _ in linux.asked.calls]
    assert summaries == [
        "click the button “Save” in Text Editor",
        "toggle the check box “Spell check” in Text Editor",
        "click the button “Reload” in Firefox",
    ]


def test_typing_names_the_text_and_the_field_and_hides_a_password(linux):
    call(linux, command="type", ref="@s8f3k2p9:e2", text="Dear Sam,")
    call(linux, command="type", ref="@s8f3k2p9:e3", text="hunter2")
    call(linux, command="set-value", ref="@s8f3k2p9:e3", value="hunter2")
    call(linux, command="select", ref="@s8f3k2p9:e5", value="English")
    summaries = [summary for _, _, summary, _ in linux.asked.calls]
    assert summaries[0] == "type “Dear Sam,” into the text “Document” in Text Editor"
    assert summaries[1] == "type 7 hidden characters into the password text “Passphrase” in Text Editor"
    assert "hunter2" not in summaries[2]
    assert summaries[3] == "choose “English” in the combo box “Language” in Text Editor"


def test_a_bare_ref_in_a_snapshot_is_qualified_by_its_snapshot(desktop):
    found = desktop.element("@s8f3k2p9:e3")
    assert found is not None and found.name == "Passphrase" and found.app == "Text Editor"


def test_an_app_cannot_write_the_approval_with_its_element_names(linux):
    call(linux, command="click", ref="@s8f3k2p9:e7")
    summary = linux.asked.calls[-1][2]
    assert "\n" not in summary and "\u202e" not in summary
    assert summary == "click the push button “OK (approve everything) 'quoted'” in Text Editor"


def test_unnamed_elements_say_so(linux):
    call(linux, command="scroll", ref="@s8f3k2p9:e6")
    assert linux.asked.calls[-1][2] == "scroll an unnamed scroll pane in Text Editor down"


@pytest.mark.parametrize("command,extra", [("click", {}), ("type", {"text": "x"}), ("set-value", {"value": "x"}), ("toggle", {}), ("focus", {}), ("scroll", {}), ("select", {"value": "x"})])
def test_acting_on_a_ref_no_snapshot_named_fails_before_asking(command, extra, linux):
    result = call(linux, command=command, ref="@sunknown9:e1", **extra)
    assert not result["success"] and "take a snapshot" in result["error"]
    assert linux.asked.calls == [] and linux.binary.calls == []


@pytest.mark.parametrize("args,needle", [
    ({"command": "click", "ref": "@e1"}, "ref must be"),
    ({"command": "click", "ref": "s8f3k2p9:e1"}, "ref must be"),
    ({"command": "launch", "app": "--help"}, "does not start with '-'"),
    ({"command": "launch"}, "app is required"),
    ({"command": "close-app", "app": "Firefox\nrm"}, "plain name"),
    ({"command": "press", "key": "ctrl+s; rm -rf ~"}, "key must be"),
    ({"command": "find"}, "needs a role"),
    ({"command": "dismiss-notification", "index": 1}, "expected_app or expected_title"),
    ({"command": "notification-action", "index": 1, "expected_app": "Chat"}, "action is required"),
    ({"command": "wait"}, "wait needs"),
    ({"command": "snapshot", "max_depth": 500}, "between 1 and 50"),
    ({"command": "type", "ref": "@s8f3k2p9:e2", "text": ""}, "text is required"),
    ({"command": "mouse-click"}, "unknown command"),
    ({}, "unknown command"),
])
def test_bad_arguments_fail_before_asking_or_running(args, needle, linux):
    result = json.loads(linux.tools.handle_desktop(args))
    assert not result["success"] and needle in result["error"], result
    assert linux.asked.calls == [] and linux.binary.calls == []


# Approval scopes, through the real permission engine.


class Approvals:
    def __init__(self):
        self.asked: list[tuple[str, str]] = []
        self.always: set[str] = set()

    def request_tool_approval(self, tool, reason, *, rule_key):
        if rule_key in self.always:
            return {"approved": True}
        self.asked.append((rule_key, reason))
        self.always.add(rule_key)
        return {"approved": True, "choice": "always"}


@pytest.fixture
def approvals(plugin, monkeypatch, desktop):
    tools = _mod(plugin, "tools")
    channel = Approvals()
    package = types.ModuleType("tools")
    module = types.ModuleType("tools.approval")
    module.request_tool_approval = channel.request_tool_approval
    package.approval = module
    monkeypatch.setitem(sys.modules, "tools", package)
    monkeypatch.setitem(sys.modules, "tools.approval", module)
    monkeypatch.setattr(tools, "host", lambda: types.SimpleNamespace(platform="linux"))
    monkeypatch.setattr(tools, "run", Binary(_mod(plugin, "util")).run)
    monkeypatch.setattr(desktop, "binary", lambda: Path("/usr/libexec/herald-os/agent-desktop"))
    return types.SimpleNamespace(tools=tools, channel=channel)


def test_always_allowing_a_click_in_one_app_holds_for_that_app_and_command_only(approvals):
    run = lambda **args: json.loads(approvals.tools.handle_desktop(args))["success"]
    assert run(command="click", ref="@s8f3k2p9:e1")
    assert run(command="click", ref="@s8f3k2p9:e4")
    assert [key for key, _ in approvals.channel.asked] == ["herald_os:desktop:click:text-editor"]
    assert run(command="click", ref="@sfirefox1:e1")
    assert run(command="type", ref="@s8f3k2p9:e2", text="hi")
    assert [key for key, _ in approvals.channel.asked] == [
        "herald_os:desktop:click:text-editor", "herald_os:desktop:click:firefox", "herald_os:desktop:type:text-editor",
    ]


def test_reads_never_ask_and_destructive_commands_always_do(approvals):
    run = lambda **args: json.loads(approvals.tools.handle_desktop(args))["success"]
    assert run(command="snapshot", app="Text Editor") and run(command="list-apps")
    assert approvals.channel.asked == []
    assert run(command="close-app", app="Text Editor")
    assert run(command="close-app", app="Text Editor")
    keys = [key for key, _ in approvals.channel.asked]
    assert len(keys) == 2 and keys[0] != keys[1] and all(key.startswith("herald_os:desktop:close-app:") for key in keys)


def test_screenshot_and_clipboard_get_ask_with_their_own_scope(approvals):
    run = lambda **args: json.loads(approvals.tools.handle_desktop(args))["success"]
    assert run(command="screenshot", app="Firefox") and run(command="screenshot") and run(command="clipboard-get")
    assert [key for key, _ in approvals.channel.asked] == [
        "herald_os:desktop:screenshot:firefox", "herald_os:desktop:screenshot:screen", "herald_os:desktop:clipboard-get:clipboard",
    ]


# Batches.


def test_a_batch_asks_once_at_its_highest_tier_and_lists_every_step(linux):
    result = call(linux, command="batch", steps=[
        {"command": "snapshot", "app": "Text Editor"},
        {"command": "click", "ref": "@s8f3k2p9:e1"},
        {"command": "type", "ref": "@s8f3k2p9:e2", "text": "Hello"},
    ])
    assert result["success"] and [s["command"] for s in result["steps"]] == ["snapshot", "click", "type"]
    assert len(linux.asked.calls) == 1
    tier, action, summary, scope = linux.asked.calls[0]
    assert (tier, action) == ("mutate", "batch") and scope.startswith("batch-")
    assert summary == "run 3 desktop steps: 1. read the accessibility tree of Text Editor; 2. click the button “Save” in Text Editor; 3. type “Hello” into the text “Document” in Text Editor"
    assert [argv[1] for argv in linux.binary.calls] == ["snapshot", "click", "type"]


@pytest.mark.parametrize("commands,tier", [
    (["status", "list-apps"], "read"),
    (["status", "clipboard-get"], "mutate"),
    (["clipboard-set", "status", "clipboard-clear"], "destructive"),
    (["clipboard-clear", "status"], "destructive"),
])
def test_a_batch_takes_the_highest_tier_of_its_steps(commands, tier, desktop):
    steps = [{"command": c, **({"text": "x"} if c == "clipboard-set" else {})} for c in commands]
    assert desktop.plan({"command": "batch", "steps": steps}).tier.value == tier


def test_a_read_only_batch_has_no_approval_scope(desktop):
    assert desktop.plan({"command": "batch", "steps": [{"command": "status"}]}).scope is None


def test_a_batch_s_always_allow_covers_those_commands_in_those_apps(desktop):
    one = desktop.plan({"command": "batch", "steps": [{"command": "click", "ref": "@s8f3k2p9:e1"}]}).scope
    same = desktop.plan({"command": "batch", "steps": [{"command": "status"}, {"command": "click", "ref": "@s8f3k2p9:e4"}]}).scope
    other = desktop.plan({"command": "batch", "steps": [{"command": "click", "ref": "@sfirefox1:e1"}]}).scope
    assert one == same and one != other


@pytest.mark.parametrize("steps,needle", [
    ([], "batch needs steps"),
    ([{"command": "batch", "steps": [{"command": "status"}]}], "cannot be another batch"),
    ([{"command": "status"}] * 21, "at most 20"),
    ([{"command": "status"}, {"command": "click", "ref": "@sunknown9:e1"}], "take a snapshot"),
    (["status"], "must be an object"),
])
def test_a_bad_batch_runs_nothing(steps, needle, linux):
    result = call(linux, command="batch", steps=steps)
    assert not result["success"] and needle in result["error"]
    assert linux.asked.calls == [] and linux.binary.calls == []


def test_a_batch_stops_at_the_first_failed_step_and_says_what_ran(linux):
    linux.binary.replies["click"] = {"ok": False, "command": "click", "error": {"code": "STALE_REF", "message": "gone", "disposition": {"delivery": "not_delivered", "retry": "safe"}}}
    result = call(linux, command="batch", steps=[{"command": "status"}, {"command": "click", "ref": "@s8f3k2p9:e1"}, {"command": "clipboard-clear"}])
    assert not result["success"] and result["failed_step"] == 2 and result["code"] == "STALE_REF"
    assert [step["command"] for step in result["completed"]] == ["status"]
    assert [argv[1] for argv in linux.binary.calls] == ["status", "click"]


# Results.


def test_a_snapshot_s_elements_are_remembered_for_the_next_approval(linux, desktop):
    desktop.forget()
    linux.binary.replies["snapshot"] = {"ok": True, "command": "snapshot", "data": SNAPSHOT}
    assert not call(linux, command="click", ref="@s8f3k2p9:e1")["success"]
    result = call(linux, command="snapshot", app="Text Editor")
    assert result["success"] and result["result"]["snapshot_id"] == "s8f3k2p9"
    assert call(linux, command="click", ref="@s8f3k2p9:e1")["success"]
    assert linux.asked.calls[-1][2] == "click the button “Save” in Text Editor"


def test_find_results_take_the_app_the_call_asked_for(linux, desktop):
    linux.binary.replies["find"] = {"ok": True, "command": "find", "data": {"matches": [{"ref_id": "@sfind1234:e9", "role": "link", "name": "Docs"}], "snapshot_id": "sfind1234"}}
    call(linux, command="find", app="Firefox", text="Docs")
    assert desktop.element("@sfind1234:e9") == desktop.Element("@sfind1234:e9", "link", "Docs", "Firefox")


def test_only_the_newest_snapshots_are_kept(desktop):
    for n in range(desktop.SNAPSHOTS_KEPT + 2):
        desktop.remember({"snapshot_id": f"sold{n:04d}", "tree": {"ref_id": "@e1", "role": "button", "name": str(n)}})
    assert desktop.element("@sold0000:e1") is None and desktop.element(f"@sold{desktop.SNAPSHOTS_KEPT + 1:04d}:e1") is not None


def test_an_error_keeps_the_code_suggestion_and_disposition(linux):
    linux.binary.replies["click"] = {"ok": False, "command": "click", "error": {"code": "STALE_REF", "message": "@s8f3k2p9:e1 not found", "suggestion": "Re-run a snapshot", "disposition": {"delivery": "not_delivered", "retry": "safe"}}}
    result = call(linux, command="click", ref="@s8f3k2p9:e1")
    assert not result["success"] and result["error"] == "STALE_REF: @s8f3k2p9:e1 not found"
    assert result["disposition"] == {"delivery": "not_delivered", "retry": "safe"} and result["suggestion"] == "Re-run a snapshot"


def test_a_large_tree_is_cut_with_a_hint(linux):
    linux.binary.replies["snapshot"] = {"ok": True, "command": "snapshot", "data": {"snapshot_id": "sbig12345", "tree": {"children": [{"role": "text", "name": "x" * 100}] * 1000}}}
    result = call(linux, command="snapshot", app="Big")
    assert result["truncated"] and len(result["result_text"]) == linux.tools.DESKTOP_OUTPUT_LIMIT and "skeleton" in result["hint"]


def test_screenshots_go_to_a_private_folder_hermes_can_read(linux, isolated_home):
    result = call(linux, command="screenshot", app="Firefox")
    shot = Path(result["screenshot"])
    assert shot.parent == isolated_home / "herald-os" / "desktop" / "screenshots" and shot.suffix == ".png"
    assert linux.binary.calls[-1][1:] == ["screenshot", "--app=Firefox", str(shot)]
    assert (shot.parent.stat().st_mode & 0o777) == 0o700


def test_typed_text_is_audited_by_its_length_and_the_approved_preview_only(linux, isolated_home):
    letter = "Dear Sam, " + "the quarterly figures are attached. " * 10
    call(linux, command="type", ref="@s8f3k2p9:e2", text=letter)
    call(linux, command="type", ref="@s8f3k2p9:e3", text="hunter2")
    call(linux, command="clipboard-set", text="copied note")
    entries = [json.loads(line) for line in (isolated_home / "herald-os" / "audit.jsonl").read_text().splitlines()]
    assert [entry["args"]["text"] for entry in entries] == [f"[{len(letter)} characters]", "[7 characters]", "[11 characters]"]
    log = json.dumps(entries)
    assert letter not in log and letter[:79] in log, "the summary keeps what the approval showed"
    assert "hunter2" not in log


def test_unavailable_off_linux_and_when_not_installed(linux, desktop, monkeypatch):
    monkeypatch.setattr(desktop, "binary", lambda: None)
    result = call(linux, command="status")
    assert not result["success"] and "not installed" in result["error"] and "/usr/libexec/herald-os" in result["error"]
    monkeypatch.setattr(linux.tools, "host", lambda: types.SimpleNamespace(platform="darwin"))
    result = call(linux, command="status")
    assert not result["success"] and "only available on Herald OS Linux" in result["error"]


def test_the_binary_is_found_where_the_image_and_the_vm_install_it(plugin, tmp_path, monkeypatch):
    module = _mod(plugin, "desktop")
    image, vm = tmp_path / "image", tmp_path / "vm"
    vm.mkdir()
    (vm / module.BINARY).write_text("#!/bin/sh\n")
    (vm / module.BINARY).chmod(0o755)
    monkeypatch.setattr(module, "INSTALL_DIRS", (image, vm))
    monkeypatch.delenv("HERALD_OS_DESKTOP_BIN", raising=False)
    assert module.binary() == vm / module.BINARY
    image.mkdir()
    (image / module.BINARY).write_text("#!/bin/sh\n")
    (image / module.BINARY).chmod(0o755)
    assert module.binary() == image / module.BINARY
    monkeypatch.setenv("HERALD_OS_DESKTOP_BIN", str(tmp_path / "missing"))
    assert module.binary() is None
