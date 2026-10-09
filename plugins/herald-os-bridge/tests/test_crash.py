"""Crash reports for the diagnose-crash skill: the .ips summary, report paths and coredumpctl rows."""

from __future__ import annotations

import importlib
import json

import pytest


def _crash(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.crash")


HEADER = {"app_name": "Safari", "name": "Safari", "bug_type": "309", "app_version": "26.0", "bundleID": "com.apple.Safari", "os_version": "macOS 26.0 (25A354)", "timestamp": "2026-10-06 14:22:05.00 +1100"}
BODY = {
    "pid": 4242,
    "procName": "Safari",
    "procPath": "/Applications/Safari.app/Contents/MacOS/Safari",
    "parentProc": "launchd",
    "exception": {"type": "EXC_BAD_ACCESS", "signal": "SIGSEGV", "subtype": "KERN_INVALID_ADDRESS at 0x0", "codes": "0x1, 0x0"},
    "termination": {"namespace": "SIGNAL", "code": 11, "indicator": "Segmentation fault: 11", "flags": 0},
    "asi": {"libsystem_c.dylib": ["abort() called"]},
    "faultingThread": 1,
    "threads": [
        {"frames": [{"imageIndex": 0, "symbol": "idle"}]},
        {"triggered": True, "queue": "com.apple.main-thread", "frames": [{"imageIndex": 1, "symbol": "objc_msgSend", "symbolLocation": 32}, {"imageIndex": 2, "imageOffset": 4096}]},
    ],
    "usedImages": [{"name": "libsystem_kernel.dylib"}, {"name": "libobjc.A.dylib"}, {"path": "/Library/Extensions/Blocker.appex/Blocker"}],
}


def _ips(header=HEADER, body=BODY) -> str:
    return json.dumps(header) + "\n" + json.dumps(body, indent=2)


def test_summarise_ips_keeps_the_facts_and_the_crashed_thread(plugin):
    summary = _crash(plugin).summarise_ips(_ips())
    assert summary["app"] == "Safari" and summary["version"] == "26.0" and summary["is_crash"]
    assert summary["exception"] == {"type": "EXC_BAD_ACCESS", "signal": "SIGSEGV", "subtype": "KERN_INVALID_ADDRESS at 0x0", "codes": "0x1, 0x0"}
    assert summary["termination"] == {"namespace": "SIGNAL", "code": 11, "indicator": "Segmentation fault: 11"}
    assert summary["app_messages"] == ["abort() called"]
    assert summary["crashed_thread"] == {"index": 1, "queue": "com.apple.main-thread", "frames": ["libobjc.A.dylib  objc_msgSend + 32", "Blocker  offset 4096"]}


def test_summarise_ips_survives_a_header_only_report(plugin):
    summary = _crash(plugin).summarise_ips(json.dumps({**HEADER, "bug_type": "288"}))
    assert summary["app"] == "Safari" and not summary["is_crash"]
    assert summary["crashed_thread"]["frames"] == []
    with pytest.raises(ValueError):
        _crash(plugin).summarise_ips("not a report")


def test_resolve_mac_report_stays_inside_the_report_folders(plugin, tmp_path):
    crash = _crash(plugin)
    reports = tmp_path / "DiagnosticReports"
    reports.mkdir()
    (reports / "Safari.ips").write_text(_ips())
    (tmp_path / "secret.txt").write_text("no")
    assert crash.resolve_mac_report("Safari.ips", (reports,)) == (reports / "Safari.ips").resolve()
    assert crash.resolve_mac_report(str(reports / "Safari.ips"), (reports,)) == (reports / "Safari.ips").resolve()
    with pytest.raises(ValueError, match="not a crash report"):
        crash.resolve_mac_report(str(tmp_path / "secret.txt"), (reports,))
    with pytest.raises(ValueError, match="not a crash report"):
        crash.resolve_mac_report(str(reports / ".." / "secret.txt"), (reports,))
    with pytest.raises(ValueError, match="no crash report"):
        crash.resolve_mac_report("Missing.ips", (reports,))


def test_parse_coredumpctl_list_names_signals_newest_first(plugin):
    rows = _crash(plugin).parse_coredumpctl_list(json.dumps([
        {"time": 1791000000000000, "pid": 10, "sig": 6, "exe": "/usr/bin/old", "corefile": "missing"},
        {"time": 1791100000000000, "pid": 11, "sig": 11, "exe": "/usr/lib64/firefox/firefox", "corefile": "present"},
    ]))
    assert [r["pid"] for r in rows] == [11, 10]
    assert rows[0]["app"] == "firefox" and rows[0]["signal"] == "SIGSEGV" and rows[0]["core"] == "present"
    assert rows[1]["signal"] == "SIGABRT"
    assert _crash(plugin).parse_coredumpctl_list("No coredumps found.") == []


def test_crash_report_needs_a_report(plugin):
    tools = importlib.import_module(plugin.__name__ + ".bridge.tools")
    result = json.loads(tools.handle_system_logs({"action": "crash_report"}))
    assert not result["success"] and "report is required" in result["error"]
    assert not json.loads(tools.handle_system_logs({"action": "nope"}))["success"]


def test_register_adds_every_skill(plugin):
    registered: dict[str, object] = {}

    class Ctx:
        def register_tool(self, **_):
            pass

        def register_skill(self, name, path, description=""):
            registered[name] = path

    plugin.register(Ctx())
    assert set(registered) == {"herald-os", "diagnose-crash", "herald-os-tailor", "file-documents", "herald-canvas", "herald-docs", "herald-sheets", "herald-slides"}
    assert all(path.exists() for path in registered.values())


def test_tool_descriptions_point_to_the_skills(plugin):
    # Plugin skills are not in the system prompt's skill index; the always-visible tool
    # descriptions are how Hermes finds them.
    tools = importlib.import_module(plugin.__name__ + ".bridge.tools")
    os_ui = tools.OS_UI_SCHEMA["description"]
    assert 'skill_view name="herald-os-bridge:herald-os-tailor"' in os_ui and "widget" in os_ui
    assert 'skill_view name="herald-os-bridge:herald-os"' in os_ui
    assert 'skill_view name="herald-os-bridge:diagnose-crash"' in tools.SYSTEM_LOGS_SCHEMA["description"]
    assert 'skill_view name="herald-os-bridge:file-documents"' in tools.SYSTEM_DOCUMENTS_SCHEMA["description"]
    assert "widgets" in plugin.SKILLS["herald-os-tailor"]
