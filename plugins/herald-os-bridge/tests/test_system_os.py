"""Contracts for the ``system_os`` tool: argv mapping, tiers, validation and the non-Linux guard.

The ``herald-os`` CLI is never executed; ``run`` is monkeypatched to capture the argv."""

from __future__ import annotations

import importlib
import json
import types

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


class _Capture:
    """Records what the handler asked for and answers with a canned ``ExecResult``."""

    def __init__(self, util, result=None):
        self.util = util
        self.result = result or util.ExecResult(0, "done\n", "")
        self.argv = None
        self.timeout = None
        self.tier = None
        self.summary = None
        self.action = None

    def run(self, argv, *, timeout=15.0, **_):
        self.argv = list(argv)
        self.timeout = timeout
        return self.result

    def authorize(self, tool, tier, action, summary, *, paths=()):
        assert tool == "system_os"
        self.tier, self.action, self.summary = tier, action, summary
        return self.perm.Decision(True, "allowed")


@pytest.fixture
def linux(plugin, monkeypatch):
    """A linux host plus captured ``run`` / ``authorize``; returns the capture object."""
    tools = _mod(plugin, "tools")
    util = _mod(plugin, "util")
    capture = _Capture(util)
    capture.perm = _mod(plugin, "permissions")
    monkeypatch.setattr(tools, "host", lambda: types.SimpleNamespace(platform="linux"))
    monkeypatch.setattr(tools, "run", capture.run)
    monkeypatch.setattr(tools, "authorize", capture.authorize)
    return capture


# action args -> (herald-os argv tail, tier)
CASES = {
    "install_app": ({"name": "firefox"}, ["install", "app", "firefox"], "mutate"),
    "install_webapp": ({"name": "Notion", "url": "https://notion.so"}, ["install", "webapp", "Notion", "https://notion.so"], "mutate"),
    "install_webapp_icon": ({"action": "install_webapp", "name": "Notion", "url": "https://notion.so", "icon_url": "https://x/i.png"}, ["install", "webapp", "Notion", "https://notion.so", "https://x/i.png"], "mutate"),
    "remove_app": ({"name": "org.gimp.GIMP"}, ["remove", "app", "org.gimp.GIMP"], "destructive"),
    "remove_webapp": ({"name": "Notion"}, ["remove", "webapp", "Notion"], "mutate"),
    "reminder": ({"duration": "20m", "message": "Stretch"}, ["reminder", "20m", "Stretch"], "act"),
    "reminders_list": ({}, ["reminder", "list"], "read"),
    "reminders_clear": ({}, ["reminder", "clear"], "mutate"),
    "notice": ({"kind": "battery"}, ["notice", "battery"], "read"),
    "screenshot": ({}, ["screenshot"], "act"),
    "ocr": ({}, ["ocr"], "act"),
    "lock": ({}, ["lock"], "act"),
    "suspend": ({}, ["suspend"], "destructive"),
    "restart": ({"device": "sound"}, ["restart", "sound"], "mutate"),
    "restart_touchpad": ({"action": "restart", "device": "Touchpad"}, ["restart", "touchpad"], "mutate"),
    "theme_list": ({}, ["theme", "list"], "read"),
    "theme_set": ({"name": "midnight"}, ["theme", "set", "midnight"], "act"),
    "theme_current": ({}, ["theme", "current"], "read"),
    "update": ({}, ["update"], "mutate"),
    "show_page": ({"page": "missions"}, ["page", "missions"], "read"),
    "open_window": ({"window": "terminal"}, ["open", "terminal"], "read"),
    "launch": ({"name": "obsidian"}, ["launch", "obsidian"], "act"),
    "notify": ({"title": "Build done", "body": "All green"}, ["notify", "Build done", "All green"], "act"),
    "notify_no_body": ({"action": "notify", "title": "Ping"}, ["notify", "Ping"], "act"),
    "focus_workspace": ({"name": "work"}, ["wm", "focus-workspace", "work"], "read"),
    "close_focused_window": ({}, ["wm", "close-window"], "act"),
    "catalog_install": ({"id": "claude-code"}, ["catalog", "install", "claude-code"], "mutate"),
    "catalog_remove": ({"id": "Steam"}, ["catalog", "remove", "steam"], "destructive"),
    "plugin_list": ({}, ["plugin", "list"], "read"),
    "plugin_add": ({"url": "https://example.com/me/weather-strip.git"}, ["plugin", "add", "https://example.com/me/weather-strip.git"], "mutate"),
    "plugin_update": ({"id": "weather-strip"}, ["plugin", "update", "weather-strip"], "mutate"),
    "plugin_disable": ({"id": "Weather-Strip"}, ["plugin", "disable", "weather-strip"], "act"),
    "plugin_remove": ({"id": "weather-strip"}, ["plugin", "remove", "weather-strip"], "destructive"),
}
# Actions whose result is not plain output; each has its own test below.
SEPARATE = {"catalog_list"}


@pytest.mark.parametrize("case", sorted(CASES))
def test_action_maps_to_herald_os_argv_and_tier(plugin, linux, case):
    tools = _mod(plugin, "tools")
    extra, tail, tier = CASES[case]
    args = {"action": case, **extra}
    result = json.loads(tools.system_os_handler(args))
    assert result["success"], result
    assert linux.argv == ["herald-os", *tail]
    assert linux.tier.value == tier
    assert linux.action == args["action"]
    assert result["action"] == args["action"] and result["output"] == "done"
    assert result["summary"] == linux.summary


def test_every_schema_action_is_covered(plugin):
    tools = _mod(plugin, "tools")
    actions = set(tools.SYSTEM_OS_SCHEMA["parameters"]["properties"]["action"]["enum"])
    assert actions == set(tools.SYSTEM_OS_TIERS)
    covered = {CASES[c][0].get("action", c) for c in CASES}
    assert actions == covered | SEPARATE
    assert "system_os" in [spec.name for spec in tools.TOOL_SPECS]


def test_catalog_list_is_compacted_per_group(plugin, linux):
    tools = _mod(plugin, "tools")
    listing = {
        "groups": [
            {"id": "ai", "label": "AI", "entries": [
                {"id": "codex", "label": "Codex", "installed": True, "available": True},
                {"id": "ollama", "label": "Ollama", "installed": False, "available": True},
            ]},
            {"id": "gaming", "label": "Gaming", "entries": [{"id": "steam", "label": "Steam", "installed": False, "available": False, "reason": "needs an x86_64 PC"}]},
        ]
    }
    linux.result = linux.util.ExecResult(0, json.dumps(listing), "")
    result = json.loads(tools.system_os_handler({"action": "catalog_list"}))
    assert result["success"], result
    assert linux.argv == ["herald-os", "catalog", "list", "--json"] and linux.tier.value == "read"
    assert result["catalog"] == {
        "AI": ["codex: Codex (installed)", "ollama: Ollama (available)"],
        "Gaming": ["steam: Steam (unavailable: needs an x86_64 PC)"],
    }


@pytest.mark.parametrize("entry", ["", "--purge", "claude code", "../x", "a" * 70])
def test_catalog_ids_are_validated(plugin, linux, entry):
    tools = _mod(plugin, "tools")
    result = json.loads(tools.system_os_handler({"action": "catalog_install", "id": entry}))
    assert not result["success"] and "catalog id" in result["error"]
    assert linux.argv is None


@pytest.mark.parametrize(("args", "needle"), [
    ({"action": "plugin_add", "url": "file:///etc"}, "git repository"),
    ({"action": "plugin_add", "url": "--upload-pack=x"}, "git repository"),
    ({"action": "plugin_remove", "id": "../x"}, "plugin id"),
    ({"action": "plugin_update", "id": "-f"}, "plugin id"),
])
def test_plugin_arguments_are_validated(plugin, linux, args, needle):
    tools = _mod(plugin, "tools")
    result = json.loads(tools.system_os_handler(args))
    assert not result["success"] and needle in result["error"]
    assert linux.argv is None


def test_plugins_cannot_be_turned_on_by_hermes(plugin):
    tools = _mod(plugin, "tools")
    actions = tools.SYSTEM_OS_SCHEMA["parameters"]["properties"]["action"]["enum"]
    assert "plugin_enable" not in actions
    with pytest.raises(ValueError):
        tools.plan_system_os({"action": "plugin_enable", "id": "weather-strip"})


@pytest.mark.parametrize(("device", "interrupts"), [
    ("wifi", "network drops"),
    ("bluetooth", "headsets drop"),
    ("sound", "including calls"),
    ("touchpad", "password"),
])
def test_every_restart_asks_first_and_says_what_it_interrupts(plugin, linux, device, interrupts):
    tools = _mod(plugin, "tools")
    result = json.loads(tools.system_os_handler({"action": "restart", "device": device}))
    assert result["success"], result
    assert linux.tier.value == "mutate" and linux.action == "restart"
    assert interrupts in linux.summary
    assert linux.argv == ["herald-os", "restart", device]


@pytest.mark.parametrize("device", ["wifi", "bluetooth", "sound", "touchpad"])
def test_a_restart_the_user_turns_down_does_not_run(plugin, linux, monkeypatch, device):
    tools = _mod(plugin, "tools")
    asked = []

    def decline(tool, tier, action, summary, *, paths=()):
        asked.append(tier.value)
        return linux.perm.Decision(False, "denied", "no")

    monkeypatch.setattr(tools, "authorize", decline)
    result = json.loads(tools.system_os_handler({"action": "restart", "device": device}))
    assert not result["success"] and result["decision"] == "denied"
    assert asked == ["mutate"] and linux.argv is None


def test_mutate_asks_under_the_default_policy(plugin):
    perm = _mod(plugin, "permissions")
    tools = _mod(plugin, "tools")
    assert perm.DEFAULT_TIER_MODES[tools.SYSTEM_OS_TIERS["restart"]] == "confirm"


def test_install_and_update_get_the_long_timeout(plugin, linux):
    tools = _mod(plugin, "tools")
    for action, extra in (("install_app", {"name": "x"}), ("install_webapp", {"name": "x", "url": "https://x"}), ("remove_app", {"name": "x"}), ("update", {}), ("restart", {"device": "touchpad"})):
        tools.system_os_handler({"action": action, **extra})
        assert linux.timeout == 1200.0, action
    tools.system_os_handler({"action": "theme_list"})
    assert linux.timeout == 60.0


def test_plain_minutes_become_a_duration(plugin, linux):
    tools = _mod(plugin, "tools")
    tools.system_os_handler({"action": "reminder", "duration": 45, "message": "tea"})
    assert linux.argv == ["herald-os", "reminder", "45m", "tea"]
    assert tools.normalise_duration("1h30m") == "1h30m"
    assert tools.normalise_duration(" 90S ") == "90s"


@pytest.mark.parametrize("args, needle", [
    ({"action": "reminder", "duration": "soon", "message": "x"}, "duration"),
    ({"action": "reminder", "duration": "20m30h", "message": "x"}, "duration"),
    ({"action": "reminder", "duration": "0", "message": "x"}, "positive"),
    ({"action": "reminder", "duration": "20m"}, "message"),
    ({"action": "install_webapp", "name": "Notion", "url": "notion.so"}, "http"),
    ({"action": "install_webapp", "name": "Notion", "url": "https://notion.so", "icon_url": "ftp://x"}, "icon_url"),
    ({"action": "install_webapp", "url": "https://notion.so"}, "name"),
    ({"action": "install_app", "name": "  "}, "name"),
    ({"action": "install_app", "name": "--help"}, "'-'"),
    ({"action": "theme_set"}, "name"),
    ({"action": "launch"}, "name"),
    ({"action": "focus_workspace"}, "name"),
    ({"action": "show_page"}, "page"),
    ({"action": "notify", "body": "no title"}, "title"),
    ({"action": "notice", "kind": "moon"}, "kind"),
    ({"action": "open_window", "window": "browser"}, "window"),
    ({"action": "restart"}, "device"),
    ({"action": "restart", "device": "printer"}, "device"),
    ({"action": "restart", "device": "--help"}, "device"),
    ({"action": "format_disk"}, "unknown action"),
    ({}, "unknown action"),
])
def test_invalid_arguments_fail_before_asking_or_running(plugin, linux, args, needle):
    tools = _mod(plugin, "tools")
    result = json.loads(tools.system_os_handler(args))
    assert not result["success"] and needle in result["error"], result
    assert linux.argv is None and linux.tier is None


def test_unavailable_off_linux(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.setattr(tools, "host", lambda: types.SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(tools, "run", lambda *a, **k: pytest.fail("must not run herald-os on macOS"))
    result = json.loads(tools.system_os_handler({"action": "theme_list"}))
    assert not result["success"] and "only available on Herald OS Linux" in result["error"]


def test_cli_failure_surfaces_stderr_then_stdout(plugin, linux):
    tools = _mod(plugin, "tools")
    linux.result = linux.util.ExecResult(1, "", "herald-os: unknown theme 'nope'\n")
    result = json.loads(tools.system_os_handler({"action": "theme_set", "name": "nope"}))
    assert not result["success"] and result["error"] == "herald-os: unknown theme 'nope'"
    linux.result = linux.util.ExecResult(1, "nothing to update\n", "")
    result = json.loads(tools.system_os_handler({"action": "update"}))
    assert not result["success"] and result["error"] == "nothing to update"


def test_missing_cli_is_reported_as_unsupported(plugin, linux):
    tools = _mod(plugin, "tools")
    linux.result = linux.util.ExecResult(127, "", "herald-os: not found")
    result = json.loads(tools.system_os_handler({"action": "theme_list"}))
    assert not result["success"] and "not installed" in result["error"]


def test_output_is_truncated(plugin, linux):
    tools = _mod(plugin, "tools")
    linux.result = linux.util.ExecResult(0, "x" * 10_000, "")
    result = json.loads(tools.system_os_handler({"action": "theme_list"}))
    assert result["success"] and len(result["output"]) == 4000


def test_denied_action_does_not_run(plugin, linux, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.setattr(tools, "authorize", lambda *a, **k: linux.perm.Decision(False, "denied", "no"))
    result = json.loads(tools.system_os_handler({"action": "suspend"}))
    assert not result["success"] and result["decision"] == "denied"
    assert linux.argv is None
