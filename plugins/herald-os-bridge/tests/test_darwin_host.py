"""The macOS adapter reports refused Apple Events and other osascript failures instead of success,
and force quit only ever signals this user's own app processes."""

from __future__ import annotations

import importlib
import json
import os
import signal
from pathlib import Path

import pytest

REFUSED = "execution error: Not authorized to send Apple events to {target}. (-1743)"
ME = os.getuid()
SOMEONE_ELSE = ME + 1
TEXTEDIT = "/System/Applications/TextEdit.app"
VSCODE = "/Applications/Visual Studio Code.app"


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


class FakeMac:
    """``run()`` and ``os.kill`` over a process table of pid -> (uid, executable). ``ps -U`` lists
    every row whatever its owner, so the adapter's own uid check is what keeps others' out."""

    def __init__(self, util, replies):
        self.util = util
        self.replies = replies
        self.calls: list[list[str]] = []
        self.signals: list[tuple[int, int]] = []
        self.procs: dict[int, tuple[int, str]] = {
            501: (ME, f"{TEXTEDIT}/Contents/MacOS/TextEdit"),
            502: (ME, f"{VSCODE}/Contents/MacOS/Electron"),
            503: (ME, f"{VSCODE}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"),
            88: (ME, "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow"),
        }
        self.ignores_term: set[int] = set()
        self.protected: set[int] = set()
        self.after_listing = lambda: None
        self.ps_fails: dict[str, tuple[int, str]] = {}
        # (checks that succeed, then the exit code and stderr of every later `ps -p`).
        self.ps_pid_fails_after: tuple[int, int, str] | None = None

    def __call__(self, argv, **_):
        self.calls.append(list(argv))
        if argv[0] == "ps":
            kind = "pid" if "-p" in argv else "user" if "-U" in argv else "all"
            if kind == "pid" and self.ps_pid_fails_after is not None:
                ok_checks, code, stderr = self.ps_pid_fails_after
                if len([call for call in self.calls if call[0] == "ps" and "-p" in call]) > ok_checks:
                    return self.util.ExecResult(code, "", stderr)
            if kind in self.ps_fails:
                return self.util.ExecResult(self.ps_fails[kind][0], "", self.ps_fails[kind][1])
            if kind == "all":
                return self.util.ExecResult(0, "".join(f"{pid} 1 me 0.0 0.1 1024 {comm}\n" for pid, (_, comm) in self.procs.items()), "")
            if "-p" in argv:
                pid = int(argv[argv.index("-p") + 1])
                rows = [(pid, *self.procs[pid])] if pid in self.procs else []
            else:
                rows = [(pid, *row) for pid, row in self.procs.items()]
                self.after_listing()
            return self.util.ExecResult(0 if rows else 1, "".join(f"{pid:>6} {uid:>5} {comm}\n" for pid, uid, comm in rows), "")
        reply = self.replies.get(argv[0], (0, "", ""))
        # A list answers successive calls in turn, its last entry from then on.
        if isinstance(reply, list):
            reply = reply.pop(0) if len(reply) > 1 else reply[0]
        code, stdout, stderr = reply
        return self.util.ExecResult(code, stdout, stderr)

    def kill(self, pid, sig):
        if pid not in self.procs:
            raise ProcessLookupError(pid)
        if pid in self.protected or self.procs[pid][0] != ME:
            raise PermissionError(pid)
        self.signals.append((pid, sig))
        if sig == signal.SIGKILL or pid not in self.ignores_term:
            del self.procs[pid]

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
    apps = [
        AppInfo(name="TextEdit", path=TEXTEDIT, bundle_id="com.apple.TextEdit"),
        AppInfo(name="Visual Studio Code", path=VSCODE, bundle_id="com.microsoft.VSCode"),
        AppInfo(name="Notes", path="/System/Applications/Notes.app", bundle_id="com.apple.Notes"),
        AppInfo(name="Safari", path="/Applications/Safari.app", bundle_id="com.apple.Safari"),
        AppInfo(name="Docker", path="/Applications/Docker.app", bundle_id="com.docker.docker"),
        AppInfo(name="Herald OS", path="/Applications/Herald OS.app", bundle_id="dev.iamluke.heraldos"),
    ]
    monkeypatch.setattr(adapter, "installed_apps", lambda: apps)
    clock = [0.0]
    monkeypatch.setattr(darwin.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(darwin.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))

    def fake(replies=None):
        machine = FakeMac(_mod(plugin, "util"), replies or {})
        monkeypatch.setattr(darwin, "run", machine)
        monkeypatch.setattr(darwin.os, "kill", machine.kill)
        return machine

    return darwin, tools, fake


def quit_app(tools, name, force=False):
    return json.loads(tools.handle_system_apps({"action": "quit", "name": name, "force": force}))


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
    machine = fake({"osascript": (1, "", REFUSED.format(target="TextEdit"))})
    result = quit_app(tools, "TextEdit")
    assert not result["success"]
    assert "turn on TextEdit under Herald OS" in result["error"]
    assert "Automation" in result["error"]
    assert machine.ran("osascript") == [["osascript", "-e", 'tell application "TextEdit" to quit']]


def test_quit_any_applescript_error_fails(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", "execution error: TextEdit got an error: User canceled. (-128)")})
    result = quit_app(tools, "TextEdit")
    assert not result["success"]
    assert "-128" in result["error"]


def test_quit_succeeds_when_osascript_does(mac):
    _, tools, fake = mac
    machine = fake()
    result = quit_app(tools, "TextEdit")
    assert result["success"], result
    assert result["app"] == "TextEdit"
    assert ["ps", "-o", "pid=,uid=,comm=", "-U", str(ME)] in machine.calls
    assert not machine.signals


def test_quit_an_app_that_is_not_running_says_so_without_asking_macos(mac):
    _, tools, fake = mac
    machine = fake()
    for force in (False, True):
        result = quit_app(tools, "Notes", force)
        assert not result["success"]
        assert result["error"] == "Notes is not running"
    assert not machine.ran("osascript") and not machine.signals


def test_force_quit_never_touches_another_users_copy_of_the_app(mac):
    _, tools, fake = mac
    machine = fake()
    machine.procs[601] = (SOMEONE_ELSE, f"{TEXTEDIT}/Contents/MacOS/TextEdit")
    machine.procs[602] = (0, f"{TEXTEDIT}/Contents/MacOS/TextEdit")
    result = quit_app(tools, "TextEdit", force=True)
    assert result["success"], result
    assert machine.signals == [(501, signal.SIGTERM)]
    assert 601 in machine.procs and 602 in machine.procs


def test_another_users_app_alone_is_not_running_for_us(mac):
    _, tools, fake = mac
    machine = fake()
    del machine.procs[501]
    machine.procs[601] = (SOMEONE_ELSE, f"{TEXTEDIT}/Contents/MacOS/TextEdit")
    for force in (False, True):
        assert quit_app(tools, "TextEdit", force)["error"] == "TextEdit is not running"
    assert not machine.signals and not machine.ran("osascript")


SESSION_NAMES = [
    "loginwindow", "com.apple.loginwindow", "WindowServer", "com.apple.WindowServer", "Dock", "com.apple.dock", "Dock.app",
    "SystemUIServer", "com.apple.systemuiserver", "ControlCenter", "Control Center", "com.apple.controlcenter",
    "NotificationCenter", "com.apple.notificationcenterui", "SecurityAgent", "com.apple.SecurityAgent",
    "System Events", "com.apple.systemevents",
]


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("name", SESSION_NAMES)
def test_session_processes_are_never_quit_by_name_or_bundle_id(mac, name, force):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    machine.procs[89] = (ME, "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock")
    result = quit_app(tools, name, force)
    assert not result["success"]
    assert result["error"] == f"{name} is part of macOS and is never quit by Herald OS"
    assert 88 in machine.procs and 89 in machine.procs
    assert not machine.signals and not machine.ran("osascript") and not machine.ran("ps")


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("name", ["Herald OS", "herald os", "Herald OS.app", "dev.iamluke.heraldos"])
def test_herald_os_never_quits_itself(mac, name, force):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    machine.procs[900] = (ME, "/Applications/Herald OS.app/Contents/MacOS/Herald OS")
    result = quit_app(tools, name, force)
    assert result["error"] == "Herald OS does not quit itself"
    assert 900 in machine.procs and not machine.signals and not machine.ran("osascript")


def test_a_partial_match_that_lands_on_herald_os_is_refused(mac):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "not running\n", "")})
    machine.procs[900] = (ME, "/Applications/Herald OS.app/Contents/MacOS/Herald OS")
    assert quit_app(tools, "Herald")["error"] == "Herald OS does not quit itself"
    assert machine.ran("osascript") == [by_name("Herald")]
    assert 900 in machine.procs


@pytest.mark.parametrize("force", [False, True])
def test_dock_never_reaches_docker(mac, force):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    machine.procs[950] = (ME, "/Applications/Docker.app/Contents/MacOS/Docker")
    assert quit_app(tools, "Dock", force)["error"] == "Dock is part of macOS and is never quit by Herald OS"
    assert 950 in machine.procs and not machine.signals and not machine.ran("osascript")


def test_docker_by_its_own_name_still_quits(mac):
    _, tools, fake = mac
    machine = fake()
    machine.procs[950] = (ME, "/Applications/Docker.app/Contents/MacOS/Docker")
    assert quit_app(tools, "Docker")["success"]
    assert machine.ran("osascript") == [["osascript", "-e", 'tell application "Docker" to quit']]


def test_polite_quit_tries_an_open_app_by_exact_name_before_a_partial_match(mac):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    assert quit_app(tools, "Text")["success"]
    assert machine.ran("osascript") == [by_name("Text")]
    assert not machine.ran("ps") and 501 in machine.procs


def test_polite_quit_falls_back_to_a_partial_match_only_when_nothing_is_open_by_that_name(mac):
    _, tools, fake = mac
    machine = fake({"osascript": [(0, "not running\n", ""), (0, "", "")]})
    assert quit_app(tools, "Code")["success"]
    assert machine.ran("osascript") == [by_name("Code"), ["osascript", "-e", 'tell application "Visual Studio Code" to quit']]


def test_polite_quit_says_not_running_when_neither_finds_an_app(mac):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "not running\n", "")})
    assert quit_app(tools, "Nothing Like This")["error"] == "Nothing Like This is not running"
    assert machine.ran("osascript") == [by_name("Nothing Like This")]


def by_name(label):
    return ["osascript", "-e", f'if application "{label}" is running then\ntell application "{label}" to quit\nreturn "quit"\nend if\nreturn "not running"']


@pytest.mark.parametrize("name", ["Finder", "Downloaded Tool"])
def test_polite_quit_of_an_app_outside_the_applications_folders_goes_through_applescript(mac, name):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    result = quit_app(tools, name)
    assert result["success"], result
    assert machine.ran("osascript") == [by_name(name)]
    assert not machine.ran("ps") and not machine.signals


def test_polite_quit_by_name_reports_an_app_that_is_not_open(mac):
    _, tools, fake = mac
    fake({"osascript": (0, "not running\n", "")})
    assert quit_app(tools, "Finder")["error"] == "Finder is not running"


def test_polite_quit_by_name_names_the_automation_switch(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", REFUSED.format(target="Finder"))})
    error = quit_app(tools, "Finder")["error"]
    assert "turn on Finder under Herald OS" in error and "Automation" in error


def test_polite_quit_by_name_reports_other_applescript_errors(mac):
    _, tools, fake = mac
    fake({"osascript": (1, "", "execution error: Finder got an error: User canceled. (-128)")})
    assert "-128" in quit_app(tools, "Finder")["error"]


def test_force_quit_keeps_the_strict_rules_outside_the_applications_folders(mac):
    _, tools, fake = mac
    machine = fake({"osascript": (0, "quit\n", "")})
    machine.procs[90] = (ME, "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder")
    result = quit_app(tools, "Finder", force=True)
    assert not result["success"]
    assert "exact name or bundle id" in result["error"]
    assert not machine.signals and not machine.ran("osascript")


def test_force_quit_needs_the_exact_name_or_bundle_id(mac):
    _, tools, fake = mac
    machine = fake()
    result = quit_app(tools, "Code", force=True)
    assert not result["success"]
    assert "exact name or bundle id" in result["error"]
    assert not machine.signals
    assert quit_app(tools, "com.microsoft.VSCode", force=True)["success"]
    assert machine.signals == [(502, signal.SIGTERM)]
    assert 503 in machine.procs


def test_force_quit_sends_term_then_kill_after_the_grace_period(mac):
    darwin, tools, fake = mac
    machine = fake()
    machine.ignores_term.add(502)
    assert quit_app(tools, "Visual Studio Code", force=True)["success"]
    assert machine.signals == [(502, signal.SIGTERM), (502, signal.SIGKILL)]
    assert darwin.time.monotonic() >= darwin.FORCE_QUIT_GRACE


def test_force_quit_skips_a_pid_reused_before_the_signal(mac):
    _, tools, fake = mac
    machine = fake()
    machine.after_listing = lambda: machine.procs.__setitem__(502, (ME, "/usr/bin/caffeinate"))
    assert quit_app(tools, "Visual Studio Code", force=True)["success"]
    assert not machine.signals
    assert 502 in machine.procs


def test_force_quit_reports_a_process_macos_will_not_let_it_stop(mac):
    _, tools, fake = mac
    machine = fake()
    machine.protected.add(501)
    result = quit_app(tools, "TextEdit", force=True)
    assert not result["success"]
    assert result["error"] == "macOS did not let Herald OS stop TextEdit (process 501)"


def test_bundle_executables_only_inside_applications_folders(mac):
    darwin, _, _ = mac
    cryptex = lambda name: tuple(f"{root}/{name}/Contents/MacOS/" for root in darwin.CRYPTEX_APP_ROOTS)  # noqa: E731
    assert darwin.bundle_executables("/Applications/Safari.app") == ("/Applications/Safari.app/Contents/MacOS/", *cryptex("Safari.app"))
    assert darwin.bundle_executables("/System/Applications/Notes.app/") == ("/System/Applications/Notes.app/Contents/MacOS/", *cryptex("Notes.app"))
    # Only top-level apps have a cryptex copy; nothing in a subfolder or the home folder does.
    assert darwin.bundle_executables("/System/Applications/Utilities/Terminal.app") == ("/System/Applications/Utilities/Terminal.app/Contents/MacOS/",)
    assert darwin.bundle_executables(str(Path.home() / "Applications" / "Safari.app")) == (f"{Path.home()}/Applications/Safari.app/Contents/MacOS/",)
    for outside in ("/tmp/Evil.app", "/Applications/../tmp/Evil.app", "/Applications", "/Applications/notes.txt", "/System/Cryptexes/App/System/Applications/Safari.app", ""):
        assert darwin.bundle_executables(outside) == ()


@pytest.mark.parametrize("root", ["/System/Cryptexes/App/System/Applications", "/System/Volumes/Preboot/Cryptexes/App/System/Applications"])
def test_safari_running_from_the_system_cryptex_is_found(mac, root):
    _, tools, fake = mac
    machine = fake()
    machine.procs[700] = (ME, f"{root}/Safari.app/Contents/MacOS/Safari")
    machine.procs[701] = (SOMEONE_ELSE, f"{root}/Safari.app/Contents/MacOS/Safari")
    machine.procs[702] = (ME, f"{root}/Safari.app/Contents/XPCServices/com.apple.Safari.SandboxBroker.xpc/Contents/MacOS/com.apple.Safari.SandboxBroker")
    assert quit_app(tools, "Safari")["success"]
    assert machine.ran("osascript") == [["osascript", "-e", 'tell application "Safari" to quit']]
    assert quit_app(tools, "Safari", force=True)["success"]
    assert machine.signals == [(700, signal.SIGTERM)]
    assert 701 in machine.procs and 702 in machine.procs


def test_a_failing_ps_is_an_error_not_not_running(mac):
    _, tools, fake = mac
    for code, stderr in ((124, "timed out after 10s"), (127, "ps: not found (No such file)"), (1, "ps: illegal option")):
        machine = fake()
        machine.ps_fails["user"] = (code, stderr)
        for force in (False, True):
            result = quit_app(tools, "TextEdit", force)
            assert not result["success"]
            assert "not running" not in result["error"]
            assert result["error"] == f"could not read the process list (ps: {stderr})"
        assert not machine.signals and not machine.ran("osascript")


def test_ps_failing_before_a_signal_stops_the_force_quit(mac):
    _, tools, fake = mac
    machine = fake()
    machine.ps_fails["pid"] = (124, "timed out after 10s")
    result = quit_app(tools, "TextEdit", force=True)
    assert not result["success"]
    assert result["error"] == "could not read the process list (ps: timed out after 10s)"
    assert not machine.signals


def test_ps_failing_partway_names_the_signals_already_sent(mac):
    _, tools, fake = mac
    machine = fake()
    machine.procs[504] = (ME, f"{TEXTEDIT}/Contents/MacOS/TextEdit")
    machine.ps_pid_fails_after = (1, 124, "timed out after 10s")
    result = quit_app(tools, "TextEdit", force=True)
    assert not result["success"]
    assert result["error"] == "could not read the process list (ps: timed out after 10s) while force quitting TextEdit, after sending TERM to process 501"
    assert machine.signals == [(501, signal.SIGTERM)]
    assert 504 in machine.procs


def test_ps_failing_while_waiting_for_term_names_it_and_sends_no_kill(mac):
    _, tools, fake = mac
    machine = fake()
    machine.ignores_term.add(502)
    machine.ps_pid_fails_after = (1, 1, "ps: sysctl: Operation not permitted")
    result = quit_app(tools, "Visual Studio Code", force=True)
    assert not result["success"]
    assert result["error"] == "could not read the process list (ps: ps: sysctl: Operation not permitted) while force quitting Visual Studio Code, after sending TERM to process 502"
    assert machine.signals == [(502, signal.SIGTERM)]


def test_process_lists_report_a_failing_ps(mac):
    _, tools, fake = mac
    machine = fake()
    machine.ps_fails["all"] = (124, "timed out after 15.0s")
    result = json.loads(tools.handle_system_processes({"action": "top"}))
    assert not result["success"]
    assert "could not read the process list" in result["error"]


def test_parse_pid_uid_comm_keeps_spaces_in_paths(mac):
    darwin, _, _ = mac
    assert darwin.parse_pid_uid_comm(f"  502   501 {VSCODE}/Contents/MacOS/Electron\n\njunk\n") == [(502, 501, f"{VSCODE}/Contents/MacOS/Electron")]


def test_notify_reports_a_failed_osascript(mac):
    _, tools, fake = mac
    machine = fake({"osascript": (1, "", "execution error: Notifications are not allowed. (-1)")})
    result = json.loads(tools.handle_system_control({"action": "notify", "title": "Build", "body": "done"}))
    assert not result["success"]
    assert "Notifications are not allowed" in result["error"]
    assert machine.ran("osascript")[0][:2] == ["osascript", "-e"]


def test_notify_succeeds_when_osascript_does(mac):
    _, tools, fake = mac
    fake()
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


@pytest.mark.parametrize(
    ("pane", "anchor"),
    [("microphone", "Privacy_Microphone"), ("camera", "Privacy_Camera"), ("calendars", "Privacy_Calendars"), ("Calendar", "Privacy_Calendars")],
)
def test_open_settings_reaches_the_permission_lists_herald_asks_for(mac, pane, anchor):
    _, tools, fake = mac
    machine = fake()
    result = json.loads(tools.handle_system_open({"target": "settings", "pane": pane}))
    assert result["success"], result
    assert machine.ran("open") == [["open", f"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{anchor}"]]
