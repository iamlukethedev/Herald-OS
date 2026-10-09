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
    {"id": "slides.setTheme", "title": "Change a presentation’s theme", "tier": "act", "args": []},
    {"id": "slides.addShape", "title": "Add a shape to a slide", "tier": "act", "args": []},
]

# The master and layouts, themes, transitions, groups, connectors, borders, fills and slides from a
# sheet, by action, with the command and tier the shell registers for each.
DEPTH = {
    "read_master": ("slides.readMaster", "read"),
    "set_background": ("slides.setBackground", "act"),
    "add_master_text": ("slides.addMasterText", "act"),
    "add_master_shape": ("slides.addMasterShape", "act"),
    "add_master_image": ("slides.addMasterImage", "act"),
    "add_logo": ("slides.addLogo", "act"),
    "remove_from_master": ("slides.removeFromMaster", "mutate"),
    "set_placeholder": ("slides.setPlaceholder", "act"),
    "show_master_graphics": ("slides.showMasterGraphics", "act"),
    "rename_layout": ("slides.renameLayout", "act"),
    "reset_master": ("slides.resetMaster", "mutate"),
    "set_header_footer": ("slides.setHeaderFooter", "act"),
    "list_themes": ("slides.listThemes", "read"),
    "make_theme": ("slides.makeTheme", "act"),
    "delete_theme": ("slides.deleteTheme", "mutate"),
    "set_transition": ("slides.setTransition", "act"),
    "group": ("slides.group", "act"),
    "ungroup": ("slides.ungroup", "act"),
    "rotate": ("slides.rotate", "act"),
    "convert_to_shapes": ("slides.convertToShapes", "act"),
    "add_connector": ("slides.addConnector", "act"),
    "connection_sites": ("slides.connectionSites", "read"),
    "set_cell_borders": ("slides.setCellBorders", "act"),
    "set_fill": ("slides.setFill", "act"),
    "add_slide_from_sheet": ("slides.addSlideFromSheet", "act"),
}

CATALOGUE += [{"id": command, "title": command, "tier": tier, "args": []} for command, tier in DEPTH.values()]

# What removes something the person made: the master's and layouts' elements, the master itself, a custom theme.
REMOVALS = ("remove_from_master", "reset_master", "delete_theme")


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


def test_the_masters_themes_transitions_groups_connectors_borders_fills_and_sheets_map_to_their_commands(plugin):
    tools = _mod(plugin, "tools")
    for action, (command, tier) in DEPTH.items():
        assert tools.SLIDES_ACTIONS[action] == command
        assert tools.slides_command({"action": action})[:2] == (action, command)
        # Reading reads, taking away what the person made asks, and the rest acts.
        assert tier == ("read" if action in ("read_master", "list_themes", "connection_sites") else "mutate" if action in REMOVALS else "act"), action
    phase3 = {"read": "slides.read", "set_theme": "slides.setTheme", "add_shape": "slides.addShape", "edit": "slides.edit", "from_document": "slides.fromDocument", "insert_range": "slides.insertRange", "save": "slides.save"}
    assert {action: tools.SLIDES_ACTIONS[action] for action in phase3} == phase3


def test_master_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.slides_command({"action": "read_master", "presentation": "Q3.pptx", "layout": "title", "slide": "2"}) == ("read_master", "slides.readMaster", {"presentation": "Q3.pptx", "layout": "title"})
    _, command, args = tools.slides_command({"action": "set_background", "slide": "2, 4-6", "gradient": "navy to teal", "angle": 45, "radial": False, "kind": "x"})
    assert (command, args) == ("slides.setBackground", {"slide": "2, 4-6", "gradient": "navy to teal", "angle": 45, "radial": False})
    assert tools.slides_command({"action": "set_background", "layout": "master", "background": "#f2fafc"})[2] == {"layout": "master", "background": "#f2fafc"}
    assert tools.slides_command({"action": "set_background", "layout": "section", "source": "~/Pictures/wave.png"})[2] == {"layout": "section", "source": "~/Pictures/wave.png"}
    assert tools.slides_command({"action": "add_master_text", "text": "Confidential", "x": 40, "y": 500, "size": "12", "color": "text2", "slide": "1"}) == ("add_master_text", "slides.addMasterText", {"text": "Confidential", "x": 40, "y": 500, "size": "12", "color": "text2"})
    _, command, args = tools.slides_command({"action": "add_master_shape", "layout": "title", "kind": "rect", "x": 0, "y": 0, "width": 960, "height": 24, "gradient": "accent1 to accent2", "source": "x"})
    assert (command, args) == ("slides.addMasterShape", {"layout": "title", "kind": "rect", "x": 0, "y": 0, "width": 960, "height": 24, "gradient": "accent1 to accent2"})
    assert tools.slides_command({"action": "add_master_image", "source": "~/Pictures/grain.png", "fit": "slide", "corner": "x"})[2] == {"source": "~/Pictures/grain.png", "fit": "slide"}
    assert tools.slides_command({"action": "add_logo", "source": "~/Pictures/logo.png", "corner": "bottom-right", "width": 80, "x": 3}) == ("add_logo", "slides.addLogo", {"source": "~/Pictures/logo.png", "corner": "bottom-right", "width": 80})
    _, command, args = tools.slides_command({"action": "set_placeholder", "layout": "two-content", "role": "body", "which": 2, "y": 150, "font": "heading", "size": "20", "italic": True, "anchor": "middle", "text": "x"})
    assert (command, args) == ("slides.setPlaceholder", {"layout": "two-content", "role": "body", "which": 2, "y": 150, "font": "heading", "size": "20", "italic": True, "anchor": "middle"})
    assert tools.slides_command({"action": "show_master_graphics", "show": False, "slide": "1", "kind": "x"})[2] == {"show": False, "slide": "1"}
    assert tools.slides_command({"action": "rename_layout", "layout": "title-content", "name": "Bullets", "theme": "x"})[2] == {"layout": "title-content", "name": "Bullets"}
    assert tools.slides_command({"action": "reset_master", "presentation": "Q3", "layout": "title"}) == ("reset_master", "slides.resetMaster", {"presentation": "Q3"})
    _, command, args = tools.slides_command({"action": "set_header_footer", "date": True, "dateFormat": "dmy", "dateText": "", "number": True, "footer": "Acme · Confidential", "skipTitle": True, "text": "x"})
    assert (command, args) == ("slides.setHeaderFooter", {"date": True, "dateFormat": "dmy", "number": True, "footer": "Acme · Confidential", "skipTitle": True})


def test_theme_transition_group_connector_border_fill_and_sheet_actions_pass_their_arguments(plugin):
    tools = _mod(plugin, "tools")
    assert tools.slides_command({"action": "list_themes", "presentation": "Q3", "theme": "x"}) == ("list_themes", "slides.listThemes", {})
    _, command, args = tools.slides_command({"action": "make_theme", "name": "Brand", "from": "ocean", "colors": {"accent1": "#0b7d97"}, "headingFont": "Georgia", "bodyFont": "Avenir Next", "apply": True, "slide": "all", "theme": "x"})
    assert command == "slides.makeTheme" and json.loads(args.pop("colors")) == {"accent1": "#0b7d97"}
    assert args == {"name": "Brand", "from": "ocean", "headingFont": "Georgia", "bodyFont": "Avenir Next", "apply": True, "slide": "all"}
    assert tools.slides_command({"action": "delete_theme", "theme": "custom-brand", "name": "x"}) == ("delete_theme", "slides.deleteTheme", {"theme": "custom-brand"})
    assert tools.slides_command({"action": "set_transition", "slide": "all", "kind": "push", "direction": "left", "duration": 0.75, "orientation": "vertical", "degrees": 3}) == ("set_transition", "slides.setTransition", {"slide": "all", "kind": "push", "direction": "left", "duration": 0.75, "orientation": "vertical"})
    _, command, args = tools.slides_command({"action": "group", "slide": "2", "elements": ["shape-1", "shape-2"], "degrees": 3})
    assert command == "slides.group" and json.loads(args.pop("elements")) == ["shape-1", "shape-2"] and args == {"slide": "2"}
    assert tools.slides_command({"action": "ungroup", "elements": "group-1"})[2] == {"elements": "group-1"}
    assert tools.slides_command({"action": "rotate", "elements": "3, 4", "degrees": -30})[2] == {"elements": "3, 4", "degrees": -30}
    assert tools.slides_command({"action": "convert_to_shapes", "slide": "5"}) == ("convert_to_shapes", "slides.convertToShapes", {"slide": "5"})
    _, command, args = tools.slides_command({"action": "add_connector", "from": "shape-1", "to": "shape-2", "fromSite": 3, "toSite": 1, "kind": "elbow", "arrow": "both", "color": "accent2", "width": 3, "dash": "dash", "elements": ["x"]})
    assert (command, args) == ("slides.addConnector", {"from": "shape-1", "to": "shape-2", "fromSite": 3, "toSite": 1, "kind": "elbow", "arrow": "both", "color": "accent2", "width": 3, "dash": "dash"})
    assert tools.slides_command({"action": "connection_sites", "element": "shape-1", "elements": ["x"]})[2] == {"element": "shape-1"}
    _, command, args = tools.slides_command({"action": "set_cell_borders", "slide": "3", "element": "table-1", "range": "A1:C1", "sides": "bottom", "color": "accent1", "width": 2, "dash": "solid", "fill": "x"})
    assert (command, args) == ("slides.setCellBorders", {"slide": "3", "element": "table-1", "range": "A1:C1", "sides": "bottom", "color": "accent1", "width": 2, "dash": "solid"})
    _, command, args = tools.slides_command({"action": "set_fill", "elements": ["shape-1"], "gradient": "#13204a, #2563eb 60%, white", "angle": 0, "radial": True, "background": "x"})
    assert command == "slides.setFill" and json.loads(args.pop("elements")) == ["shape-1"] and args == {"gradient": "#13204a, #2563eb 60%, white", "angle": 0, "radial": True}
    _, command, args = tools.slides_command({"action": "add_slide_from_sheet", "workbook": "~/Documents/Budget.xlsx", "range": "A1:D9", "sheet": "2026", "title": "Budget", "header": False, "after": "Costs", "slide": "x"})
    assert (command, args) == ("slides.addSlideFromSheet", {"workbook": "~/Documents/Budget.xlsx", "range": "A1:D9", "sheet": "2026", "title": "Budget", "header": False, "after": "Costs"})


def test_phase3_actions_keep_their_arguments_and_take_their_new_ones(plugin):
    tools = _mod(plugin, "tools")
    assert tools.slides_command({"action": "set_theme", "theme": "custom-brand", "slide": "2, 3"}) == ("set_theme", "slides.setTheme", {"theme": "custom-brand", "slide": "2, 3"})
    assert tools.slides_command({"action": "set_theme", "theme": "midnight"})[2] == {"theme": "midnight"}
    _, command, args = tools.slides_command({"action": "add_shape", "kind": "flowChartDecision", "gradient": "accent1 to accent2", "angle": 90, "radial": False, "text": "Ship?"})
    assert (command, args) == ("slides.addShape", {"kind": "flowChartDecision", "gradient": "accent1 to accent2", "angle": 90, "radial": False, "text": "Ship?"})
    assert tools.slides_command({"action": "insert_range", "slide": "new", "workbook": "Budget.xlsx", "range": "selection", "header": True})[2] == {"slide": "new", "workbook": "Budget.xlsx", "range": "selection"}
    assert tools.SLIDES_ARGS["from_document"] == ("document", "presentation", "level", "notes")
    assert tools.SLIDES_ARGS["insert_range"] == ("presentation", "slide", "workbook", "range", "sheet", "x", "y", "width")


def test_edits_with_the_new_ops_and_a_themes_colours_travel_as_json(plugin):
    tools = _mod(plugin, "tools")
    edits = [
        {"op": "setHeaderFooter", "number": True, "skipTitle": True},
        {"op": "addLogo", "source": "~/Pictures/logo.png", "corner": "bottom-right"},
        {"op": "setTransition", "slide": "all", "kind": "fade"},
        {"op": "addConnector", "from": "3", "to": "4", "kind": "elbow"},
        {"op": "group", "elements": ["3", "4", "5"]},
    ]
    _, command, args = tools.slides_command({"action": "edit", "presentation": "Q3 review", "edits": edits, "elements": ["x"]})
    assert command == "slides.edit" and json.loads(args.pop("edits")) == edits and args == {"presentation": "Q3 review"}
    # Elements and colours the model wrote as JSON text pass through as they are.
    assert tools.slides_command({"action": "group", "elements": '["shape-1", "shape-2"]'})[2] == {"elements": '["shape-1", "shape-2"]'}
    assert tools.slides_command({"action": "make_theme", "name": "Calm", "colors": '{"accent1": "#123456"}'})[2] == {"name": "Calm", "colors": '{"accent1": "#123456"}'}


def test_reads_read_changes_act_removals_ask_and_a_closed_file_asks_every_time(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}
    deck = tmp_path / "Q3 review.pptx"
    deck.write_bytes(b"pptx")
    budget = tmp_path / "Budget.xlsx"
    budget.write_bytes(b"xlsx")
    for action, (command, tier) in DEPTH.items():
        _, _, args = tools.slides_command({"action": action, "elements": ["shape-1"], "theme": "custom-brand", "name": "Brand", "kind": "fade"})
        assert tools.office_tier(action, command, args, catalogue, ()).value == tier, action
        if "presentation" not in tools.SLIDES_ARGS[action]:
            continue
        # A file that is not open is changed on disk, which asks every time; reading it does not.
        on_disk = tools.office_tier(action, command, {**args, "presentation": str(deck)}, catalogue, ()).value
        assert on_disk == ("read" if tier == "read" else "destructive"), action
        assert tools.office_tier(action, command, {**args, "presentation": str(deck)}, catalogue, {str(deck)}).value == tier, action
    # The workbook a slide comes from is only read; the theme store is not a presentation.
    assert tools.office_tier("add_slide_from_sheet", "slides.addSlideFromSheet", {"workbook": str(budget)}, catalogue, ()).value == "act"
    assert tools.office_tier("delete_theme", "slides.deleteTheme", {"theme": "custom-brand"}, catalogue, ()).value == "mutate"
    assert tools.office_tier("set_theme", "slides.setTheme", {"theme": "midnight", "slide": "2"}, catalogue, ()).value == "act"


def test_an_edit_that_takes_something_off_the_master_asks_as_taking_it_off_does(plugin, tmp_path):
    tools = _mod(plugin, "tools")
    catalogue = {entry["id"]: entry for entry in CATALOGUE}

    def tier(*edits, presentation=None, open_paths=()):
        _, command, args = tools.slides_command({"action": "edit", "presentation": presentation, "edits": list(edits)})
        return tools.office_tier("edit", command, args, catalogue, open_paths).value

    footer = {"op": "setHeaderFooter", "number": True}
    assert tier(footer, {"op": "addLogo", "source": "~/logo.png"}, {"op": "setTransition", "kind": "fade"}, {"op": "group", "elements": "3, 4"}, {"op": "setFill", "elements": "3", "fill": "navy"}) == "act"
    for removal in ({"op": "removeFromMaster", "elements": "1"}, {"op": "resetMaster"}):
        assert tier(footer, removal) == "mutate", removal["op"]
    # The shell takes an op in any case and with spaces round it, and so does the tier.
    for spelling in ("removefrommaster", " RemoveFromMaster ", "RESETMASTER", " resetmaster"):
        assert tier(footer, {"op": spelling}) == "mutate", spelling
    _, command, args = tools.slides_command({"action": "edit", "edits": '[{"op": "resetMaster"}]'})
    assert tools.office_tier("edit", command, args, catalogue, ()).value == "mutate"
    # On a file that is not open the batch is written to disk, which asks every time.
    deck = tmp_path / "Q3 review.pptx"
    deck.write_bytes(b"pptx")
    assert tier({"op": "resetMaster"}, presentation=str(deck)) == "destructive"
    assert tier({"op": "resetMaster"}, presentation=str(deck), open_paths={str(deck)}) == "mutate"
    assert tier(footer, presentation=str(deck), open_paths={str(deck)}) == "act"


def test_the_schema_describes_the_new_arguments_with_one_type_each(plugin):
    tools = _mod(plugin, "tools")
    properties = tools.SLIDES_SCHEMA["parameters"]["properties"]
    for action in (*DEPTH, "set_theme", "add_shape", "insert_range", "edit"):
        for name in tools.SLIDES_ARGS[action]:
            assert name in properties and properties[name].get("description"), f"{action} passes {name}, which the schema does not describe"
    assert all(isinstance(prop.get("type"), str) for prop in properties.values())
    assert [name for name, prop in properties.items() if "enum" in prop] == ["action"]
    types = {name: prop["type"] for name, prop in properties.items()}
    assert types["elements"] == "array" and properties["elements"]["items"]["type"] == "string"
    assert types["colors"] == "object" and properties["colors"]["additionalProperties"]["type"] == "string"
    numbers = ("angle", "which", "duration", "degrees", "fromSite", "toSite", "x", "y", "width", "height", "level")
    assert {name: types[name] for name in numbers} == dict.fromkeys(numbers, "number")
    booleans = ("radial", "italic", "show", "date", "number", "skipTitle", "apply", "header", "bold")
    assert {name: types[name] for name in booleans} == dict.fromkeys(booleans, "boolean")
    strings = ("gradient", "element", "role", "font", "anchor", "corner", "dateFormat", "dateText", "footer", "from", "to", "headingFont", "bodyFont", "direction", "orientation", "arrow", "dash", "sides", "kind", "size", "theme", "slide", "background", "fill", "notes", "layout", "name", "source", "range", "title", "after")
    assert {name: types[name] for name in strings} == dict.fromkeys(strings, "string")
    # A shared argument says what it means for each new action that takes it.
    meanings = {
        "kind": ("add_master_shape", "flowchart", "stars", "arrows", "brackets", "math", "callouts", "set_transition", "zoom", "add_connector", "elbow"),
        "theme": ("aurora", "dune", "slate", "blossom", "ember", "custom theme", "delete_theme"),
        "slide": ("set_transition", "set_background", "show_master_graphics", "make_theme", "all", "insert_range: new"),
        "layout": ("read_master", "add_master_text", "add_logo", "set_placeholder", "remove_from_master", "master", "set_background", "show_master_graphics", "rename_layout"),
        "background": ("set_background", "none", "make_theme"),
        "source": ("add_master_image", "add_logo", "set_background"),
        "width": ("add_logo", "add_connector", "set_cell_borders"),
        "color": ("set_placeholder", "add_connector", "set_cell_borders"),
        "range": ("add_slide_from_sheet", "set_cell_borders", "row 1"),
        "to": ("add_connector",),
        "from": ("make_theme", "add_connector"),
        "name": ("rename_layout", "make_theme"),
        "elements": ("group", "remove_from_master", "read_master"),
    }
    for name, words in meanings.items():
        for word in words:
            assert word in properties[name]["description"], (name, word)
    for words in ("setBackground", "addLogo", "removeFromMaster", "resetMaster", "setHeaderFooter", "setTransition", "addConnector", "setCellBorders", "setFill", "addSlideFromSheet", "gradient"):
        assert words in properties["edits"]["description"]
    # The 22 shapes Phase 3 knew are no longer the whole list.
    assert "rtTriangle, diamond, parallelogram, trapezoid" not in properties["kind"]["description"]


def test_the_description_names_the_new_capabilities(plugin):
    tools = _mod(plugin, "tools")
    description = tools.SLIDES_SCHEMA["description"]
    for words in ("slide master and its layouts", "read_master", "add_logo", "set_header_footer", "slide numbers", "rather than every slide", "list_themes", "make_theme", "set_transition", "group", "add_connector", "set_cell_borders", "gradients", "add_slide_from_sheet"):
        assert words in description, words


def test_a_removal_from_the_master_runs_in_the_shell_and_asks(plugin, shell):
    tools = _mod(plugin, "tools")
    calls, decisions, _ = shell
    reply = json.loads(tools.handle_slides({"action": "remove_from_master", "presentation": "Q3 review", "elements": ["image-1"]}))
    assert reply["success"] is True
    assert calls == [("slides.removeFromMaster", {"presentation": "Q3 review", "elements": json.dumps(["image-1"])}, tools.OFFICE_TIMEOUT)]
    assert decisions[-1] == ("slides", "mutate", "remove_from_master")
    json.loads(tools.handle_slides({"action": "list_themes"}))
    assert calls[-1] == ("slides.listThemes", {}, tools.OFFICE_TIMEOUT) and decisions[-1] == ("slides", "read", "list_themes")
    json.loads(tools.handle_slides({"action": "make_theme", "name": "Brand", "colors": {"accent1": "#0b7d97"}}))
    assert calls[-1] == ("slides.makeTheme", {"name": "Brand", "colors": json.dumps({"accent1": "#0b7d97"})}, tools.OFFICE_TIMEOUT) and decisions[-1] == ("slides", "act", "make_theme")


def test_an_older_shell_without_the_new_commands_says_to_update_and_keeps_the_rest(plugin, shell, monkeypatch):
    tools = _mod(plugin, "tools")
    ui = _mod(plugin, "ui")
    calls, _, _ = shell
    older = [entry for entry in CATALOGUE if entry["id"] not in {command for command, _ in DEPTH.values()}]
    monkeypatch.setattr(ui, "list_commands", lambda: older)
    tools._UI_CATALOGUE.clear()
    for action in DEPTH:
        reply = json.loads(tools.handle_slides({"action": action, "elements": ["shape-1"], "name": "Brand", "theme": "custom-brand", "kind": "fade"}))
        assert reply["success"] is False and "update Herald OS" in reply["error"], action
    assert not [command for command, _, _ in calls if command != "office.list"]
    reply = json.loads(tools.handle_slides({"action": "read", "presentation": "Q3 review"}))
    assert reply["success"] is True and calls[-1][0] == "slides.read"
