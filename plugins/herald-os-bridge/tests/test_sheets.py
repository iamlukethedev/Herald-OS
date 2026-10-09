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

# The charts, summaries, data tools, names, validation, comments and notes, by action, with the
# command and tier the shell registers for each.
DEPTH = {
    "recommend_charts": ("sheets.recommendCharts", "read"),
    "insert_chart": ("sheets.insertChart", "act"),
    "list_charts": ("sheets.listCharts", "read"),
    "describe_chart": ("sheets.describeChart", "read"),
    "update_chart": ("sheets.updateChart", "act"),
    "move_chart": ("sheets.moveChart", "act"),
    "remove_chart": ("sheets.removeChart", "mutate"),
    "summarize": ("sheets.summarize", "act"),
    "refresh_summary": ("sheets.refreshSummary", "act"),
    "list_summaries": ("sheets.listSummaries", "read"),
    "remove_duplicates": ("sheets.removeDuplicates", "act"),
    "split_text": ("sheets.splitText", "act"),
    "trim_text": ("sheets.trimText", "act"),
    "change_case": ("sheets.changeCase", "act"),
    "convert_to_numbers": ("sheets.convertToNumbers", "act"),
    "convert_to_dates": ("sheets.convertToDates", "act"),
    "fill_down": ("sheets.fillDown", "act"),
    "highlight_duplicates": ("sheets.highlightDuplicates", "act"),
    "sort_by": ("sheets.sortBy", "act"),
    "list_names": ("sheets.listNames", "read"),
    "create_name": ("sheets.createName", "act"),
    "update_name": ("sheets.updateName", "act"),
    "delete_name": ("sheets.deleteName", "mutate"),
    "go_to_name": ("sheets.goToName", "act"),
    "set_validation": ("sheets.setValidation", "act"),
    "get_validation": ("sheets.getValidation", "read"),
    "clear_validation": ("sheets.clearValidation", "mutate"),
    "list_comments": ("sheets.listComments", "read"),
    "add_comment": ("sheets.addComment", "act"),
    "reply_to_comment": ("sheets.replyToComment", "act"),
    "resolve_comment": ("sheets.resolveComment", "act"),
    "delete_comment": ("sheets.deleteComment", "mutate"),
    "list_notes": ("sheets.listNotes", "read"),
    "set_note": ("sheets.setNote", "act"),
    "remove_note": ("sheets.removeNote", "mutate"),
}

CATALOGUE += [{"id": command, "title": command, "tier": tier, "args": []} for command, tier in DEPTH.values()]


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


def test_charts_summaries_tools_names_validation_comments_and_notes_map_to_their_commands(plugin):
    tools = _mod(plugin, "tools")
    for action, (command, _tier) in DEPTH.items():
        assert tools.SHEETS_ACTIONS[action] == command
        assert tools.sheets_command({"action": action})[:2] == (action, command)
    assert set(tools.SHEETS_ACTIONS) >= {"list", "read", "write", "sort", "clean", "edit", "save"}


def test_chart_actions_pass_their_settings_with_lists_and_objects_as_json(plugin):
    tools = _mod(plugin, "tools")
    series = [{"values": "B2:B13", "name": "Sales"}, {"values": "C2:C13", "nameCell": "C1", "type": "line", "secondary": True}]
    _, command, args = tools.sheets_command({"action": "insert_chart", "range": "A1:C13", "kind": "combo", "title": "Sales and margin", "series": series, "axes": {"y": {"min": 0}}, "palette": "#4472c4, #ed7d31", "hole": 40, "at": "H2", "width": 600, "height": 320, "legend": "bottom", "chart": "x", "values": [["no"]]})
    assert command == "sheets.insertChart"
    assert json.loads(args.pop("series")) == series and json.loads(args.pop("axes")) == {"y": {"min": 0}}
    assert args == {"range": "A1:C13", "kind": "combo", "title": "Sales and margin", "legend": "bottom", "palette": "#4472c4, #ed7d31", "hole": 40, "at": "H2", "width": 600, "height": 320}
    assert tools.sheets_command({"action": "update_chart", "chart": "chart-1", "labels": "value", "stacking": "stacked", "range": "A1:D13", "at": "H2"}) == ("update_chart", "sheets.updateChart", {"chart": "chart-1", "labels": "value", "stacking": "stacked", "range": "A1:D13"})
    assert tools.sheets_command({"action": "move_chart", "chart": "2", "at": "H20", "width": 480, "kind": "pie"}) == ("move_chart", "sheets.moveChart", {"chart": "2", "at": "H20", "width": 480})
    assert tools.sheets_command({"action": "remove_chart", "chart": "Sales", "range": "A1"}) == ("remove_chart", "sheets.removeChart", {"chart": "Sales"})
    assert tools.sheets_command({"action": "recommend_charts", "range": "selection", "kind": "bar"}) == ("recommend_charts", "sheets.recommendCharts", {"range": "selection"})


def test_summaries_and_data_tools_pass_their_arguments_under_the_shells_names(plugin):
    tools = _mod(plugin, "tools")
    _, command, args = tools.sheets_command({"action": "summarize", "range": "A1", "rowFields": ["Region"], "columnFields": ["Quarter"], "valueFields": [{"field": "Amount", "fn": "sum"}], "filters": [{"field": "Status", "values": ["Paid"]}], "destination": "new", "preview": True, "values": [["x"]], "rows": 3})
    assert command == "sheets.summarize"
    assert [json.loads(args.pop(key)) for key in ("rowFields", "columnFields", "valueFields", "filters")] == [["Region"], ["Quarter"], [{"field": "Amount", "fn": "sum"}], [{"field": "Status", "values": ["Paid"]}]]
    assert args == {"range": "A1", "destination": "new", "preview": True}
    assert tools.sheets_command({"action": "refresh_summary", "summary": "summary-1", "sheet": "Summary"})[2] == {"summary": "summary-1", "sheet": "Summary"}
    assert tools.sheets_command({"action": "remove_duplicates", "range": "A1:D90", "by": "A,C", "header": True, "preview": True})[2] == {"range": "A1:D90", "by": "A,C", "header": True, "preview": True}
    assert tools.sheets_command({"action": "split_text", "range": "A2:A40", "delimiter": "space", "consecutive": True, "destination": "D2", "overwrite": False, "header": True})[2] == {"range": "A2:A40", "delimiter": "space", "consecutive": True, "destination": "D2", "overwrite": False, "header": True}
    # Letter case travels as case, a date format as dateFormat: to is a file and format a cell format.
    assert tools.sheets_command({"action": "change_case", "range": "B2:B40", "case": "title", "to": "~/x.xlsx"}) == ("change_case", "sheets.changeCase", {"range": "B2:B40", "case": "title"})
    assert tools.sheets_command({"action": "convert_to_dates", "range": "C2:C40", "order": "dmy", "dateFormat": "d mmm yyyy", "format": {"bold": True}})[2] == {"range": "C2:C40", "order": "dmy", "dateFormat": "d mmm yyyy"}
    assert tools.sheets_command({"action": "convert_to_numbers", "range": "D2:D40", "preview": True})[2] == {"range": "D2:D40", "preview": True}
    assert tools.sheets_command({"action": "highlight_duplicates", "range": "A2:A90", "color": "#ffc7ce", "clear": False})[2] == {"range": "A2:A90", "color": "#ffc7ce", "clear": False}
    for action in ("trim_text", "fill_down"):
        assert tools.sheets_command({"action": action, "range": "A1:D9", "sheet": "Data", "case": "upper"})[2] == {"range": "A1:D9", "sheet": "Data"}
    keys = [{"column": "Region", "ascending": True}, {"column": "C", "ascending": False}]
    _, command, args = tools.sheets_command({"action": "sort_by", "range": "A1:D90", "keys": keys, "header": True, "by": "A"})
    assert command == "sheets.sortBy" and json.loads(args.pop("keys")) == keys and args == {"range": "A1:D90", "header": True}


def test_names_validation_comments_and_notes_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.sheets_command({"action": "create_name", "name": "TaxRate", "refersTo": "=0.07", "scope": "workbook", "comment": "GST", "range": "A1"})[2] == {"name": "TaxRate", "refersTo": "=0.07", "scope": "workbook", "comment": "GST"}
    assert tools.sheets_command({"action": "update_name", "name": "TaxRate", "newName": "GST"})[2] == {"name": "TaxRate", "newName": "GST"}
    assert tools.sheets_command({"action": "go_to_name", "name": "Sales", "workbook": "Budget.xlsx"})[2] == {"workbook": "Budget.xlsx", "name": "Sales"}
    assert tools.sheets_command({"action": "list_names", "sheet": "x"}) == ("list_names", "sheets.listNames", {})
    rule = {"type": "list", "items": ["Yes", "No"]}
    _, command, args = tools.sheets_command({"action": "set_validation", "range": "D2:D90", "rule": rule, "input": {"title": "Paid", "message": "Yes or No"}, "alert": {"style": "warning"}, "allowBlank": False, "dropdown": True})
    assert command == "sheets.setValidation"
    assert [json.loads(args.pop(key)) for key in ("rule", "input", "alert")] == [rule, {"title": "Paid", "message": "Yes or No"}, {"style": "warning"}]
    assert args == {"range": "D2:D90", "allowBlank": False, "dropdown": True}
    assert tools.sheets_command({"action": "clear_validation", "range": "D2:D90", "rule": rule}) == ("clear_validation", "sheets.clearValidation", {"range": "D2:D90"})
    assert tools.sheets_command({"action": "add_comment", "cell": "B2", "text": "Is this right?", "commentId": "x"})[2] == {"cell": "B2", "text": "Is this right?"}
    assert tools.sheets_command({"action": "reply_to_comment", "commentId": "c1", "text": "Yes"})[2] == {"commentId": "c1", "text": "Yes"}
    assert tools.sheets_command({"action": "resolve_comment", "cell": "B2", "resolved": False})[2] == {"cell": "B2", "resolved": False}
    assert tools.sheets_command({"action": "delete_comment", "commentId": "r2", "text": "x"})[2] == {"commentId": "r2"}
    assert tools.sheets_command({"action": "set_note", "cell": "C3", "text": "Estimate"})[2] == {"cell": "C3", "text": "Estimate"}
    assert tools.sheets_command({"action": "remove_note", "cell": "C3", "text": "x"})[2] == {"cell": "C3"}


def test_reads_read_changes_act_and_removals_ask(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")
    for action, (command, tier) in DEPTH.items():
        _, _, args = tools.sheets_command({"action": action, "range": "A1:D9", "chart": "1", "cell": "B2", "name": "Sales"})
        assert tools.office_tier(action, command, args, catalogue, ()).value == tier, action
        # A file that is not open is changed on disk, which asks every time; reading it does not.
        on_disk = tools.office_tier(action, command, {**args, "workbook": str(budget)}, catalogue, ()).value
        assert on_disk == ("read" if tier == "read" else "destructive"), action
        assert tools.office_tier(action, command, {**args, "workbook": str(budget)}, catalogue, {str(budget)}).value == tier, action


def test_an_edit_that_removes_a_chart_a_name_a_comment_or_rules_asks_as_the_removal_does(plugin):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}

    def tier(*edits):
        _, command, args = tools.sheets_command({"action": "edit", "edits": list(edits)})
        return tools.office_tier("edit", command, args, catalogue, ()).value

    chart = {"op": "insertChart", "range": "A1:B13", "kind": "line"}
    assert tier(chart, {"op": "addComment", "cell": "B2", "text": "Peak"}, {"op": "sortBy", "range": "A1:D9", "keys": [{"column": "A"}]}) == "act"
    for removal in ({"op": "removeChart", "chart": "1"}, {"op": "deleteName", "name": "Sales"}, {"op": "clearValidation", "range": "D2:D9"}, {"op": "deleteComment", "cell": "B2"}, {"op": "removeNote", "cell": "C3"}):
        assert tier(chart, removal) == "mutate", removal["op"]
    # The shell takes an op in any case and with spaces round it, and so does the tier.
    for spelling in ("removechart", " RemoveChart ", "REMOVECHART"):
        assert tier(chart, {"op": spelling, "chart": "1"}) == "mutate", spelling
    assert tier({"op": "removeSheet ", "sheet": "Old"}) == "mutate"
    assert tier({"op": "nonsense"}, {"op": None}, {"op": 3}) == "act"


def test_a_preview_of_a_file_that_is_not_open_reads_it_and_asks_nothing_more(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")
    for action in ("remove_duplicates", "summarize", "convert_to_dates"):
        command = tools.SHEETS_ACTIONS[action]
        _, _, args = tools.sheets_command({"action": action, "workbook": str(budget), "range": "A1:D9", "preview": True})
        assert tools.office_tier(action, command, args, catalogue, ()).value == "act", action
        # Only a real yes counts as a preview here; anything else still asks as a change to the file.
        for preview in (False, "true", None):
            _, _, args = tools.sheets_command({"action": action, "workbook": str(budget), "range": "A1:D9", "preview": preview})
            assert tools.office_tier(action, command, args, catalogue, ()).value == "destructive", (action, preview)


def test_the_schema_describes_the_new_arguments_with_one_type_each(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.SHEETS_SCHEMA["parameters"]["properties"]
    for action in DEPTH:
        for name in tools.SHEETS_ARGS[action]:
            assert name in properties and properties[name].get("description"), f"{action} passes {name}, which the schema does not describe"
    assert all(isinstance(prop.get("type"), str) for prop in properties.values())
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    types = {name: prop["type"] for name, prop in properties.items()}
    assert {name: types[name] for name in ("series", "valueFields", "filters", "keys", "rowFields", "columnFields")} == dict.fromkeys(("series", "valueFields", "filters", "keys", "rowFields", "columnFields"), "array")
    assert properties["rowFields"]["items"]["type"] == "string" and properties["valueFields"]["items"]["type"] == "object" and properties["keys"]["items"]["type"] == "object"
    assert {name: types[name] for name in ("axes", "rule", "input", "alert")} == dict.fromkeys(("axes", "rule", "input", "alert"), "object")
    assert {name: types[name] for name in ("hole", "width", "height")} == dict.fromkeys(("hole", "width", "height"), "number")
    assert {name: types[name] for name in ("preview", "consecutive", "allowBlank", "dropdown", "resolved")} == dict.fromkeys(("preview", "consecutive", "allowBlank", "dropdown", "resolved"), "boolean")
    assert {name: types[name] for name in ("chart", "palette", "cell", "commentId", "refersTo", "destination", "case", "dateFormat", "order", "by")} == dict.fromkeys(("chart", "palette", "cell", "commentId", "refersTo", "destination", "case", "dateFormat", "order", "by"), "string")
    # The Phase 3 shapes stay: rows of cells, a cell format, numbers for rows, columns and index, a file for to.
    assert properties["values"]["items"]["type"] == "array" and types["format"] == "object" and types["to"] == "string"
    assert (types["rows"], types["columns"], types["index"]) == ("number", "number", "number")
    for words in ("insertChart", "removeChart", "summarize", "addComment", "setNote", "comments stay out of the undo step"):
        assert words in properties["edits"]["description"]


def test_the_description_names_the_new_capabilities(plugin):
    tools = _mod(plugin, "tools")
    description = tools.SHEETS_SCHEMA["description"]
    for words in ("recommend_charts first", "insert_chart", "summarize", "named ranges", "dropdown lists", "signed Hermes", "remove duplicates", "preview=true", "comment threads aside"):
        assert words in description


def test_an_older_shell_without_the_new_commands_says_to_update_and_keeps_the_rest(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    calls, _, _ = shell
    older = [entry for entry in CATALOGUE if entry["id"] not in {command for command, _ in DEPTH.values()}]
    monkeypatch.setattr(ui, "list_commands", lambda: older)
    tools._UI_CATALOGUE.clear()
    for action in ("insert_chart", "summarize", "add_comment", "remove_chart"):
        reply = json.loads(tools.handle_sheets({"action": action, "range": "A1:B9", "cell": "B2", "text": "x", "chart": "1"}))
        assert reply["success"] is False and "update Herald OS" in reply["error"], action
    assert not [command for command, _, _ in calls if command != "office.list"]
    reply = json.loads(tools.handle_sheets({"action": "read", "range": "A1:B3"}))
    assert reply["success"] is True and calls[-1][0] == "sheets.read"
