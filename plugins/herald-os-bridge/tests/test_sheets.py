"""The ``sheets`` tool: actions to sheets.* commands, the tier rules, and a call through the shell."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "office.list", "title": "What is open in Herald Office", "tier": "read", "args": []},
    {"id": "sheets.read", "title": "Read a workbook", "tier": "read", "args": []},
    {"id": "sheets.write", "title": "Write cells", "tier": "act", "args": []},
    {"id": "sheets.clean", "title": "Clean data", "tier": "act", "args": []},
    {"id": "sheets.removeSheet", "title": "Remove a sheet", "tier": "mutate", "args": []},
    {"id": "sheets.edit", "title": "Make several edits in a workbook at once", "tier": "act", "args": []},
    {"id": "sheets.save", "title": "Save a workbook", "tier": "mutate", "args": []},
    {"id": "sheets.exportPdf", "title": "Export a workbook as a PDF", "tier": "act", "args": []},
]


@pytest.fixture
def shell(plugin, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    perm = _mod(plugin, "permissions")
    calls: list[tuple[str, dict, float]] = []
    decisions: list[tuple[str, str, str]] = []
    open_paths: list[str] = []

    def run_command(command, args=None, *, source="agent", timeout=12.0):
        calls.append((command, args or {}, timeout))
        if command == "office.list":
            documents = [{"app": "sheets", "name": Path(path).name, "path": path, "format": "xlsx", "modified": False, "active": True, "front": True} for path in open_paths]
            return {"ok": True, "summary": "Office: in front is Budget.xlsx", "data": {"documents": documents}}
        if command == "sheets.read":
            return {"ok": True, "summary": "Budget.xlsx: Sheet1 (3×2); read Sheet1!A1:B3", "data": {"name": "Budget.xlsx", "range": "A1:B3", "values": [["Item", "Cost"], ["Rent", 1200], ["Total", 1200]]}}
        return {"ok": True, "summary": f"ran {command}", "data": {}}

    def authorize(tool, tier, action, summary, *, paths=()):
        decisions.append((tool, tier.value, action))
        return perm.Decision(True, "allowed")

    monkeypatch.setattr(ui, "run_command", run_command)
    monkeypatch.setattr(ui, "list_commands", lambda: CATALOGUE)
    monkeypatch.setattr(tools, "authorize", authorize)
    tools._UI_CATALOGUE.clear()
    yield calls, decisions, open_paths
    tools._UI_CATALOGUE.clear()


def test_actions_map_to_commands_and_drop_stray_arguments(plugin):
    tools = _mod(plugin, "tools")
    action, command, args = tools.sheets_command({"action": "fill", "range": "D2:D20", "formula": "=B2*C2", "workbook": "Budget.xlsx", "values": "", "by": "C", "sheet": None})
    assert (action, command) == ("fill", "sheets.fill")
    assert args == {"workbook": "Budget.xlsx", "range": "D2:D20", "formula": "=B2*C2"}
    assert tools.sheets_command({"action": "list_all", "workbook": "Budget.xlsx"}) == ("list_all", "office.list", {})
    assert tools.sheets_command({"action": "list"}) == ("list", "sheets.list", {})
    assert all(command.startswith("sheets.") for action, command in tools.SHEETS_ACTIONS.items() if action != "list_all")
    with pytest.raises(ValueError, match="remove_sheet"):
        tools.sheets_command({"action": "chart"})


def test_sheet_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.sheets_command({"action": "read", "range": "selection", "formulas": False, "text": "x"}) == ("read", "sheets.read", {"range": "selection", "formulas": False})
    assert tools.sheets_command({"action": "find", "text": "Rent", "wholeCell": True, "sheet": "2025"}) == ("find", "sheets.find", {"text": "Rent", "sheet": "2025", "wholeCell": True})
    assert tools.sheets_command({"action": "sort", "range": "A1:D40", "by": "Cost", "ascending": False, "header": True}) == ("sort", "sheets.sort", {"range": "A1:D40", "by": "Cost", "ascending": False, "header": True})
    assert tools.sheets_command({"action": "freeze", "rows": 1, "columns": 0, "range": "A1"}) == ("freeze", "sheets.freeze", {"rows": 1, "columns": 0})
    assert tools.sheets_command({"action": "add_sheet", "name": "Q2", "index": 1}) == ("add_sheet", "sheets.addSheet", {"name": "Q2", "index": 1})
    assert tools.sheets_command({"action": "rename_sheet", "sheet": "Sheet1", "name": "Budget"}) == ("rename_sheet", "sheets.renameSheet", {"sheet": "Sheet1", "name": "Budget"})
    assert tools.sheets_command({"action": "remove_sheet", "sheet": "Old", "name": "x"}) == ("remove_sheet", "sheets.removeSheet", {"sheet": "Old"})
    assert tools.sheets_command({"action": "replace", "find": "N/A", "replacement": "", "range": "B2:B90", "all": False}) == ("replace", "sheets.replace", {"find": "N/A", "range": "B2:B90", "all": False})
    assert tools.sheets_command({"action": "save", "to": "~/Documents/Budget.csv", "overwrite": True, "range": "A1"}) == ("save", "sheets.save", {"to": "~/Documents/Budget.csv", "overwrite": True})
    assert tools.sheets_command({"action": "redo", "steps": 2}) == ("redo", "sheets.redo", {"steps": 2})


def test_clean_takes_its_own_action_as_clean(plugin):
    tools = _mod(plugin, "tools")
    _, command, args = tools.sheets_command({"action": "clean", "range": "A1:D50", "clean": "dedupe", "by": "A,B", "header": True})
    assert (command, args) == ("sheets.clean", {"range": "A1:D50", "header": True, "by": "A,B", "action": "dedupe"})
    _, _, args = tools.sheets_command({"action": "clean", "range": "C2:C90", "clean": "dates", "order": "dmy", "dateFormat": "dd/mm/yyyy"})
    assert args == {"range": "C2:C90", "dateFormat": "dd/mm/yyyy", "order": "dmy", "action": "dates"}
    _, _, args = tools.sheets_command({"action": "clean", "range": "A2:A40", "clean": "split", "delimiter": "space", "overwrite": True})
    assert args == {"range": "A2:A40", "delimiter": "space", "overwrite": True, "action": "split"}
    properties = tools.SHEETS_SCHEMA["parameters"]["properties"]
    assert "clean" in properties and "dedupe" in properties["clean"]["description"]


def test_rows_formats_conditions_and_edits_travel_as_json(plugin):
    tools = _mod(plugin, "tools")
    rows = [["Item", "Cost"], ["Rent", 1200], ["Total", "=SUM(B2:B2)"]]
    _, command, args = tools.sheets_command({"action": "write", "range": "A1", "values": rows})
    assert command == "sheets.write" and json.loads(args["values"]) == rows
    _, command, args = tools.sheets_command({"action": "new", "name": "Trip budget", "values": rows, "template": ""})
    assert command == "sheets.new" and json.loads(args.pop("values")) == rows and args == {"name": "Trip budget"}
    _, command, args = tools.sheets_command({"action": "format", "range": "B2:B9", "format": {"numberFormat": "$#,##0.00", "bold": True}})
    assert command == "sheets.format" and json.loads(args["format"]) == {"numberFormat": "$#,##0.00", "bold": True}
    edits = [{"op": "write", "range": "A1", "values": [["Month", "Sales"]]}, {"op": "freeze", "rows": 1}]
    _, command, args = tools.sheets_command({"action": "edit", "workbook": "~/Budget.xlsx", "edits": edits})
    assert command == "sheets.edit" and json.loads(args["edits"]) == edits and args["workbook"] == "~/Budget.xlsx"
    # One value, or rows the model wrote as JSON text, pass through as they are.
    assert tools.sheets_command({"action": "write", "range": "C2:C9", "values": "0"})[2] == {"range": "C2:C9", "values": "0"}
    assert tools.sheets_command({"action": "write", "range": "A1", "values": '[["a"]]'})[2] == {"range": "A1", "values": '[["a"]]'}


def test_a_filter_keeps_a_flat_list_or_a_condition(plugin):
    tools = _mod(plugin, "tools")
    for values in ([["Paid", "Due"]], [["Paid"], ["Due"]], ["Paid", "Due"]):
        _, command, args = tools.sheets_command({"action": "filter", "range": "A1:D40", "by": "Status", "values": values})
        assert command == "sheets.filter" and json.loads(args["values"]) == ["Paid", "Due"]
    _, _, args = tools.sheets_command({"action": "filter", "range": "A1:D40", "by": "Cost", "condition": {"operator": "greaterThan", "value": 100}})
    assert json.loads(args.pop("condition")) == {"operator": "greaterThan", "value": 100}
    assert args == {"range": "A1:D40", "by": "Cost"}
    assert tools.sheets_command({"action": "filter", "clear": True}) == ("filter", "sheets.filter", {"clear": True})


def test_the_schema_offers_every_action_and_argument(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.SHEETS_SCHEMA["parameters"]["properties"]
    assert set(tools.SHEETS_ARGS) == set(tools.SHEETS_ACTIONS)
    assert properties["action"]["enum"] == list(tools.SHEETS_ACTIONS)
    for action, names in tools.SHEETS_ARGS.items():
        for name in names:
            assert name in properties, f"{action} passes {name}, which the schema does not describe"
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    assert properties["values"]["type"] == "array" and properties["values"]["items"]["type"] == "array"
    assert properties["format"]["type"] == "object" and properties["condition"]["type"] == "object"
    assert properties["edits"]["type"] == "array" and properties["edits"]["items"]["type"] == "object"
    assert properties["formulas"]["type"] == "boolean" and properties["rows"]["type"] == "number"


def test_the_description_teaches_the_workflow_and_points_to_the_skill(plugin):
    tools = _mod(plugin, "tools")
    description = tools.SHEETS_SCHEMA["description"]
    assert 'skill_view name="herald-os-bridge:herald-sheets"' in description
    for words in ("Read before you change anything", "list_all", "range=selection", "text starting with = is a formula", "action=edit", "one step the person can undo", "Never save unless the person asks", "insert_range", "CSV"):
        assert words in description


def test_saving_exporting_and_closed_files_raise_the_tier(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")

    def tier(action, command, args, open_paths=()):
        return tools.office_tier(action, command, args, catalogue, open_paths).value

    assert tier("save", "sheets.save", {}) == "destructive"
    assert tier("save", "sheets.save", {"to": str(budget)}) == "destructive"
    assert tier("save", "sheets.save", {"to": str(tmp_path / "Budget.csv"), "overwrite": True}) == "destructive"
    assert tier("save", "sheets.save", {"to": str(tmp_path / "Budget.csv")}) == "mutate"
    assert tier("export_pdf", "sheets.exportPdf", {"workbook": str(budget)}) == "act"
    assert tier("export_pdf", "sheets.exportPdf", {"to": str(budget)}) == "destructive"
    assert tier("write", "sheets.write", {"workbook": str(budget), "range": "A1", "values": "x"}) == "destructive"
    assert tier("write", "sheets.write", {"workbook": str(budget), "range": "A1", "values": "x"}, {str(budget)}) == "act"
    assert tier("clean", "sheets.clean", {"workbook": "Budget.xlsx", "range": "A:A", "action": "trim"}) == "act"
    assert tier("read", "sheets.read", {"workbook": str(budget)}) == "read"
    # Removing a sheet always asks; on a file that is not open it asks every time.
    assert tier("remove_sheet", "sheets.removeSheet", {"sheet": "Old"}) == "mutate"
    assert tier("remove_sheet", "sheets.removeSheet", {"workbook": str(budget), "sheet": "Old"}, {str(budget)}) == "mutate"
    assert tier("remove_sheet", "sheets.removeSheet", {"workbook": str(budget), "sheet": "Old"}) == "destructive"


def test_an_edit_that_removes_a_sheet_asks_as_removing_it_does(plugin):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    _, command, args = tools.sheets_command({"action": "edit", "edits": [{"op": "write", "range": "A1", "values": [["x"]]}, {"op": "removeSheet", "sheet": "Old"}]})
    assert tools.office_tier("edit", command, args, catalogue, ()).value == "mutate"
    _, command, args = tools.sheets_command({"action": "edit", "edits": [{"op": "write", "range": "A1", "values": [["x"]]}, {"op": "clean", "range": "A:A", "action": "trim"}]})
    assert tools.office_tier("edit", command, args, catalogue, ()).value == "act"


def test_a_call_runs_in_the_shell_with_a_long_timeout(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_sheets({"action": "read", "workbook": "Budget.xlsx", "range": "A1:B3"}))
    assert reply["success"] is True and reply["data"]["values"][1] == ["Rent", 1200]
    assert calls == [("sheets.read", {"workbook": "Budget.xlsx", "range": "A1:B3"}, tools.OFFICE_TIMEOUT)]
    assert calls[-1][2] >= 60
    assert decisions[-1] == ("sheets", "read", "read")
    json.loads(tools.handle_sheets({"action": "remove_sheet", "sheet": "Old"}))
    assert decisions[-1] == ("sheets", "mutate", "remove_sheet")


def test_a_change_to_a_workbook_file_asks_unless_it_is_open(plugin, shell, tmp_path):
    tools = _mod(plugin, "tools")
    calls, decisions, open_paths = shell
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")
    call = {"action": "clean", "workbook": str(budget), "range": "A1:D50", "clean": "dedupe", "header": True}
    reply = json.loads(tools.handle_sheets(call))
    assert reply["success"] is True
    assert [command for command, _, _ in calls] == ["office.list", "sheets.clean"]
    assert calls[-1][1]["action"] == "dedupe"
    assert decisions[-1] == ("sheets", "destructive", "clean")
    open_paths.append(str(budget))
    json.loads(tools.handle_sheets(call))
    assert decisions[-1] == ("sheets", "act", "clean")


def test_a_shell_without_herald_sheets_says_to_update(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "list_commands", lambda: [{"id": "page.open", "tier": "read"}])
    tools._UI_CATALOGUE.clear()
    reply = json.loads(tools.handle_sheets({"action": "read"}))
    assert reply["success"] is False and "Herald Sheets" in reply["error"] and "update Herald OS" in reply["error"]
