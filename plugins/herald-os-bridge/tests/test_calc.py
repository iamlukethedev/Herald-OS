"""The ``calc`` tool: actions to calc.* commands, a read through the shell, the audit and the skill."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "calc.eval", "title": "Calculate", "tier": "read", "args": []},
    {"id": "calc.convert", "title": "Convert units or currencies", "tier": "read", "args": []},
    {"id": "calc.plot", "title": "Plot a graph", "tier": "act", "args": []},
    {"id": "calc.open", "title": "Open Herald Calc", "tier": "act", "args": []},
    {"id": "calc.history", "title": "Find a past calculation", "tier": "read", "args": []},
]

TIP = {
    "ok": True,
    "summary": "20% of 84.50 = 16.90",
    "spoken": "20% of 84.50 is 16.90",
    "data": {"input": "20% of 84.50", "display": "16.90", "value": "16.9", "kind": "number", "steps": ["20% of 84.50 = 0.2 × 84.50", "= 16.90"]},
}


@pytest.fixture
def shell(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    perm = _mod(plugin, "permissions")
    calls: list[tuple[str, dict, float]] = []
    decisions: list[tuple[str, str, str]] = []
    replies: dict[str, dict] = {"calc.eval": TIP}

    def run_command(command, args=None, *, source="agent", timeout=12.0):
        calls.append((command, args or {}, timeout))
        return replies.get(command) or {"ok": True, "summary": f"ran {command}", "data": {}}

    def authorize(tool, tier, action, summary, *, paths=()):
        decisions.append((tool, tier.value, action))
        return perm.Decision(True, "allowed")

    monkeypatch.setattr(ui, "run_command", run_command)
    monkeypatch.setattr(ui, "list_commands", lambda: CATALOGUE)
    monkeypatch.setattr(tools, "authorize", authorize)
    tools._UI_CATALOGUE.clear()
    yield calls, decisions, replies
    tools._UI_CATALOGUE.clear()


def test_the_schema_offers_one_choice_and_points_to_the_skill(plugin):
    tools = _mod(plugin, "tools")
    schema = tools.CALC_SCHEMA
    properties = schema["parameters"]["properties"]
    assert schema["name"] == "calc" and schema["parameters"]["required"] == ["action"]
    assert properties["action"]["enum"] == ["eval", "convert", "plot", "history"] == list(tools.CALC_ACTIONS)
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    assert set(tools.CALC_ARGS) == set(tools.CALC_ACTIONS)
    for action, names in tools.CALC_ARGS.items():
        for name in names:
            assert name in properties, f"{action} passes {name}, which the schema does not describe"
    assert properties["x_min"]["type"] == "number" and properties["x_max"]["type"] == "number" and properties["limit"]["type"] == "integer"
    description = schema["description"]
    assert 'skill_view name="herald-os-bridge:herald-calc"' in description
    for words in ("ANY arithmetic, percentage, unit, currency, date or time-zone math", "instead of working it out yourself", "steps", "European Central Bank", "which day's", "os_ui command=calc.plot", "calc.open", "read only", "split 3 ways", "9am Sydney in New York"):
        assert words in description, words


def test_actions_map_to_commands_and_drop_stray_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.calc_command({"action": "eval", "text": "20% of 84.50", "query": "x", "limit": 3}) == ("eval", "calc.eval", {"text": "20% of 84.50"})
    assert tools.calc_command({"action": " Convert ", "value": 5, "from": "km", "to": "mi", "text": ""}) == ("convert", "calc.convert", {"value": 5, "from": "km", "to": "mi"})
    assert tools.calc_command({"action": "convert", "value": "9am", "from": "New York", "to": "London"}) == ("convert", "calc.convert", {"value": "9am", "from": "New York", "to": "London"})
    assert tools.calc_command({"action": "history"}) == ("history", "calc.history", {})
    assert tools.calc_command({"action": "history", "query": "that mortgage thing", "text": "x"}) == ("history", "calc.history", {"query": "that mortgage thing"})


def test_a_plot_never_opens_a_window_and_takes_its_range_as_from_and_to(plugin):
    tools = _mod(plugin, "tools")
    assert tools.calc_command({"action": "plot", "expression": "sin(x) * x; x^2", "x_min": -5, "x_max": 5, "show": True}) == ("plot", "calc.plot", {"expression": "sin(x) * x; x^2", "from": -5, "to": 5, "show": False})
    assert tools.calc_command({"action": "plot", "workbook": "Budget.xlsx", "range": "B:B", "sheet": "", "x_min": None}) == ("plot", "calc.plot", {"workbook": "Budget.xlsx", "range": "B:B", "show": False})
    assert tools.calc_command({"action": "plot"}) == ("plot", "calc.plot", {"show": False})


def test_the_history_limit_is_kept_between_1_and_50(plugin):
    tools = _mod(plugin, "tools")
    limit = lambda value: tools.calc_command({"action": "history", "limit": value})[2]["limit"]  # noqa: E731
    assert [limit(500), limit("3"), limit(-2), limit("lots")] == [50, 3, 1, 10]


def test_an_unknown_action_is_refused_before_the_shell_is_asked(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    with pytest.raises(ValueError, match="eval, convert, plot, history"):
        tools.calc_command({"action": "solve"})
    reply = json.loads(tools.handle_calc({"action": "solve", "text": "2x = 4"}))
    assert reply["success"] is False and "eval, convert, plot, history" in reply["error"]
    assert calls == [] and decisions == []


def test_a_sum_is_read_in_the_shell_with_its_working(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_calc({"action": "eval", "text": "20% of 84.50"}))
    assert reply["success"] is True
    assert reply["result"] == "20% of 84.50 = 16.90" and reply["summary"] == "calc eval"
    assert reply["display"] == "16.90" and reply["value"] == "16.9" and reply["steps"] == ["20% of 84.50 = 0.2 × 84.50", "= 16.90"]
    assert "spoken" not in reply and "ok" not in reply
    assert calls == [("calc.eval", {"text": "20% of 84.50"}, tools.CALC_TIMEOUT)]
    assert decisions == [("calc", "read", "eval")]


def test_every_action_is_a_read_even_a_plot(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, replies = shell
    replies["calc.history"] = {"ok": True, "summary": "The best match: monthly payment = $2,104.11", "items": [{"input": "monthly payment", "result": "$2,104.11", "at": "2026-10-15T00:00:00.000Z", "source": "notes", "context": "Mortgage"}], "data": {"query": "mortgage", "count": 1}}
    replies["calc.plot"] = {"ok": True, "summary": "x^2 - 4, x from -10 to 10: …", "data": {"functions": [{"expression": "x^2 - 4", "zeros": [-2, 2]}], "series": [], "shown": False}}
    found = json.loads(tools.handle_calc({"action": "history", "query": "mortgage"}))
    assert found["items"][0]["result"] == "$2,104.11" and found["count"] == 1
    plotted = json.loads(tools.handle_calc({"action": "plot", "expression": "x^2 - 4"}))
    assert plotted["functions"][0]["zeros"] == [-2, 2] and plotted["shown"] is False
    json.loads(tools.handle_calc({"action": "convert", "value": "5", "from": "km", "to": "mi"}))
    assert [call[0] for call in calls] == ["calc.history", "calc.plot", "calc.convert"]
    assert calls[1][1]["show"] is False
    assert decisions == [("calc", "read", "history"), ("calc", "read", "plot"), ("calc", "read", "convert")]


def test_the_audit_log_records_a_read(plugin, monkeypatch, isolated_home):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "run_command", lambda command, args=None, **_: TIP)
    monkeypatch.setattr(ui, "list_commands", lambda: CATALOGUE)
    tools._UI_CATALOGUE.clear()
    try:
        reply = json.loads(tools.handle_calc({"action": "eval", "text": "20% of 84.50"}))
    finally:
        tools._UI_CATALOGUE.clear()
    assert reply["success"] is True
    entry = json.loads((isolated_home / "herald-os" / "audit.jsonl").read_text().strip().splitlines()[-1])
    assert (entry["tool"], entry["tier"], entry["action"], entry["decision"], entry["ok"]) == ("calc", "read", "eval", "allowed", True)


def test_the_engines_refusal_comes_back_as_its_words(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "run_command", lambda command, args=None, **_: {"ok": False, "summary": 'Herald Calc does not know "banana"', "error": 'Herald Calc does not know "banana"'})
    reply = json.loads(tools.handle_calc({"action": "eval", "text": "banana + 2"}))
    assert reply["success"] is False and reply["error"] == 'Herald Calc does not know "banana"'


def test_without_the_shell_the_tool_explains(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    monkeypatch.delenv("HERALD_OS_CONTROL_SOCKET", raising=False)
    monkeypatch.delenv("HERALD_OS_CONTROL_TOKEN", raising=False)
    tools._UI_CATALOGUE.clear()
    reply = json.loads(tools.handle_calc({"action": "eval", "text": "2 + 2"}))
    assert reply["success"] is False and "control socket" in reply["error"]


def test_an_older_shell_without_herald_calc_says_to_update(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    calls, _, _ = shell
    monkeypatch.setattr(ui, "list_commands", lambda: [{"id": "page.open", "tier": "read"}])
    tools._UI_CATALOGUE.clear()
    reply = json.loads(tools.handle_calc({"action": "eval", "text": "2 + 2"}))
    assert reply["success"] is False and "Herald Calc" in reply["error"] and "update Herald OS" in reply["error"]
    assert calls == []


def test_the_tool_and_its_skill_are_registered(plugin):
    tools = _mod(plugin, "tools")
    names = [spec.name for spec in tools.TOOL_SPECS]
    assert "calc" in names and dict((spec.name, spec.handler) for spec in tools.TOOL_SPECS)["calc"] is tools.handle_calc
    assert {"calc_command", "handle_calc"} <= set(tools.__all__)
    manifest = (Path(plugin.__file__).parent / "plugin.yaml").read_text()
    assert "  - calc\n" in manifest
    skill = Path(plugin.__file__).parent / "skills" / "herald-calc" / "SKILL.md"
    assert "herald-calc" in plugin.SKILLS and skill.read_text().startswith("---\nname: herald-calc\n")
