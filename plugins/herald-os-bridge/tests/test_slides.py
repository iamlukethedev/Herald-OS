"""The ``slides`` tool: actions to slides.* commands, the tier rules, and a call through the shell."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest


def _mod(plugin, name):
    return importlib.import_module(plugin.__name__ + ".bridge." + name)


CATALOGUE = [
    {"id": "office.list", "title": "What is open in Herald Office", "tier": "read", "args": []},
    {"id": "slides.read", "title": "Read a presentation", "tier": "read", "args": []},
    {"id": "slides.open", "title": "Open Herald Slides", "tier": "act", "args": []},
    {"id": "slides.addSlide", "title": "Add a slide", "tier": "act", "args": []},
    {"id": "slides.setSlide", "title": "Change a slide", "tier": "act", "args": []},
    {"id": "slides.removeSlide", "title": "Remove a slide", "tier": "mutate", "args": []},
    {"id": "slides.edit", "title": "Make several edits in a presentation at once", "tier": "act", "args": []},
    {"id": "slides.fromDocument", "title": "Make slides from a document", "tier": "act", "args": []},
    {"id": "slides.insertRange", "title": "Put a sheet range on a slide", "tier": "act", "args": []},
    {"id": "slides.save", "title": "Save a presentation", "tier": "mutate", "args": []},
    {"id": "slides.exportPdf", "title": "Export a presentation as a PDF", "tier": "act", "args": []},
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
            documents = [{"app": "slides", "name": Path(path).name, "path": path, "format": "pptx", "modified": False, "active": True, "front": True} for path in open_paths]
            return {"ok": True, "summary": "Office: in front is Q3 review.pptx", "data": {"documents": documents}}
        if command == "slides.read":
            return {"ok": True, "summary": "Q3 review.pptx: 2 slides, wide, herald theme", "data": {"name": "Q3 review.pptx", "slideCount": 2, "slides": [{"number": 1, "layout": "title", "title": "Q3 review"}, {"number": 2, "layout": "title-content", "title": "Results", "body": "Revenue up 12%"}]}}
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
    action, command, args = tools.slides_command({"action": "add_slide", "title": "Risks", "body": "Supply\nHiring", "notes": "Two risks", "layout": "title-content", "x": 3, "after": ""})
    assert (action, command) == ("add_slide", "slides.addSlide")
    assert args == {"layout": "title-content", "title": "Risks", "body": "Supply\nHiring", "notes": "Two risks"}
    assert tools.slides_command({"action": "list_all", "presentation": "Deck.pptx"}) == ("list_all", "office.list", {})
    assert tools.slides_command({"action": "list"}) == ("list", "slides.list", {})
    assert all(command.startswith("slides.") for action, command in tools.SLIDES_ACTIONS.items() if action != "list_all")
    with pytest.raises(ValueError, match="from_document"):
        tools.slides_command({"action": "animate"})


def test_slide_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.slides_command({"action": "read", "slide": "3", "text": "x"}) == ("read", "slides.read", {"slide": "3"})
    assert tools.slides_command({"action": "find", "text": "revenue", "caseSensitive": False}) == ("find", "slides.find", {"text": "revenue", "caseSensitive": False})
    assert tools.slides_command({"action": "set_slide", "slide": "Results", "notes": "Pause here", "hidden": False, "background": "accent1", "x": 1}) == ("set_slide", "slides.setSlide", {"slide": "Results", "notes": "Pause here", "hidden": False, "background": "accent1"})
    assert tools.slides_command({"action": "duplicate_slide", "slide": "2", "to": "first"}) == ("duplicate_slide", "slides.duplicateSlide", {"slide": "2"})
    assert tools.slides_command({"action": "move_slide", "slide": "Risks", "to": "first"}) == ("move_slide", "slides.moveSlide", {"slide": "Risks", "to": "first"})
    assert tools.slides_command({"action": "remove_slide", "slide": "4", "title": "x"}) == ("remove_slide", "slides.removeSlide", {"slide": "4"})
    assert tools.slides_command({"action": "add_text", "slide": "1", "text": "Draft", "x": 40, "y": 480, "size": "28", "bold": True, "color": "accent2", "fill": "x"}) == ("add_text", "slides.addText", {"slide": "1", "text": "Draft", "x": 40, "y": 480, "size": "28", "color": "accent2", "bold": True})
    assert tools.slides_command({"action": "add_shape", "kind": "star", "fill": "#ffb347", "text": "New", "width": 80, "height": 80}) == ("add_shape", "slides.addShape", {"kind": "star", "width": 80, "height": 80, "fill": "#ffb347", "text": "New"})
    assert tools.slides_command({"action": "add_image", "slide": "3", "source": "~/Pictures/team.jpg", "fit": "cover", "alt": "x"}) == ("add_image", "slides.addImage", {"slide": "3", "source": "~/Pictures/team.jpg", "fit": "cover"})
    assert tools.slides_command({"action": "set_theme", "theme": "midnight", "size": "wide"}) == ("set_theme", "slides.setTheme", {"theme": "midnight"})
    # An empty replacement is left out, which deletes the matches.
    assert tools.slides_command({"action": "replace", "find": "Q2", "replacement": "", "all": False}) == ("replace", "slides.replace", {"find": "Q2", "all": False})
    assert tools.slides_command({"action": "from_document", "document": "~/Documents/Report.docx", "level": 2, "notes": True, "slide": "1"}) == ("from_document", "slides.fromDocument", {"document": "~/Documents/Report.docx", "level": 2, "notes": True})
    assert tools.slides_command({"action": "insert_range", "slide": "Budget", "workbook": "Budget.xlsx", "range": "A1:D6", "sheet": "2026"}) == ("insert_range", "slides.insertRange", {"slide": "Budget", "workbook": "Budget.xlsx", "range": "A1:D6", "sheet": "2026"})
    assert tools.slides_command({"action": "save", "to": "~/Documents/Q3.pptx", "overwrite": True}) == ("save", "slides.save", {"to": "~/Documents/Q3.pptx", "overwrite": True})
    assert tools.slides_command({"action": "undo", "steps": 2, "slide": "1"}) == ("undo", "slides.undo", {"steps": 2})


def test_decks_tables_bodies_and_edits_travel_as_json(plugin):
    tools = _mod(plugin, "tools")
    deck = [{"layout": "title", "title": "Q3 review", "body": "Finance team"}, {"title": "Results", "body": "Revenue up 12%\nCosts flat", "notes": "Lead with revenue"}]
    _, command, args = tools.slides_command({"action": "new", "name": "Q3 review", "slides": deck, "theme": "paper", "size": "wide"})
    assert command == "slides.new" and json.loads(args.pop("slides")) == deck
    assert args == {"name": "Q3 review", "theme": "paper", "size": "wide"}
    cells = [["Item", "Cost"], ["Rent", "1,200"]]
    _, command, args = tools.slides_command({"action": "add_table", "slide": "Costs", "cells": cells, "width": 720})
    assert command == "slides.addTable" and json.loads(args["cells"]) == cells
    # Two columns are a list of two bodies; one body stays text.
    _, _, args = tools.slides_command({"action": "set_slide", "slide": "Options", "layout": "two-content", "body": ["Pros\nFast", "Cons\nCostly"]})
    assert json.loads(args["body"]) == ["Pros\nFast", "Cons\nCostly"]
    assert tools.slides_command({"action": "add_slide", "body": "One\n  Deeper"})[2] == {"body": "One\n  Deeper"}
    edits = [{"op": "addSlide", "title": "Risks", "body": "Supply\nHiring"}, {"op": "setTheme", "theme": "paper"}]
    _, command, args = tools.slides_command({"action": "edit", "presentation": "Q3 review", "edits": edits})
    assert command == "slides.edit" and json.loads(args["edits"]) == edits and args["presentation"] == "Q3 review"
    text = '[{"op": "duplicateSlide", "slide": "2"}]'
    assert tools.slides_command({"action": "edit", "edits": text}) == ("edit", "slides.edit", {"edits": text})


def test_the_schema_offers_every_action_and_argument(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.SLIDES_SCHEMA["parameters"]["properties"]
    assert set(tools.SLIDES_ARGS) == set(tools.SLIDES_ACTIONS)
    assert properties["action"]["enum"] == list(tools.SLIDES_ACTIONS)
    for action, names in tools.SLIDES_ARGS.items():
        for name in names:
            assert name in properties, f"{action} passes {name}, which the schema does not describe"
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    assert properties["slides"]["type"] == "array" and properties["slides"]["items"]["type"] == "object"
    assert properties["edits"]["type"] == "array" and properties["edits"]["items"]["type"] == "object"
    assert properties["cells"]["type"] == "array" and properties["cells"]["items"]["type"] == "array"
    assert properties["x"]["type"] == "number" and properties["hidden"]["type"] == "boolean"
    # new takes a slide size and add_text a font size, and from_document's notes is a yes or no.
    assert properties["size"]["type"] == "string" and "wide" in properties["size"]["description"]
    assert properties["notes"]["type"] == "string" and "from_document" in properties["notes"]["description"]


def test_the_description_teaches_the_workflow_and_points_to_the_skill(plugin):
    tools = _mod(plugin, "tools")
    description = tools.SLIDES_SCHEMA["description"]
    assert 'skill_view name="herald-os-bridge:herald-slides"' in description
    for words in ("Read before you change anything", "list_all", "action=new", "from_document", "insert_range", "action=edit", "one step the person can undo", "Never save unless the person asks", "tab"):
        assert words in description
    assert "slides tools" in tools.OS_UI_SCHEMA["description"]


def test_saving_exporting_and_closed_files_raise_the_tier(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    deck = tmp_path / "Q3 review.pptx"
    deck.write_bytes(b"pptx")
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")

    def tier(action, command, args, open_paths=()):
        return tools.office_tier(action, command, args, catalogue, open_paths).value

    assert tier("save", "slides.save", {}) == "destructive"
    assert tier("save", "slides.save", {"to": str(deck)}) == "destructive"
    assert tier("save", "slides.save", {"to": str(tmp_path / "Q3 v2.pptx")}) == "mutate"
    assert tier("export_pdf", "slides.exportPdf", {"presentation": str(deck)}) == "act"
    assert tier("export_pdf", "slides.exportPdf", {"to": str(report), "overwrite": True}) == "destructive"
    assert tier("add_slide", "slides.addSlide", {"presentation": str(deck), "title": "Risks"}) == "destructive"
    assert tier("add_slide", "slides.addSlide", {"presentation": str(deck), "title": "Risks"}, {str(deck)}) == "act"
    assert tier("open", "slides.open", {"path": str(deck)}) == "act"
    assert tier("read", "slides.read", {"presentation": str(deck)}) == "read"
    # The document slides are made from, and the workbook a range comes from, are only read.
    assert tier("from_document", "slides.fromDocument", {"document": str(report)}) == "act"
    assert tier("from_document", "slides.fromDocument", {"document": str(report), "presentation": str(deck)}) == "destructive"
    assert tier("insert_range", "slides.insertRange", {"workbook": str(budget), "range": "A1:D6"}) == "act"
    assert tier("remove_slide", "slides.removeSlide", {"slide": "4"}) == "mutate"
    assert tier("remove_slide", "slides.removeSlide", {"presentation": str(deck), "slide": "4"}) == "destructive"


def test_an_edit_that_removes_a_slide_asks_as_removing_it_does(plugin):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}

    def tier(edits):
        return tools.office_tier("edit", "slides.edit", {"edits": edits}, catalogue, ()).value

    assert tier(json.dumps([{"op": "addSlide", "title": "Risks"}, {"op": "setSlide", "slide": "2", "notes": "x"}])) == "act"
    assert tier(json.dumps([{"op": "addSlide", "title": "Risks"}, {"op": "removeSlide", "slide": "3"}])) == "mutate"
    assert tier([{"op": "removeSlide", "slide": "3"}]) == "mutate"
    # Ops the shell has no command of its own for, and edits it cannot read, keep the batch's tier.
    assert tier(json.dumps([{"op": "addText", "text": "x"}, {"slide": "2"}])) == "act"
    assert tier("[{not json") == "act"


def test_a_call_runs_in_the_shell_with_a_long_timeout(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_slides({"action": "read", "presentation": "Q3 review"}))
    assert reply["success"] is True and reply["data"]["slides"][1]["title"] == "Results"
    assert reply["result"] == "Q3 review.pptx: 2 slides, wide, herald theme"
    assert calls == [("slides.read", {"presentation": "Q3 review"}, tools.OFFICE_TIMEOUT)]
    assert calls[-1][2] >= 60
    assert decisions[-1] == ("slides", "read", "read")
    json.loads(tools.handle_slides({"action": "list_all"}))
    assert calls[-1][0] == "office.list" and decisions[-1] == ("slides", "read", "list_all")


def test_a_change_to_a_presentation_file_asks_unless_it_is_open(plugin, shell, tmp_path):
    tools = _mod(plugin, "tools")
    calls, decisions, open_paths = shell
    deck = tmp_path / "Q3 review.pptx"
    deck.write_bytes(b"pptx")
    reply = json.loads(tools.handle_slides({"action": "add_slide", "presentation": str(deck), "title": "Risks", "body": "Supply\nHiring"}))
    assert reply["success"] is True
    assert [command for command, _, _ in calls] == ["office.list", "slides.addSlide"]
    assert decisions[-1] == ("slides", "destructive", "add_slide")
    open_paths.append(str(deck))
    json.loads(tools.handle_slides({"action": "add_slide", "presentation": str(deck), "title": "Risks"}))
    assert decisions[-1] == ("slides", "act", "add_slide")
    # A deck made from a document file names no presentation file, so nothing asks what is open.
    report = tmp_path / "Report.docx"
    report.write_bytes(b"docx")
    calls.clear()
    json.loads(tools.handle_slides({"action": "from_document", "document": str(report), "notes": True}))
    assert [command for command, _, _ in calls] == ["slides.fromDocument"]
    assert decisions[-1] == ("slides", "act", "from_document")


def test_a_shell_without_herald_slides_says_to_update(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    monkeypatch.setattr(ui, "list_commands", lambda: [{"id": "page.open", "tier": "read"}])
    tools._UI_CATALOGUE.clear()
    reply = json.loads(tools.handle_slides({"action": "read"}))
    assert reply["success"] is False and "Herald Slides" in reply["error"] and "update Herald OS" in reply["error"]
