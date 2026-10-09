"""The ``docs`` tool: actions to docs.* commands, the tier rules, and a call through the shell."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "office.list", "title": "What is open in Herald Office", "tier": "read", "args": []},
    {"id": "docs.list", "title": "What is open in Herald Docs", "tier": "read", "args": []},
    {"id": "docs.read", "title": "Read a document", "tier": "read", "args": []},
    {"id": "docs.write", "title": "Write in a document", "tier": "act", "args": []},
    {"id": "docs.edit", "title": "Make several edits in a document at once", "tier": "act", "args": []},
    {"id": "docs.save", "title": "Save a document", "tier": "mutate", "args": []},
    {"id": "docs.exportPdf", "title": "Export a document as a PDF", "tier": "act", "args": []},
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
            documents = [{"app": "docs", "name": Path(path).name, "path": path, "format": "docx", "modified": False, "active": True, "front": True} for path in open_paths]
            return {"ok": True, "summary": "Office: in front is Report.docx", "data": {"documents": documents}}
        if command == "docs.read":
            return {"ok": True, "summary": "Report.docx: 120 words, 1 heading", "data": {"name": "Report.docx", "outline": [{"level": 1, "text": "Report"}], "content": "# Report\n\nText."}}
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
    action, command, args = tools.docs_command({"action": "write", "content": "## Summary", "at": "marked", "source": "x.png", "heading": "", "mode": None})
    assert (action, command) == ("write", "docs.write")
    assert args == {"content": "## Summary", "at": "marked"}
    assert tools.docs_command({"action": "list_all", "document": "Report.docx"}) == ("list_all", "office.list", {})
    assert tools.docs_command({"action": "list"}) == ("list", "docs.list", {})
    assert all(command.startswith("docs.") for action, command in tools.DOCS_ACTIONS.items() if action != "list_all")
    with pytest.raises(ValueError, match="insert_range"):
        tools.docs_command({"action": "paint"})


def test_writing_formatting_and_pictures_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.docs_command({"action": "new", "name": "Trip notes", "template": "meeting notes", "content": "# Trip", "document": "x"}) == ("new", "docs.new", {"name": "Trip notes", "template": "meeting notes", "content": "# Trip"})
    assert tools.docs_command({"action": "read", "document": "~/Documents/Report.docx", "part": "selection", "maxChars": 4000, "text": "x"}) == ("read", "docs.read", {"document": "~/Documents/Report.docx", "part": "selection", "maxChars": 4000})
    _, command, args = tools.docs_command({"action": "write", "content": "- Budget agreed", "at": "heading", "heading": "Decisions", "mode": "append", "format": "markdown"})
    assert (command, args) == ("docs.write", {"content": "- Budget agreed", "format": "markdown", "at": "heading", "heading": "Decisions", "mode": "append"})
    _, command, args = tools.docs_command({"action": "format", "at": "text", "text": "Herald", "bold": True, "italic": False, "color": "#1f6feb", "size": "14", "source": "x"})
    assert (command, args) == ("docs.format", {"at": "text", "text": "Herald", "bold": True, "italic": False, "color": "#1f6feb", "size": "14"})
    # An empty replacement is left out, which deletes the matches.
    assert tools.docs_command({"action": "replace", "find": "DRAFT", "replacement": "", "all": False}) == ("replace", "docs.replace", {"find": "DRAFT", "all": False})
    assert tools.docs_command({"action": "image", "source": "~/Pictures/chart.png", "alt": "Sales by month", "width": 480, "at": "after", "cells": []}) == ("image", "docs.insertImage", {"source": "~/Pictures/chart.png", "alt": "Sales by month", "width": 480, "at": "after"})
    assert tools.docs_command({"action": "page", "size": "a4", "orientation": "landscape", "margins": "2cm", "bold": True}) == ("page", "docs.setPage", {"size": "a4", "orientation": "landscape", "margins": "2cm"})
    assert tools.docs_command({"action": "insert_range", "workbook": "Budget.xlsx", "range": "A1:D12", "at": "heading", "heading": "Budget", "values": [[1]]}) == ("insert_range", "docs.insertRange", {"workbook": "Budget.xlsx", "range": "A1:D12", "at": "heading", "heading": "Budget"})
    assert tools.docs_command({"action": "export_pdf", "to": "~/Desktop/Report.pdf", "overwrite": True}) == ("export_pdf", "docs.exportPdf", {"to": "~/Desktop/Report.pdf", "overwrite": True})
    assert tools.docs_command({"action": "undo", "steps": 2, "content": "x"}) == ("undo", "docs.undo", {"steps": 2})


def test_tables_and_edits_travel_as_json(plugin):
    tools = _mod(plugin, "tools")
    cells = [["Item", "Cost"], ["Rent", "1,200"]]
    _, command, args = tools.docs_command({"action": "table", "cells": cells, "header": True, "at": "after", "rows": None})
    assert command == "docs.insertTable"
    assert json.loads(args.pop("cells")) == cells
    assert args == {"header": True, "at": "after"}
    edits = [{"op": "write", "content": "## Summary\n\nShort.", "at": "start"}, {"op": "replace", "find": "draft", "replacement": "final"}]
    _, command, args = tools.docs_command({"action": "edit", "document": "Report.docx", "edits": edits, "content": "stray"})
    assert command == "docs.edit"
    assert json.loads(args.pop("edits")) == edits
    assert args == {"document": "Report.docx"}
    # Edits the model wrote as JSON text pass through as they are.
    text = '[{"op": "pageBreak", "at": "end"}]'
    assert tools.docs_command({"action": "edit", "edits": text}) == ("edit", "docs.edit", {"edits": text})


def test_the_schema_offers_every_action_and_argument(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.DOCS_SCHEMA["parameters"]["properties"]
    assert set(tools.DOCS_ARGS) == set(tools.DOCS_ACTIONS)
    assert properties["action"]["enum"] == list(tools.DOCS_ACTIONS)
    for action, names in tools.DOCS_ARGS.items():
        for name in names:
            assert name in properties, f"{action} passes {name}, which the schema does not describe"
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    assert properties["cells"]["type"] == "array" and properties["cells"]["items"]["type"] == "array"
    assert properties["edits"]["type"] == "array" and properties["edits"]["items"]["type"] == "object"
    assert properties["bold"]["type"] == "boolean" and properties["steps"]["type"] == "number"
    # format takes a font size and page a paper size, so the shared argument is text.
    assert properties["size"]["type"] == "string" and "a4" in properties["size"]["description"]


def test_the_descriptions_teach_the_workflow_and_point_to_the_skill(plugin):
    tools = _mod(plugin, "tools")
    description = tools.DOCS_SCHEMA["description"]
    assert 'skill_view name="herald-os-bridge:herald-docs"' in description
    for words in ("action=list", "list_all", "part=selection", "at=marked", "action=edit", "one step the person can undo", "Never save unless the person asks", "insert_range", "tab"):
        assert words in description
    assert "`office`" in tools.OS_UI_SCHEMA["description"] and "Herald Docs, Sheets and Slides" in tools.OS_UI_SCHEMA["description"]


def test_saving_or_exporting_over_a_file_asks_every_time(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    pdf = tmp_path / "Report.pdf"
    pdf.write_bytes(b"%PDF")
    new = str(tmp_path / "Report v2.docx")

    def tier(action, command, args):
        return tools.office_tier(action, command, args, catalogue, set()).value

    # Without to, a save writes over the document's own file.
    assert tier("save", "docs.save", {}) == "destructive"
    assert tier("save", "docs.save", {"document": "Report.docx"}) == "destructive"
    assert tier("save", "docs.save", {"to": str(report)}) == "destructive"
    assert tier("save", "docs.save", {"to": new, "overwrite": True}) == "destructive"
    assert tier("save", "docs.save", {"to": new}) == "mutate"
    # Saving a file that is not open as another file leaves it as it is.
    assert tier("save", "docs.save", {"document": str(report), "to": new}) == "mutate"
    assert tier("export_pdf", "docs.exportPdf", {}) == "act"
    assert tier("export_pdf", "docs.exportPdf", {"document": str(report), "to": str(tmp_path / "Other.pdf")}) == "act"
    assert tier("export_pdf", "docs.exportPdf", {"to": str(pdf)}) == "destructive"
    assert tier("export_pdf", "docs.exportPdf", {"overwrite": True}) == "destructive"


def test_changing_a_file_that_is_not_open_asks_every_time(plugin, tmp_path, monkeypatch):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")

    def tier(action, command, args, open_paths=()):
        return tools.office_tier(action, command, args, catalogue, open_paths).value

    edit = {"document": str(report), "content": "## Summary"}
    assert tier("write", "docs.write", edit) == "destructive"
    assert tier("write", "docs.write", edit, {str(report)}) == "act"
    assert tier("edit", "docs.edit", {"document": str(report), "edits": "[]"}, {str(tmp_path / "Other.docx")}) == "destructive"
    monkeypatch.setenv("HOME", str(tmp_path))
    assert tier("write", "docs.write", {"document": "~/Report.docx"}) == "destructive"
    assert tier("write", "docs.write", {"document": "~/Report.docx"}, {str(report)}) == "act"
    # An open document's name, a file that is not there and the one in front are the registry's to say.
    assert tier("write", "docs.write", {"document": "Report.docx"}) == "act"
    assert tier("write", "docs.write", {"document": str(tmp_path / "Missing.docx")}) == "act"
    assert tier("write", "docs.write", {}) == "act"
    # Reading a file never changes it, and a tier is never lowered.
    assert tier("read", "docs.read", {"document": str(report)}) == "read"
    assert tier("list_all", "office.list", {}) == "read"
    assert tools.office_tier("write", "docs.write", {"document": str(report)}, {"docs.write": {"tier": "destructive"}}, {str(report)}).value == "destructive"
    assert tools.office_tier("write", "docs.unknown", {}, catalogue, ()).value == "mutate"


def test_an_edit_batch_takes_the_tier_of_its_most_guarded_op(plugin):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    edits = json.dumps([{"op": "write", "content": "x"}, {"op": "table", "rows": 2, "cols": 2}, {"op": "pageBreak"}])
    assert tools.office_tier("edit", "docs.edit", {"edits": edits}, catalogue, ()).value == "act"
    guarded = {**catalogue, "docs.write": {"id": "docs.write", "tier": "mutate"}}
    assert tools.office_tier("edit", "docs.edit", {"edits": edits}, guarded, ()).value == "mutate"


def test_a_call_runs_in_the_shell_with_a_long_timeout(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_docs({"action": "read", "document": "Report.docx", "part": "outline"}))
    assert reply["success"] is True
    assert reply["result"] == "Report.docx: 120 words, 1 heading" and reply["data"]["outline"][0]["text"] == "Report"
    assert calls == [("docs.read", {"document": "Report.docx", "part": "outline"}, tools.OFFICE_TIMEOUT)]
    assert calls[-1][2] >= 60
    assert decisions[-1] == ("docs", "read", "read")
    json.loads(tools.handle_docs({"action": "list_all"}))
    assert calls[-1][0] == "office.list" and decisions[-1] == ("docs", "read", "list_all")


def test_a_change_to_a_file_asks_unless_the_file_is_open(plugin, shell, tmp_path):
    tools = _mod(plugin, "tools")
    calls, decisions, open_paths = shell
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    reply = json.loads(tools.handle_docs({"action": "write", "document": str(report), "content": "## Summary", "at": "start"}))
    assert reply["success"] is True
    assert [call[0] for call in calls] == ["office.list", "docs.write"]
    assert decisions[-1] == ("docs", "destructive", "write")
    open_paths.append(str(report))
    calls.clear()
    json.loads(tools.handle_docs({"action": "write", "document": str(report), "content": "## Summary", "at": "start"}))
    assert [call[0] for call in calls] == ["office.list", "docs.write"]
    assert decisions[-1] == ("docs", "act", "write")
    # A document named by its tab, or the one in front, needs no list of what is open.
    calls.clear()
    json.loads(tools.handle_docs({"action": "write", "document": "Report.docx", "content": "x"}))
    json.loads(tools.handle_docs({"action": "save"}))
    assert [call[0] for call in calls] == ["docs.write", "docs.save"]
    assert decisions[-2:] == [("docs", "act", "write"), ("docs", "destructive", "save")]


def test_not_knowing_what_is_open_counts_a_file_as_closed(plugin, shell, tmp_path, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    calls, decisions, open_paths = shell
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    open_paths.append(str(report))
    answer = ui.run_command

    def run_command(command, args=None, **kwargs):
        if command == "office.list":
            raise RuntimeError("Herald OS did not answer")
        return answer(command, args, **kwargs)

    monkeypatch.setattr(ui, "run_command", run_command)
    reply = json.loads(tools.handle_docs({"action": "edit", "document": str(report), "edits": [{"op": "pageBreak"}]}))
    assert reply["success"] is True
    assert decisions[-1] == ("docs", "destructive", "edit")
    assert calls[-1] == ("docs.edit", {"document": str(report), "edits": '[{"op": "pageBreak"}]'}, tools.OFFICE_TIMEOUT)


def test_a_refusal_comes_back_as_the_shells_error(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "run_command", lambda command, args=None, **_: {"ok": False, "error": "No document called “Notes” is open (open: Report.docx)"})
    reply = json.loads(tools.handle_docs({"action": "write", "document": "Notes", "content": "x"}))
    assert reply["success"] is False and reply["error"].startswith("No document called")


def test_a_shell_without_herald_docs_says_to_update(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "list_commands", lambda: [{"id": "page.open", "tier": "read"}])
    tools._UI_CATALOGUE.clear()
    reply = json.loads(tools.handle_docs({"action": "list"}))
    assert reply["success"] is False and "Herald Docs" in reply["error"] and "update Herald OS" in reply["error"]
    reply = json.loads(tools.handle_docs({"action": "paint"}))
    assert reply["success"] is False and "export_pdf" in reply["error"]
