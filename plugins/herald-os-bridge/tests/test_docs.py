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

# The headers and footers, fields, notes, sections, comments, tables of contents, templates and
# statistics, by action, with the command and tier the shell registers for each.
DEPTH = {
    "set_header": ("docs.setHeader", "act"),
    "set_footer": ("docs.setFooter", "act"),
    "clear_header": ("docs.clearHeader", "mutate"),
    "clear_footer": ("docs.clearFooter", "mutate"),
    "set_header_options": ("docs.setHeaderOptions", "act"),
    "insert_field": ("docs.insertField", "act"),
    "insert_note": ("docs.insertNote", "act"),
    "list_notes": ("docs.listNotes", "read"),
    "set_note": ("docs.setNote", "act"),
    "remove_note": ("docs.removeNote", "mutate"),
    "insert_section_break": ("docs.insertSectionBreak", "act"),
    "list_sections": ("docs.listSections", "read"),
    "remove_section_break": ("docs.removeSectionBreak", "mutate"),
    "list_comments": ("docs.listComments", "read"),
    "add_comment": ("docs.addComment", "act"),
    "add_comments": ("docs.addComments", "act"),
    "reply_to_comment": ("docs.replyToComment", "act"),
    "edit_comment": ("docs.editComment", "act"),
    "resolve_comment": ("docs.resolveComment", "act"),
    "delete_comment": ("docs.deleteComment", "mutate"),
    "insert_toc": ("docs.insertToc", "act"),
    "update_tocs": ("docs.updateTocs", "act"),
    "set_toc": ("docs.setToc", "act"),
    "remove_toc": ("docs.removeToc", "mutate"),
    "list_templates": ("docs.listTemplates", "read"),
    "statistics": ("docs.statistics", "read"),
}

CATALOGUE += [{"id": command, "title": command, "tier": tier, "args": []} for command, tier in DEPTH.values()]

REVIEW = [
    {"text": "Grammar: 'affect' is the verb. Suggest: 'a big effect on sales'.", "quote": "a big affect on sales"},
    {"text": "Clarity: who decided? Suggest: name the team.", "quote": "it was decided", "all": True},
    {"text": "Tone: too casual for a client. Suggest: open with the result.", "heading": "Summary"},
    {"text": "Shorter?", "at": "marked"},
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


def test_headers_notes_sections_comments_tocs_templates_and_statistics_map_to_their_commands(plugin):
    tools = _mod(plugin, "tools")
    for action, (command, tier) in DEPTH.items():
        assert tools.DOCS_ACTIONS[action] == command
        assert tools.docs_command({"action": action})[:2] == (action, command)
        # Lists and statistics read, taking something away asks, and the rest acts.
        assert tier == ("read" if action.startswith("list_") or action == "statistics" else "mutate" if action.startswith(("clear_", "remove_", "delete_")) else "act"), action
    phase3 = {"new": "docs.new", "read": "docs.read", "write": "docs.write", "page": "docs.setPage", "edit": "docs.edit", "insert_range": "docs.insertRange", "save": "docs.save"}
    assert {action: tools.DOCS_ACTIONS[action] for action in phase3} == phase3


def test_header_footer_field_and_note_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.docs_command({"action": "set_header", "document": "Report.docx", "content": "Q3 report", "format": "text", "kind": "first", "align": "right", "quote": "x"}) == ("set_header", "docs.setHeader", {"document": "Report.docx", "content": "Q3 report", "format": "text", "kind": "first", "align": "right"})
    assert tools.docs_command({"action": "set_footer", "content": "Page {page} of {pages}", "align": "center", "heading": "Summary"}) == ("set_footer", "docs.setFooter", {"content": "Page {page} of {pages}", "align": "center"})
    assert tools.docs_command({"action": "clear_header", "kind": "even", "content": "x"}) == ("clear_header", "docs.clearHeader", {"kind": "even"})
    assert tools.docs_command({"action": "clear_footer", "document": "~/Report.docx", "align": "center"}) == ("clear_footer", "docs.clearFooter", {"document": "~/Report.docx"})
    assert tools.docs_command({"action": "set_header_options", "differentFirst": True, "differentOddEven": False, "kind": "first"}) == ("set_header_options", "docs.setHeaderOptions", {"differentFirst": True, "differentOddEven": False})
    assert tools.docs_command({"action": "insert_field", "field": "date", "format": "d MMMM yyyy", "quote": "Dated", "at": "end", "heading": "", "content": "x"}) == ("insert_field", "docs.insertField", {"field": "date", "format": "d MMMM yyyy", "quote": "Dated", "at": "end"})
    assert tools.docs_command({"action": "insert_note", "content": "Source: the 2025 survey.", "kind": "endnote", "quote": "grew by a third", "heading": "Findings", "mode": "before", "field": "page"}) == ("insert_note", "docs.insertNote", {"content": "Source: the 2025 survey.", "kind": "endnote", "quote": "grew by a third", "heading": "Findings", "mode": "before"})
    assert tools.docs_command({"action": "list_notes", "heading": "Findings", "note": "x"}) == ("list_notes", "docs.listNotes", {"heading": "Findings"})
    assert tools.docs_command({"action": "set_note", "note": "footnote 2", "content": "Source: the survey.", "format": "markdown", "kind": "endnote"}) == ("set_note", "docs.setNote", {"note": "footnote 2", "content": "Source: the survey.", "format": "markdown"})
    assert tools.docs_command({"action": "remove_note", "note": "endnote 1", "content": "x"}) == ("remove_note", "docs.removeNote", {"note": "endnote 1"})


def test_section_toc_template_and_statistics_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    _, command, args = tools.docs_command({"action": "insert_section_break", "kind": "nextPage", "quote": "Appendix A", "orientation": "landscape", "size": "a4", "margins": "1in", "heading": "Appendix", "mode": "before", "section": "2", "levels": 2})
    assert (command, args) == ("docs.insertSectionBreak", {"kind": "nextPage", "heading": "Appendix", "mode": "before", "quote": "Appendix A", "size": "a4", "orientation": "landscape", "margins": "1in"})
    assert tools.docs_command({"action": "list_sections", "document": "Report.docx", "section": "2"}) == ("list_sections", "docs.listSections", {"document": "Report.docx"})
    assert tools.docs_command({"action": "remove_section_break", "section": "3", "kind": "continuous"}) == ("remove_section_break", "docs.removeSectionBreak", {"section": "3"})
    _, command, args = tools.docs_command({"action": "insert_toc", "levels": 2, "title": "Contents", "quote": "Q3 report", "at": "start", "toc": "1", "content": "x"})
    assert (command, args) == ("docs.insertToc", {"levels": 2, "title": "Contents", "at": "start", "quote": "Q3 report"})
    assert tools.docs_command({"action": "insert_toc", "heading": "Summary", "mode": "before"})[2] == {"heading": "Summary", "mode": "before"}
    assert tools.docs_command({"action": "update_tocs", "document": "Report.docx", "toc": "1"}) == ("update_tocs", "docs.updateTocs", {"document": "Report.docx"})
    assert tools.docs_command({"action": "set_toc", "toc": "2", "levels": 3, "title": "none", "quote": "x"}) == ("set_toc", "docs.setToc", {"toc": "2", "levels": 3, "title": "none"})
    assert tools.docs_command({"action": "remove_toc", "toc": "1", "levels": 2}) == ("remove_toc", "docs.removeToc", {"toc": "1"})
    # docs.listTemplates takes no arguments, and the shell refuses any it does not declare.
    assert tools.docs_command({"action": "list_templates", "document": "Report.docx", "name": "x"}) == ("list_templates", "docs.listTemplates", {})
    assert tools.docs_command({"action": "statistics", "heading": "Findings", "selection": False, "part": "x"}) == ("statistics", "docs.statistics", {"heading": "Findings", "selection": False})
    assert tools.docs_command({"action": "statistics", "document": "~/Essay.docx", "selection": True})[2] == {"document": "~/Essay.docx", "selection": True}


def test_comment_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.docs_command({"action": "list_comments", "heading": "Summary", "comment": "x"}) == ("list_comments", "docs.listComments", {"heading": "Summary"})
    _, command, args = tools.docs_command({"action": "add_comment", "text": "Source?", "quote": "grew by a third", "all": True, "comment": "c1", "comments": REVIEW})
    assert (command, args) == ("docs.addComment", {"text": "Source?", "quote": "grew by a third", "all": True})
    assert tools.docs_command({"action": "add_comment", "text": "Shorter?", "heading": "Summary"})[2] == {"text": "Shorter?", "heading": "Summary"}
    assert tools.docs_command({"action": "add_comment", "text": "Why?", "at": "marked"})[2] == {"text": "Why?", "at": "marked"}
    assert tools.docs_command({"action": "reply_to_comment", "comment": "c1", "text": "Fixed.", "resolved": True}) == ("reply_to_comment", "docs.replyToComment", {"comment": "c1", "text": "Fixed."})
    assert tools.docs_command({"action": "edit_comment", "comment": "c1-r1", "text": "Fixed in v2.", "all": True}) == ("edit_comment", "docs.editComment", {"comment": "c1-r1", "text": "Fixed in v2."})
    assert tools.docs_command({"action": "resolve_comment", "comment": "c1", "resolved": False, "text": "x"}) == ("resolve_comment", "docs.resolveComment", {"comment": "c1", "resolved": False})
    assert tools.docs_command({"action": "delete_comment", "all": True, "text": "x"}) == ("delete_comment", "docs.deleteComment", {"all": True})
    assert tools.docs_command({"action": "delete_comment", "comment": "c2", "resolved": True})[2] == {"comment": "c2"}


def test_a_review_passes_the_document_and_its_comments_as_one_json_list(plugin):
    tools = _mod(plugin, "tools")
    action, command, args = tools.docs_command({"action": "add_comments", "document": "Report.docx", "comments": REVIEW, "text": "stray", "quote": "stray", "heading": "stray"})
    assert (action, command) == ("add_comments", "docs.addComments")
    assert set(args) == {"document", "comments"} and args["document"] == "Report.docx"
    assert isinstance(args["comments"], str) and json.loads(args["comments"]) == REVIEW
    # Comments the model wrote as JSON text pass through as they are, and one object travels as JSON too.
    text = json.dumps(REVIEW[:1])
    assert tools.docs_command({"action": "add_comments", "comments": text}) == ("add_comments", "docs.addComments", {"comments": text})
    _, _, args = tools.docs_command({"action": "add_comments", "comments": REVIEW[0]})
    assert json.loads(args["comments"]) == REVIEW[0]


def test_edits_with_the_new_ops_travel_as_json(plugin):
    tools = _mod(plugin, "tools")
    edits = [
        {"op": "setFooter", "content": "Page {page} of {pages}", "align": "center"},
        {"op": "insertToc", "levels": 2, "quote": "Q3 report"},
        {"op": "insertNote", "content": "Source: the survey.", "quote": "grew by a third"},
        {"op": "addComments", "comments": REVIEW[:2]},
        {"op": "page", "section": "2", "orientation": "landscape", "headerDistance": "0.5in"},
    ]
    _, command, args = tools.docs_command({"action": "edit", "document": "Report.docx", "edits": edits, "comments": REVIEW})
    assert command == "docs.edit" and json.loads(args.pop("edits")) == edits and args == {"document": "Report.docx"}


def test_new_read_and_page_pass_their_new_arguments_and_keep_the_old_ones(plugin):
    tools = _mod(plugin, "tools")
    call = {"action": "new", "template": "project-proposal", "size": "letter", "content": "# Harbour walk", "name": "Proposal", "path": "~/Documents/Proposal.docx", "section": "1"}
    assert tools.docs_command(call) == ("new", "docs.new", {"name": "Proposal", "content": "# Harbour walk", "template": "project-proposal", "size": "letter", "path": "~/Documents/Proposal.docx"})
    # The Phase 3 names and the person's own templates go through as given: the shell knows them.
    for template in ("meeting notes", "resume", "proposal", "cover letter", "Cover letter", "My letterhead"):
        assert tools.docs_command({"action": "new", "template": template})[2] == {"template": template}
    for part in ("comments", "notes", "headers", "sections", "tocs", "selection", "outline"):
        assert tools.docs_command({"action": "read", "part": part, "heading": "Findings", "comment": "x"})[2] == {"part": part, "heading": "Findings"}
    page = {"size": "8.5x11in", "orientation": "landscape", "margins": "1in", "top": "2cm", "right": "20mm", "bottom": "72", "left": "1in", "headerDistance": "0.5in", "footerDistance": "0.4in", "section": "all"}
    assert tools.docs_command({"action": "page", **page, "kind": "x", "levels": 2}) == ("page", "docs.setPage", page)
    assert tools.docs_command({"action": "page", "size": "a4", "orientation": "portrait", "margins": "2cm"})[2] == {"size": "a4", "orientation": "portrait", "margins": "2cm"}


def test_reads_read_changes_act_removals_ask_and_a_closed_file_asks_every_time(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    for action, (command, tier) in DEPTH.items():
        _, _, args = tools.docs_command({"action": action, "content": "x", "text": "x", "note": "footnote 1", "comment": "c1", "toc": "1", "section": "2", "comments": REVIEW})
        assert tools.office_tier(action, command, args, catalogue, ()).value == tier, action
        if "document" not in tools.DOCS_ARGS[action]:
            continue
        # A file that is not open is changed on disk, which asks every time; reading it does not.
        on_disk = tools.office_tier(action, command, {**args, "document": str(report)}, catalogue, ()).value
        assert on_disk == ("read" if tier == "read" else "destructive"), action
        assert tools.office_tier(action, command, {**args, "document": str(report)}, catalogue, {str(report)}).value == tier, action
    assert tools.office_tier("list_templates", "docs.listTemplates", {}, catalogue, ()).value == "read"


def test_an_edit_that_takes_a_table_of_contents_or_a_comment_away_asks_as_the_removal_does(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}

    def tier(*edits, document=None, open_paths=()):
        _, command, args = tools.docs_command({"action": "edit", "document": document, "edits": list(edits)})
        return tools.office_tier("edit", command, args, catalogue, open_paths).value

    footer = {"op": "setFooter", "content": "Page {page} of {pages}"}
    assert tier(footer, {"op": "insertToc"}, {"op": "addComments", "comments": REVIEW}, {"op": "resolveComment", "comment": "c1"}, {"op": "write", "content": "x"}) == "act"
    for removal in ({"op": "removeToc"}, {"op": "deleteComment", "comment": "c1"}, {"op": "removeNote", "note": "footnote 1"}, {"op": "clearHeader"}, {"op": "clearFooter", "kind": "first"}, {"op": "removeSectionBreak", "section": "2"}):
        assert tier(footer, removal) == "mutate", removal["op"]
    # The shell takes an op in any case and with spaces round it, and so does the tier.
    for spelling in ("removetoc", " RemoveToc ", "REMOVETOC", "deletecomment", "DeleteComment ", " DELETECOMMENT"):
        assert tier(footer, {"op": spelling}) == "mutate", spelling
    _, command, args = tools.docs_command({"action": "edit", "edits": '[{"op": "removeToc"}]'})
    assert tools.office_tier("edit", command, args, catalogue, ()).value == "mutate"
    # On a file that is not open the batch is written to disk, which asks every time.
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    assert tier({"op": "removeToc"}, document=str(report)) == "destructive"
    assert tier({"op": "removeToc"}, document=str(report), open_paths={str(report)}) == "mutate"


def test_the_schema_describes_the_new_arguments_with_one_type_each(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.DOCS_SCHEMA["parameters"]["properties"]
    for action in (*DEPTH, "new", "read", "page", "edit"):
        for name in tools.DOCS_ARGS[action]:
            assert name in properties and properties[name].get("description"), f"{action} passes {name}, which the schema does not describe"
    assert all(isinstance(prop.get("type"), str) for prop in properties.values())
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    types = {name: prop["type"] for name, prop in properties.items()}
    assert types["comments"] == "array" and properties["comments"]["items"]["type"] == "object"
    assert types["levels"] == "number"
    booleans = ("differentFirst", "differentOddEven", "resolved", "selection", "all")
    assert {name: types[name] for name in booleans} == dict.fromkeys(booleans, "boolean")
    strings = ("kind", "quote", "field", "note", "section", "comment", "toc", "title", "top", "right", "bottom", "left", "headerDistance", "footerDistance", "content", "format", "align", "at", "mode", "heading", "text", "size", "orientation", "margins", "template", "part")
    assert {name: types[name] for name in strings} == dict.fromkeys(strings, "string")
    # A shared argument says what it means for each new action that takes it.
    meanings = {
        "kind": ("set_header", "clear_footer", "insert_note", "endnote", "insert_section_break", "nextPage"),
        "quote": ("insert_field", "insert_note", "insert_section_break", "insert_toc", "add_comment"),
        "at": ("insert_field", "insert_section_break", "insert_toc", "add_comment"),
        "mode": ("before",),
        "heading": ("list_notes", "list_comments", "statistics", "add_comment", "insert_toc"),
        "text": ("add_comment", "reply_to_comment", "edit_comment"),
        "all": ("add_comment", "delete_comment"),
        "content": ("set_header", "{page}", "{pages}", "{date}", "insert_note", "set_note"),
        "format": ("set_footer", "insert_field", "d MMMM yyyy"),
        "align": ("set_footer",),
        "size": ("new", "insert_section_break", "legal"),
        "part": ("comments", "notes", "headers", "sections", "tocs"),
        "template": ("cv", "project-proposal", "list_templates", "sample text"),
        "section": ("page", "remove_section_break", "all for every section"),
        "comments": ("add_comments", "quote", "heading", "\"all\": true"),
    }
    for name, words in meanings.items():
        for word in words:
            assert word in properties[name]["description"], (name, word)
    for words in ("setHeader", "insertNote", "addComments", "deleteComment", "removeToc", "updateTocs", "headerDistance"):
        assert words in properties["edits"]["description"]


def test_the_description_names_the_new_capabilities(plugin):
    tools = _mod(plugin, "tools")
    description = tools.DOCS_SCHEMA["description"]
    for words in ("headers and footers", "Page {page} of {pages}", "page numbers and fields", "footnotes and endnotes", "sections and page setup", "comments and reviews", "part=comments", "ONE add_comments call", "signed Hermes", "tables of contents", "list_templates", "statistics"):
        assert words in description


def test_a_review_runs_as_one_add_comments_call_in_the_shell(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_docs({"action": "add_comments", "document": "Report.docx", "comments": REVIEW}))
    assert reply["success"] is True
    assert calls == [("docs.addComments", {"document": "Report.docx", "comments": json.dumps(REVIEW)}, tools.OFFICE_TIMEOUT)]
    assert decisions[-1] == ("docs", "act", "add_comments")
    json.loads(tools.handle_docs({"action": "remove_toc", "document": "Report.docx"}))
    assert decisions[-1] == ("docs", "mutate", "remove_toc")
    json.loads(tools.handle_docs({"action": "list_templates", "document": "Report.docx"}))
    assert calls[-1] == ("docs.listTemplates", {}, tools.OFFICE_TIMEOUT) and decisions[-1] == ("docs", "read", "list_templates")


def test_an_older_shell_without_the_new_commands_says_to_update_and_keeps_the_rest(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    calls, _, _ = shell
    older = [entry for entry in CATALOGUE if entry["id"] not in {command for command, _ in DEPTH.values()}]
    monkeypatch.setattr(ui, "list_commands", lambda: older)
    tools._UI_CATALOGUE.clear()
    for action in DEPTH:
        reply = json.loads(tools.handle_docs({"action": action, "content": "x", "text": "x", "note": "footnote 1", "comment": "c1", "comments": REVIEW}))
        assert reply["success"] is False and "update Herald OS" in reply["error"], action
    assert not [command for command, _, _ in calls if command != "office.list"]
    reply = json.loads(tools.handle_docs({"action": "read", "part": "outline"}))
    assert reply["success"] is True and calls[-1][0] == "docs.read"
