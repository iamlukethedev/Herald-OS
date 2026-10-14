"""The macOS adapter reports refused Apple Events and other osascript failures instead of success."""

from __future__ import annotations

import importlib
import json

import pytest

REFUSED = "execution error: Not authorized to send Apple events to {target}. (-1743)"
TEXTEDIT = "/System/Applications/TextEdit.app"
PS = (
    f"  501   1 sam 0.0 0.1 20480 {TEXTEDIT}/Contents/MacOS/TextEdit\n"
    "  502   1 sam 0.0 0.1 20480 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n"
    "  503 502 sam 0.0 0.1 20480 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper\n"
)


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


class FakeRun:
    """Answers by command name; records every argv."""

    def __init__(self, util, replies):
        self.util = util
        self.replies = replies
        self.calls: list[list[str]] = []

    def __call__(self, argv, **_):
        self.calls.append(list(argv))
        code, stdout, stderr = self.replies.get(argv[0], (0, "", ""))
        return self.util.ExecResult(code, stdout, stderr)

    def ran(self, command):
        return [call for call in self.calls if call[0] == command]


@pytest.fixture
def mac(plugin, monkeypatch):
    darwin = _mod(plugin, "host.darwin")
    tools = _mod(plugin, "tools")
    perm = _mod(plugin, "permissions")
    adapter = darwin.DarwinHost()
    monkeypatch.setattr(tools, "host", lambda: adapter)
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: perm.Decision(True, "approved"))
    AppInfo = _mod(plugin, "host.base").AppInfo
    apps = [AppInfo(name="TextEdit", path=TEXTEDIT), AppInfo(name="Visual Studio Code", path="/Applications/Visual Studio Code.app"), AppInfo(name="Notes", path="/System/Applications/Notes.app")]
    monkeypatch.setattr(adapter, "installed_apps", lambda: apps)

    def fake(replies):
        runner = FakeRun(_mod(plugin, "util"), {"ps": (0, PS, ""), **replies})
        monkeypatch.setattr(darwin, "run", runner)
        return runner

    return darwin, tools, fake


def test_apple_events_refused_matches_the_osascript_messages(mac):
    darwin, _, _ = mac
    assert darwin.apple_events_refused(REFUSED.format(target="System Events"))
    assert darwin.apple_events_refused("execution error: Not allowed to send Apple events to “Finder”.")
    assert darwin.apple_events_refused("27:40: execution error: (-1744)")
    assert not darwin.apple_events_refused("execution error: TextEdit got an error: User canceled. (-128)")
    assert not darwin.apple_events_refused("")


def test_running_apps_reports_the_automation_switch_instead_of_no_apps(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", REFUSED.format(target="System Events"))})
    result = json.loads(tools.handle_system_apps({"action": "running"}))
    assert not result["success"]
    assert "apps" not in result
    assert "System Events" in result["error"]
    assert "Privacy & Security > Automation" in result["error"]


def test_running_apps_other_failures_are_errors_too(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", "execution error: System Events got an error: Connection is invalid. (-609)")})
    result = json.loads(tools.handle_system_apps({"action": "running"}))
    assert not result["success"]
    assert "-609" in result["error"]


def test_running_apps_still_lists_apps_when_allowed(mac):
    _, tools, fake = mac
    fake({"osascript": (0, "Finder, TextEdit, 101, 501\n", "")})
    result = json.loads(tools.handle_system_apps({"action": "running"}))
    assert result["success"]
    assert [(a["name"], a["pid"]) for a in result["apps"]] == [("Finder", 101), ("TextEdit", 501)]


def test_quit_refused_is_not_reported_as_quit(mac):
    _, tools, fake = mac
    runner = fake({"osascript": (1, "", REFUSED.format(target="TextEdit"))})
    result = json.loads(tools.handle_system_apps({"action": "quit", "name": "TextEdit"}))
    assert not result["success"]
    assert "turn on TextEdit under Herald OS" in result["error"]
    assert "Automation" in result["error"]
    assert runner.ran("osascript") == [["osascript", "-e", 'tell application "TextEdit" to quit']]


def test_quit_any_applescript_error_fails(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", "execution error: TextEdit got an error: User canceled. (-128)")})
    result = json.loads(tools.handle_system_apps({"action": "quit", "name": "TextEdit"}))
    assert not result["success"]
    assert "-128" in result["error"]


def test_quit_succeeds_when_osascript_does(mac):
    _, tools, fake = mac
    fake({})
    result = json.loads(tools.handle_system_apps({"action": "quit", "name": "TextEdit"}))
    assert result["success"], result
    assert result["app"] == "TextEdit"


def test_quit_an_app_that_is_not_running_says_so_without_asking_macos(mac):
    _, tools, fake = mac
    runner = fake({})
    for force in (False, True):
        result = json.loads(tools.handle_system_apps({"action": "quit", "name": "Notes", "force": force}))
        assert not result["success"]
        assert result["error"] == "Notes is not running"
    assert not runner.ran("osascript") and not runner.ran("pkill")


def test_force_quit_kills_the_bundle_executable_only(mac, monkeypatch):
    darwin, tools, fake = mac
    fake({})
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(darwin.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    result = json.loads(tools.handle_system_apps({"action": "quit", "name": "Visual Studio Code", "force": True}))
    assert result["success"], result
    assert killed == [(502, darwin.signal.SIGKILL)]


def test_notify_reports_a_failed_osascript(mac):
    _, tools, fake = mac
    runner = fake({"osascript": (1, "", "execution error: Notifications are not allowed. (-1)")})
    result = json.loads(tools.handle_system_control({"action": "notify", "title": "Build", "body": "done"}))
    assert not result["success"]
    assert "Notifications are not allowed" in result["error"]
    assert runner.ran("osascript")[0][:2] == ["osascript", "-e"]


def test_notify_succeeds_when_osascript_does(mac):
    _, tools, fake = mac
    fake({})
    result = json.loads(tools.handle_system_control({"action": "notify", "title": "Build", "body": "done"}))
    assert result["success"] and result["notified"]


def test_dark_mode_and_trash_name_the_automation_switch(mac, tmp_path):
    darwin, _, fake = mac
    fake({"osascript": (1, "", REFUSED.format(target="System Events"))})
    with pytest.raises(RuntimeError, match="control System Events.*Automation"):
        darwin.DarwinHost().set_dark_mode(True)
    fake({"osascript": (1, "", REFUSED.format(target="Finder"))})
    with pytest.raises(RuntimeError, match="control Finder.*Automation"):
        darwin.DarwinHost().trash([tmp_path / "old.txt"])
