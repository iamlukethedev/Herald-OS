"""Pure helpers in the herald-os CLI (linux/bin/herald-os), loaded as a module."""

import importlib.machinery
import importlib.util
import io
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_LOADER = importlib.machinery.SourceFileLoader("herald_os_cli", str(ROOT / "linux" / "bin" / "herald-os"))
_SPEC = importlib.util.spec_from_loader("herald_os_cli", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

TEMPLATE = (ROOT / "linux" / "niri" / "config.kdl").read_text()


def binds(config: str) -> dict[str, str]:
    """Key -> the rest of the line, for every bind line in the binds block."""
    out: dict[str, str] = {}
    inside = False
    for line in config.splitlines():
        stripped = line.strip()
        if stripped.startswith("binds {"):
            inside = True
            continue
        if inside and stripped == "}":
            break
        if inside and stripped and not stripped.startswith("//"):
            key, _, rest = stripped.partition(" ")
            assert key not in out, f"duplicate bind {key}"
            out[key] = rest
    return out


def test_canvas_words_become_canvas_commands(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    here = tmp_path.resolve()
    assert cli.canvas_request([]) == ("canvas.open", {})
    assert cli.canvas_request(["open", "photo.jpg"]) == ("canvas.open", {"path": str(here / "photo.jpg")})
    assert cli.canvas_request(["new", "Gig", "poster", "1080x1350"]) == ("canvas.new", {"name": "Gig poster", "width": 1080, "height": 1350})
    assert cli.canvas_request(["preview", "--size", "640"]) == ("canvas.preview", {"size": 640})
    command, payload = cli.canvas_request(["export", "out.png", "--project", "Poster.comp", "--scale", "0.5", "--overwrite"])
    assert command == "canvas.export"
    assert payload == {"to": str(here / "out.png"), "project": str(here / "Poster.comp"), "scale": 0.5, "overwrite": True}
    assert cli.canvas_request(["text", "Night", "market", "--size", "120", "--font", "Helvetica Neue Bold", "--x", "72"]) == ("canvas.addText", {"content": "Night market", "size": 120.0, "x": 72.0, "font": "Helvetica Neue Bold"})
    assert cli.canvas_request(["resize", "1080x1080", "--anchor", "top"]) == ("canvas.resize", {"width": 1080, "height": 1080, "anchor": "top"})
    assert cli.canvas_request(["resize", "--scale", "0.5"]) == ("canvas.resize", {"scale": 0.5})
    assert cli.canvas_request(["resize", "800x600", "--image"]) == ("canvas.resize", {"width": 800, "height": 600, "image": True})
    assert cli.canvas_request(["crop", "0", "100", "1080", "1350"]) == ("canvas.crop", {"x": 0, "y": 100, "width": 1080, "height": 1350})
    assert cli.canvas_request(["mask", "Photo", "hide-selection"]) == ("canvas.mask", {"layer": "Photo", "action": "hideSelection"})
    assert cli.canvas_request(["mask", "Sky glow", "invert", "--project", "Poster.comp"]) == ("canvas.mask", {"layer": "Sky glow", "action": "invert", "project": str(here / "Poster.comp")})
    assert cli.canvas_request(["remove-background"]) == ("canvas.removeBackground", {})
    assert cli.canvas_request(["remove-background", "Band", "photo", "--cutout"]) == ("canvas.removeBackground", {"layer": "Band photo", "mode": "cutout"})
    assert cli.canvas_request(["fill", "10", "20", "300", "200", "--layer", "Photo", "--new-layer"]) == ("canvas.contentFill", {"x": 10, "y": 20, "width": 300, "height": 200, "layer": "Photo", "newLayer": True})
    assert cli.canvas_request(["align", "bottom", "right", "--layers", "Logo", "--margin", "48"]) == ("canvas.align", {"edge": "bottom,right", "layers": "Logo", "margin": 48.0})
    assert cli.canvas_request(["align", "center", "--to", "canvas"]) == ("canvas.align", {"edge": "center", "to": "canvas"})
    assert cli.canvas_request(["distribute", "horizontal", "--layers", "A,B,C"]) == ("canvas.align", {"distribute": "horizontal", "layers": "A,B,C"})
    assert cli.canvas_request(["crop", "--ratio", "4:5"]) == ("canvas.crop", {"ratio": "4:5"})
    assert cli.canvas_request(["crop", "--angle", "-2.5", "--ratio", "1:1"]) == ("canvas.crop", {"ratio": "1:1", "angle": -2.5})
    assert cli.canvas_request(["crop", "0", "0", "800", "800", "--ratio", "16:9"]) == ("canvas.crop", {"x": 0, "y": 0, "width": 800, "height": 800, "ratio": "16:9"})
    assert cli.canvas_request(["auto"]) == ("canvas.autoAdjust", {})
    assert cli.canvas_request(["auto", "color", "--cutoff", "0.5"]) == ("canvas.autoAdjust", {"kind": "color", "cutoff": 0.5})
    command, payload = cli.canvas_request(["filter", "unsharp", "mask", "--amount", "120", "--radius", "1.5", "--layer", "Photo"])
    assert (command, payload["kind"], payload["layer"], json.loads(payload["settings"])) == ("canvas.filter", "unsharp mask", "Photo", {"amount": 120.0, "radius": 1.5})
    assert cli.canvas_request(["filter", "median"]) == ("canvas.filter", {"kind": "median"})
    assert cli.canvas_request(["guides"]) == ("canvas.guides", {"action": "list"})
    assert cli.canvas_request(["guides", "add", "vertical", "50%"]) == ("canvas.guides", {"action": "add", "axis": "vertical", "position": "50%"})
    assert cli.canvas_request(["guides", "add", "--margins", "6%", "--columns", "12", "--gutter", "20", "--center"]) == ("canvas.guides", {"action": "add", "margins": "6%", "columns": 12.0, "gutter": 20.0, "center": True})
    assert cli.canvas_request(["guides", "remove", "horizontal", "300"]) == ("canvas.guides", {"action": "remove", "axis": "horizontal", "position": "300"})
    assert cli.canvas_request(["history"]) == ("canvas.history", {})
    assert cli.canvas_request(["undo", "--steps", "3"]) == ("canvas.undo", {"steps": 3})
    assert cli.canvas_request(["redo", "Poster.comp"]) == ("canvas.redo", {"project": str(here / "Poster.comp")})
    for wrong in (["paint"], ["text"], ["resize"], ["crop", "1", "2"], ["mask", "Photo"], ["mask", "Photo", "feather"], ["fill", "1", "2", "3"], ["align"], ["distribute"], ["guides", "paint"], ["guides", "add", "vertical"], ["guides", "clear", "x"], ["filter"]):
        with pytest.raises(SystemExit):
            cli.canvas_request(wrong)


def test_docs_words_become_docs_commands(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    here = tmp_path.resolve()
    (tmp_path / "Report.docx").write_bytes(b"docx")
    report = str(here / "Report.docx")
    assert cli.docs_request([]) == ("docs.open", {})
    assert cli.docs_request(["open", "Report.docx"]) == ("docs.open", {"path": report})
    assert cli.docs_request(["new", "Trip", "notes", "--template", "meeting notes", "--path", "Trip.docx"]) == ("docs.new", {"name": "Trip notes", "template": "meeting notes", "path": str(here / "Trip.docx")})
    assert cli.docs_request(["list"]) == ("docs.list", {})
    # A file that is there, or a path, becomes absolute; anything else is an open document's tab name.
    assert cli.docs_request(["read", "Report.docx", "--part", "outline"]) == ("docs.read", {"document": report, "part": "outline"})
    assert cli.docs_request(["read", "Untitled", "2", "--heading", "Costs"]) == ("docs.read", {"document": "Untitled 2", "heading": "Costs"})
    assert cli.docs_request(["read", "--document", "~/Notes.md"]) == ("docs.read", {"document": str(Path("~/Notes.md").expanduser().resolve())})
    assert cli.docs_request(["find", "next", "steps", "--document", "Report.docx"]) == ("docs.find", {"document": report, "text": "next steps"})
    assert cli.docs_request(["write", "##", "Summary", "--at", "heading", "--heading", "Costs", "--mode", "replace"]) == ("docs.write", {"content": "## Summary", "at": "heading", "heading": "Costs", "mode": "replace"})
    assert cli.docs_request(["replace", "DRAFT", "", "--first"]) == ("docs.replace", {"find": "DRAFT", "replacement": "", "all": False})
    assert cli.docs_request(["format", "--at", "text", "--text", "Herald", "--bold", "--no-italic", "--color", "#1f6feb", "--size", "14"]) == ("docs.format", {"at": "text", "text": "Herald", "color": "#1f6feb", "bold": True, "italic": False, "size": 14.0})
    assert cli.docs_request(["format", "--style", "heading2", "--align", "center", "--line-spacing", "1.5"]) == ("docs.format", {"style": "heading2", "align": "center", "lineSpacing": 1.5})
    command, payload = cli.docs_request(["table", '[["Item", "Cost"], ["Rent", "1200"]]', "--at", "after", "--no-header"])
    assert command == "docs.insertTable" and json.loads(payload.pop("cells")) == [["Item", "Cost"], ["Rent", "1200"]]
    assert payload == {"at": "after", "header": False}
    assert cli.docs_request(["image", "chart.png", "--width", "480", "--alt", "Sales"]) == ("docs.insertImage", {"source": str(here / "chart.png"), "width": 480.0, "alt": "Sales"})
    assert cli.docs_request(["insert-range", "A1:D12", "--workbook", "Budget.xlsx", "--document", "Report.docx", "--at", "end"]) == ("docs.insertRange", {"document": report, "range": "A1:D12", "workbook": "Budget.xlsx", "at": "end"})
    assert cli.docs_request(["save", "--to", "Final.docx", "--overwrite"]) == ("docs.save", {"to": str(here / "Final.docx"), "overwrite": True})
    assert cli.docs_request(["pdf", "Report.docx"]) == ("docs.exportPdf", {"document": report})
    assert cli.docs_request(["undo", "--steps", "3"]) == ("docs.undo", {"steps": 3})
    assert cli.docs_request(["redo", "Untitled 2"]) == ("docs.redo", {"document": "Untitled 2"})
    for wrong in (["paint"], ["find"], ["write"], ["replace", "DRAFT"], ["format"], ["format", "bold"], ["format", "--size", "big"], ["table"], ["table", "not json"], ["table", '{"Item": "Cost"}'], ["image"], ["undo", "--steps", "two"], ["read", "--part"]):
        with pytest.raises(SystemExit) as stopped:
            cli.docs_request(wrong)
        assert stopped.value.code == 2, wrong


def test_docs_takes_markdown_and_rows_from_stdin(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("# Trip\n\n- Flights booked\n"))
    assert cli.docs_request(["write", "-", "--at", "start"]) == ("docs.write", {"content": "# Trip\n\n- Flights booked\n", "at": "start"})
    monkeypatch.setattr(sys, "stdin", io.StringIO("# Notes\n"))
    assert cli.docs_request(["new", "Notes", "--content", "-"]) == ("docs.new", {"name": "Notes", "content": "# Notes\n"})
    monkeypatch.setattr(sys, "stdin", io.StringIO('[["Day", "Plan"], ["1", "Alfama"]]'))
    _, payload = cli.docs_request(["table", "-"])
    assert json.loads(payload["cells"]) == [["Day", "Plan"], ["1", "Alfama"]]
    monkeypatch.setattr(sys, "stdin", io.StringIO("  \n"))
    with pytest.raises(SystemExit) as stopped:
        cli.docs_request(["write", "-"])
    assert stopped.value.code == 2
    # Only a lone - stands for stdin.
    assert cli.docs_request(["write", "-", "done"]) == ("docs.write", {"content": "- done"})


def test_sheets_words_become_sheets_commands(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    here = tmp_path.resolve()
    (tmp_path / "Budget.xlsx").write_bytes(b"xlsx")
    budget = str(here / "Budget.xlsx")
    assert cli.sheets_request([]) == ("sheets.open", {})
    assert cli.sheets_request(["open", "Budget.xlsx"]) == ("sheets.open", {"path": budget})
    assert cli.sheets_request(["new", "Trip", "budget", "--template", "budget", "--path", "Trip.xlsx"]) == ("sheets.new", {"name": "Trip budget", "template": "budget", "path": str(here / "Trip.xlsx")})
    assert cli.sheets_request(["list"]) == ("sheets.list", {})
    assert cli.sheets_request(["read", "A1:D20", "--workbook", "Budget.xlsx", "--sheet", "2026"]) == ("sheets.read", {"workbook": budget, "range": "A1:D20", "sheet": "2026"})
    assert cli.sheets_request(["read", "'Q1", "sales'!A1:B9"]) == ("sheets.read", {"range": "'Q1 sales'!A1:B9"})
    assert cli.sheets_request(["find", "Lisbon", "--workbook", "Trip.xlsx"]) == ("sheets.find", {"workbook": "Trip.xlsx", "text": "Lisbon"})
    # Several words are one text value; a single JSON array is rows.
    assert cli.sheets_request(["write", "A1", "Trip", "budget"]) == ("sheets.write", {"range": "A1", "values": "Trip budget"})
    assert cli.sheets_request(["write", "B7", "=SUM(B2:B6)"]) == ("sheets.write", {"range": "B7", "values": "=SUM(B2:B6)"})
    command, payload = cli.sheets_request(["write", "A1", '[["Item", "Cost"], ["Rent", 1200]]', "--sheet", "Costs"])
    assert command == "sheets.write" and json.loads(payload.pop("values")) == [["Item", "Cost"], ["Rent", 1200]]
    assert payload == {"range": "A1", "sheet": "Costs"}
    assert cli.sheets_request(["fill", "E2:E40", "=C2*D2"]) == ("sheets.fill", {"range": "E2:E40", "formula": "=C2*D2"})
    assert cli.sheets_request(["fill", "E2:E40"]) == ("sheets.fill", {"range": "E2:E40"})
    command, payload = cli.sheets_request(["format", "B2:B9", '{"numberFormat": "$#,##0.00", "bold": true}'])
    assert command == "sheets.format" and json.loads(payload["format"]) == {"numberFormat": "$#,##0.00", "bold": True}
    assert cli.sheets_request(["sort", "A1:D40", "--by", "Cost", "--descending", "--header"]) == ("sheets.sort", {"range": "A1:D40", "by": "Cost", "ascending": False, "header": True})
    command, payload = cli.sheets_request(["filter", "A1:D40", "--by", "Status", "--values", '["Paid", "Due"]'])
    assert command == "sheets.filter" and json.loads(payload.pop("values")) == ["Paid", "Due"]
    assert payload == {"range": "A1:D40", "by": "Status"}
    _, payload = cli.sheets_request(["filter", "A1:D40", "--by", "Cost", "--condition", '{"operator": "greaterThan", "value": 100}'])
    assert json.loads(payload["condition"]) == {"operator": "greaterThan", "value": 100}
    assert cli.sheets_request(["filter", "--clear"]) == ("sheets.filter", {"clear": True})
    assert cli.sheets_request(["freeze", "1"]) == ("sheets.freeze", {"rows": 1})
    assert cli.sheets_request(["freeze", "1", "2"]) == ("sheets.freeze", {"rows": 1, "columns": 2})
    assert cli.sheets_request(["add-sheet", "Q2", "plan", "--index", "1"]) == ("sheets.addSheet", {"name": "Q2 plan", "index": 1})
    assert cli.sheets_request(["rename-sheet", "Sheet1", "Budget"]) == ("sheets.renameSheet", {"sheet": "Sheet1", "name": "Budget"})
    assert cli.sheets_request(["remove-sheet", "Old", "data", "--workbook", "Budget.xlsx"]) == ("sheets.removeSheet", {"workbook": budget, "sheet": "Old data"})
    assert cli.sheets_request(["replace", "N/A", "", "--range", "B2:B90", "--first"]) == ("sheets.replace", {"find": "N/A", "replacement": "", "range": "B2:B90", "all": False})
    assert cli.sheets_request(["clean", "A1:D50", "dedupe", "--header", "--by", "A,B"]) == ("sheets.clean", {"range": "A1:D50", "action": "dedupe", "by": "A,B", "header": True})
    assert cli.sheets_request(["clean", "C2:C90", "dates", "--order", "dmy", "--date-format", "dd/mm/yyyy"]) == ("sheets.clean", {"range": "C2:C90", "action": "dates", "order": "dmy", "dateFormat": "dd/mm/yyyy"})
    assert cli.sheets_request(["clean", "A2:A40", "split", "--delimiter", "space", "--overwrite"]) == ("sheets.clean", {"range": "A2:A40", "action": "split", "delimiter": "space", "overwrite": True})
    assert cli.sheets_request(["save", "Budget.xlsx", "--to", "Budget.csv"]) == ("sheets.save", {"workbook": budget, "to": str(here / "Budget.csv")})
    assert cli.sheets_request(["pdf", "--to", "~/Desktop/Budget.pdf", "--overwrite"]) == ("sheets.exportPdf", {"to": str(Path("~/Desktop/Budget.pdf").expanduser().resolve()), "overwrite": True})
    assert cli.sheets_request(["undo", "--steps", "2"]) == ("sheets.undo", {"steps": 2})
    wrongs = (
        ["chart"], ["find"], ["write", "A1"], ["write", "A1", "[1, 2"], ["fill"], ["format", "A1"], ["format", "A1", "bold"], ["format", "A1", "[1]"],
        ["sort", "A1:D9"], ["filter", "A1:D9", "--by", "C"], ["filter", "A1:D9", "--values", '["x"]'], ["filter", "A1:D9", "--by", "C", "--values", "Paid"],
        ["freeze"], ["freeze", "one"], ["freeze", "1", "2", "3"], ["rename-sheet", "Sheet1"], ["remove-sheet"], ["replace", "N/A"],
        ["clean", "A1:A9"], ["clean", "A1:A9", "wash"], ["add-sheet", "--index", "first"], ["undo", "--steps", "-1"], ["read", "--sheet"],
    )
    for wrong in wrongs:
        with pytest.raises(SystemExit) as stopped:
            cli.sheets_request(wrong)
        assert stopped.value.code == 2, wrong


def test_docs_and_sheets_print_what_they_read(monkeypatch, capsys):
    replies = {
        "docs.list": {"ok": True, "summary": "2 documents open", "data": {"documents": [
            {"name": "Report.docx", "path": "/home/me/Report.docx", "modified": True, "active": True, "selection": "Sales rose\n12% on last year"},
            {"name": "Untitled 2", "path": None, "modified": False, "active": False},
        ]}},
        "docs.read": {"ok": True, "summary": "Report.docx: 3 words, 2 headings", "data": {"outline": [{"level": 1, "text": "Report"}, {"level": 2, "text": "Costs"}], "content": "# Report\n\n## Costs\n\nRent."}},
        "sheets.list": {"ok": True, "summary": "Nothing is open in Herald Sheets", "data": {"workbooks": []}},
        "sheets.read": {"ok": True, "summary": "Budget.xlsx: Sheet1 (3×2)", "data": {"values": [["Item", "Cost"], ["Rent", 1200]], "text": [["Item", "Cost"], ["Rent", "$1,200.00"]]}},
    }
    timeouts = []

    def run_os_wait(command, args=None, timeout=30):
        timeouts.append(timeout)
        return replies[command]

    monkeypatch.setattr(cli, "run_os_wait", run_os_wait)
    assert cli.docs_cmd(["list"]) == 0
    assert capsys.readouterr().out.splitlines() == ["* Report.docx  /home/me/Report.docx  (edited)  “Sales rose 12% on last year”", "  Untitled 2  not saved"]
    cli.docs_cmd(["read"])
    assert capsys.readouterr().out == "Report\n  Costs\n\n# Report\n\n## Costs\n\nRent.\n"
    cli.docs_cmd(["list", "--json"])
    assert json.loads(capsys.readouterr().out) == replies["docs.list"]["data"]
    cli.sheets_cmd(["list"])
    assert capsys.readouterr().out == "Nothing is open in Herald Sheets\n"
    # What the cells show when it differs from their values, else the values.
    cli.sheets_cmd(["read", "A1:B2"])
    assert capsys.readouterr().out == "Item\tCost\nRent\t$1,200.00\n"
    replies["sheets.read"]["data"] = {"values": [["Paid", True, None, 3.5], ["Note", "two\tparts", 0, False]]}
    cli.sheets_cmd(["read"])
    assert capsys.readouterr().out == "Paid\tTRUE\t\t3.5\nNote\ttwo parts\t0\tFALSE\n"
    assert timeouts and all(timeout >= 60 for timeout in timeouts)


def test_slides_words_become_slides_commands(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    here = tmp_path.resolve()
    (tmp_path / "Q3.pptx").write_bytes(b"pptx")
    (tmp_path / "Report.docx").write_bytes(b"docx")
    deck = str(here / "Q3.pptx")
    assert cli.slides_request([]) == ("slides.open", {})
    assert cli.slides_request(["open", "Q3.pptx"]) == ("slides.open", {"path": deck})
    command, payload = cli.slides_request(["new", "Q3", "review", "--theme", "midnight", "--size", "standard", "--slides", '[{"layout": "title", "title": "Q3 review"}]'])
    assert command == "slides.new" and json.loads(payload.pop("slides")) == [{"layout": "title", "title": "Q3 review"}]
    assert payload == {"name": "Q3 review", "theme": "midnight", "size": "standard"}
    assert cli.slides_request(["list"]) == ("slides.list", {})
    assert cli.slides_request(["read", "Q3.pptx", "--slide", "2"]) == ("slides.read", {"presentation": deck, "slide": "2"})
    assert cli.slides_request(["read", "--presentation", "Q3 review"]) == ("slides.read", {"presentation": "Q3 review"})
    assert cli.slides_request(["add-slide", "Next", "steps", "--layout", "title-content", "--notes", "Ask for a decision", "--after", "3"]) == ("slides.addSlide", {"title": "Next steps", "layout": "title-content", "notes": "Ask for a decision", "after": "3"})
    assert cli.slides_request(["set-slide", "7", "--hidden"]) == ("slides.setSlide", {"slide": "7", "hidden": True})
    assert cli.slides_request(["set-slide", "Risks", "--title", "Open risks", "--background", "accent1", "--shown"]) == ("slides.setSlide", {"slide": "Risks", "title": "Open risks", "background": "accent1", "hidden": False})
    assert cli.slides_request(["notes", "2", "Lead", "with", "revenue"]) == ("slides.setSlide", {"slide": "2", "notes": "Lead with revenue"})
    assert cli.slides_request(["move", "Risks", "last"]) == ("slides.moveSlide", {"slide": "Risks", "to": "last"})
    assert cli.slides_request(["remove", "Thank", "you", "--presentation", "Q3.pptx"]) == ("slides.removeSlide", {"presentation": deck, "slide": "Thank you"})
    assert cli.slides_request(["theme", "paper"]) == ("slides.setTheme", {"theme": "paper"})
    # from-doc's --notes is a switch, and the deck it adds to is --presentation.
    assert cli.slides_request(["from-doc", "Report.docx", "--level", "2", "--notes", "--presentation", "Q3 review"]) == ("slides.fromDocument", {"presentation": "Q3 review", "document": str(here / "Report.docx"), "level": 2, "notes": True})
    assert cli.slides_request(["from-doc"]) == ("slides.fromDocument", {})
    assert cli.slides_request(["insert-range", "A1:D6", "--workbook", "Budget.xlsx", "--slide", "Costs"]) == ("slides.insertRange", {"range": "A1:D6", "workbook": "Budget.xlsx", "slide": "Costs"})
    assert cli.slides_request(["replace", "Q2", "Q3", "--first"]) == ("slides.replace", {"find": "Q2", "replacement": "Q3", "all": False})
    assert cli.slides_request(["save", "--to", "Q3 final.pptx"]) == ("slides.save", {"to": str(here / "Q3 final.pptx")})
    assert cli.slides_request(["pdf", "Q3.pptx", "--overwrite", "--to", "Q3.pdf"]) == ("slides.exportPdf", {"presentation": deck, "to": str(here / "Q3.pdf"), "overwrite": True})
    assert cli.slides_request(["undo", "--steps", "2"]) == ("slides.undo", {"steps": 2})
    wrongs = (
        ["animate"], ["set-slide", "2"], ["set-slide", "--title", "x"], ["notes", "2"], ["move", "2"], ["remove"], ["theme"], ["theme", "a", "b"],
        ["replace", "Q2"], ["new", "--slides", '{"title": "x"}'], ["from-doc", "--level", "two"], ["undo", "--steps", "x"], ["read", "--slide"], ["add-slide", "--notes"],
    )
    for wrong in wrongs:
        with pytest.raises(SystemExit) as stopped:
            cli.slides_request(wrong)
        assert stopped.value.code == 2, wrong


def test_slides_take_bodies_notes_and_decks_from_stdin(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("Revenue up 12%\n  Subscriptions\nCosts flat\n"))
    assert cli.slides_request(["add-slide", "Results", "--body", "-"]) == ("slides.addSlide", {"title": "Results", "body": "Revenue up 12%\n  Subscriptions\nCosts flat\n"})
    monkeypatch.setattr(sys, "stdin", io.StringIO("Lead with revenue.\n"))
    assert cli.slides_request(["notes", "2", "-"]) == ("slides.setSlide", {"slide": "2", "notes": "Lead with revenue.\n"})
    monkeypatch.setattr(sys, "stdin", io.StringIO('[{"title": "One"}, {"title": "Two"}]'))
    _, payload = cli.slides_request(["new", "Deck", "--slides", "-"])
    assert json.loads(payload["slides"]) == [{"title": "One"}, {"title": "Two"}]


def test_slides_print_what_they_read(monkeypatch, capsys):
    replies = {
        "slides.list": {"ok": True, "summary": "1 presentation open", "data": {"presentations": [{"name": "Q3 review", "path": None, "modified": True, "active": True, "selection": "slide 2"}]}},
        "slides.read": {"ok": True, "summary": "Q3 review: 3 slides", "data": {"front": 2, "slides": [
            {"number": 1, "layout": "title", "title": "Q3 review", "body": "Finance team"},
            {"number": 2, "layout": "two-content", "title": "Mix", "body": "Subscriptions\n  Up 31%", "body2": "One-off\n  Down 6%", "notes": "The mix keeps\nmoving."},
            {"number": 3, "layout": "blank", "hidden": True},
        ]}},
    }
    timeouts = []

    def run_os_wait(command, args=None, timeout=30):
        timeouts.append(timeout)
        return replies[command]

    monkeypatch.setattr(cli, "run_os_wait", run_os_wait)
    cli.slides_cmd(["list"])
    assert capsys.readouterr().out == "* Q3 review  not saved  (edited)  slide 2\n"
    cli.slides_cmd(["read"])
    assert capsys.readouterr().out.splitlines() == [
        "   1. Q3 review  (title)",
        "       Finance team",
        "*  2. Mix  (two-content)",
        "       Subscriptions",
        "         Up 31%",
        "       One-off",
        "         Down 6%",
        "       notes: The mix keeps moving.",
        "   3. (no title)  (blank, hidden)",
    ]
    assert all(timeout >= 60 for timeout in timeouts)


def test_herald_keymap_is_the_template():
    assert cli.render_keymap(TEMPLATE, "herald") == TEMPLATE


def test_template_keys_the_omarchy_keymap_moves_to_are_free():
    keys = binds(TEMPLATE)
    for moved in cli.OMARCHY_MOVES.values():
        assert moved not in keys
    assert "Mod+X" not in keys


def test_omarchy_keymap_rewrites_copy_cut_and_paste():
    keys = binds(cli.render_keymap(TEMPLATE, "omarchy"))
    assert '"-k" "Insert"' in keys["Mod+C"] and '"ctrl"' in keys["Mod+C"]
    assert '"shift" "-k" "Insert"' in keys["Mod+V"]
    assert '"ctrl" "x"' in keys["Mod+X"]
    # Herald's binds are kept, one modifier over.
    assert "center-column" in keys["Mod+Ctrl+C"]
    assert '"herald-os" "voice"' in keys["Mod+Shift+V"]
    # Nothing else changed.
    original = binds(TEMPLATE)
    for key, rest in original.items():
        if key not in ("Mod+C", "Mod+V"):
            assert keys[key] == rest


def test_weather_url_for_a_place_or_the_network():
    assert cli.weather_url("").startswith("https://wttr.in/?format=")
    assert cli.weather_url("New  York").startswith("https://wttr.in/New+York?")
    assert cli.weather_url("~Eiffel Tower").startswith("https://wttr.in/~Eiffel+Tower?")
    # Anything that would change the request is escaped.
    assert cli.weather_url("a/b?c#d").startswith("https://wttr.in/a%2Fb%3Fc%23d?")


def fake_hyprctl(monkeypatch, lua_config):
    """hyprctl that takes only Lua dispatchers (a Lua config) or only classic ones (hyprland.conf)."""
    calls = []
    monkeypatch.setenv("HYPRLAND_INSTANCE_SIGNATURE", "abc")
    monkeypatch.delenv("NIRI_SOCKET", raising=False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/bin/{name}")

    def run(argv, **kwargs):
        calls.append(argv[2:])
        works = argv[2].startswith("hl.") == lua_config
        return subprocess.CompletedProcess(argv, 0 if works else 7, "ok\n" if works else "error: no such dispatcher\n", "")

    monkeypatch.setattr(cli.subprocess, "run", run)
    return calls


def test_wm_maps_niri_actions_to_hyprland_dispatchers(monkeypatch):
    calls = fake_hyprctl(monkeypatch, lua_config=False)
    for action in (["close-window"], ["focus-workspace", "work"], ["focus-workspace", "3"], ["exec", "kitty"]):
        assert cli.wm(*action) == 0
    assert [call for call in calls if not call[0].startswith("hl.")] == [
        ["killactive"],
        ["workspace", "name:work"],
        ["workspace", "3"],
        ["exec", "kitty"],
    ]


def test_wm_speaks_lua_to_a_lua_config(monkeypatch, capsys):
    calls = fake_hyprctl(monkeypatch, lua_config=True)
    assert cli.wm("close-window") == 0 and cli.wm("focus-workspace", "work") == 0 and cli.wm("exec", "kitty --class a") == 0
    assert calls == [["hl.dsp.window.close()"], ['hl.dsp.focus({ workspace = "name:work" })'], ['hl.dsp.exec_cmd("kitty --class a")']]
    # A classic-only dispatcher fails with what Hyprland said.
    assert cli.wm("togglesplit") == 1 and "no such dispatcher" in capsys.readouterr().err
    assert cli.lua_string('a"b\\') == '"a\\"b\\\\"'


def test_wm_uses_niri_under_niri(monkeypatch):
    calls = []
    monkeypatch.setenv("NIRI_SOCKET", "/run/niri.sock")
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(cli.subprocess, "call", lambda argv: calls.append(argv) or 0)
    cli.wm("close-window")
    assert calls == [["niri", "msg", "action", "close-window"]]


def omarchy_home(tmp_path, monkeypatch, version=3):
    """A home with Omarchy 3 (a checkout, hyprland.conf) or Omarchy 4 (Lua config, menu JSONC)."""
    home = tmp_path / "home"
    share = home / ".local" / "share" / "omarchy"
    (share / "themes").mkdir(parents=True)
    (home / ".config" / "hypr").mkdir(parents=True)
    if version == 3:
        (home / ".config" / "hypr" / "hyprland.conf").write_text("source = ~/.local/share/omarchy/default/hypr/bindings.conf\n")
    else:
        (home / ".config" / "hypr" / "hyprland.lua").write_text('require("default.hypr.omarchy")\nrequire("hypr.bindings")\n')
        (share / "bin").mkdir()
        (share / "bin" / "omarchy-hook").write_text('HOOK_PATH="$HOME/.config/omarchy/hooks/$1"\nHOOK_DIR="$HOOK_PATH.d"\n')
        menu = home / ".config" / "omarchy" / "extensions" / "omarchy-menu.jsonc"
        menu.parent.mkdir(parents=True)
        menu.write_text('{\n  // Extend the Quickshell Omarchy menu with JSONC.\n  // "personal": {"icon":"","label":"Personal"},\n}\n')
    monkeypatch.delenv("OMARCHY_PATH", raising=False)
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    for name, value in {
        "OMARCHY_SHARE": share,
        "OMARCHY_PACKAGE": tmp_path / "no-package",
        "OMARCHY_HOOKS": home / ".config" / "omarchy" / "hooks",
        "OMARCHY_MENU": home / ".config" / "omarchy" / "extensions" / "omarchy-menu.jsonc",
        "OMARCHY_CURRENT": (home / ".local" / "state" / "omarchy" / "current", home / ".config" / "omarchy" / "current"),
        "HYPR_DIR": home / ".config" / "hypr",
        "HERALD_HYPR": home / ".config" / "hypr" / "herald-os.conf",
        "HERALD_HYPR_LUA": home / ".config" / "hypr" / "herald-os.lua",
        "APP_DESKTOP": home / ".local" / "share" / "applications" / "herald-os-app.desktop",
        "APPS_DIR": home / ".local" / "share" / "applications",
    }.items():
        monkeypatch.setattr(cli, name, value)
    monkeypatch.setattr(cli, "relay", lambda *args, **kwargs: {"ok": True})
    return home


def test_omarchy_4_gets_lua_keys_a_menu_row_and_no_dispatcher(tmp_path, monkeypatch, capsys):
    home = omarchy_home(tmp_path, monkeypatch, version=4)
    lua = home / ".config" / "hypr" / "hyprland.lua"
    menu = home / ".config" / "omarchy" / "extensions" / "omarchy-menu.jsonc"
    before = {lua: lua.read_text(), menu: menu.read_text()}
    assert cli.omarchy_install() == 0
    assert all(cli.omarchy_status().values())
    assert cli.HYPR_REQUIRE in lua.read_text()
    assert 'o.bind("SUPER + ALT + H", "Herald OS", "herald-os-app")' in (home / ".config" / "hypr" / "herald-os.lua").read_text()
    # Omarchy 4 runs theme-set.d itself: no dispatcher, so the hook runs once.
    assert not (home / ".config" / "omarchy" / "hooks" / "theme-set").exists()
    assert (home / ".config" / "omarchy" / "hooks" / "theme-set.d" / "herald-os").exists()
    # Omarchy's parser still reads the menu, with Herald as a root row.
    assert omarchy_menu_parse(menu.read_text())["herald-os"]["action"] == "herald-os-app"
    cli.omarchy_install()
    assert menu.read_text().count('"herald-os"') == 1 and lua.read_text().count(cli.HYPR_REQUIRE) == 1
    assert cli.omarchy_remove() == 0
    assert lua.read_text() == before[lua] and menu.read_text() == before[menu]


def omarchy_menu_parse(text):
    """Omarchy's own reading of the menu (stripJsonc in MenuModel.js): only whole-line // comments
    and trailing commas come out before JSON.parse."""
    stripped = re.sub(r"^\s*//[^\n]*(\n|$)", "", text, flags=re.M)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", stripped))


def test_current_omarchy_theme_by_name(tmp_path, monkeypatch):
    home = omarchy_home(tmp_path, monkeypatch, version=4)
    assert cli.omarchy_current_theme() == ""
    # Omarchy 4: a staged copy, named in theme.name.
    current = home / ".local" / "state" / "omarchy" / "current"
    (current / "theme").mkdir(parents=True)
    (current / "theme.name").write_text("tokyo-night\n")
    assert cli.omarchy_current_theme() == "tokyo-night"
    # Omarchy 3: a link to the theme's folder.
    (current / "theme.name").unlink()
    (current / "theme").rmdir()
    (home / "themes" / "nord").mkdir(parents=True)
    (current / "theme").symlink_to(home / "themes" / "nord")
    assert cli.omarchy_current_theme() == "nord"


def test_menu_row_adds_the_comma_the_entry_before_needs():
    text = '{\n  // Mine:\n  "mine": {"label": "Mine", "action": "x"}\n}\n'
    updated = cli.menu_with_herald(text)
    assert updated.splitlines()[2] == '  "mine": {"label": "Mine", "action": "x"},'
    assert list(omarchy_menu_parse(updated)) == ["mine", "herald-os"]
    assert cli.menu_with_herald(updated) is None
    assert omarchy_menu_parse(cli.menu_without_herald(updated)) == {"mine": {"label": "Mine", "action": "x"}}
    assert cli.menu_with_herald("[ { \"label\": \"Mine\" } ]\n") is None
    # A // inside a string is not a comment.
    assert cli.split_jsonc_comment('"url": "https://x"  // y') == ('"url": "https://x"  ', "// y")


def test_omarchy_install_and_remove_leave_things_as_they_were(tmp_path, monkeypatch, capsys):
    home = omarchy_home(tmp_path, monkeypatch)
    hyprland = home / ".config" / "hypr" / "hyprland.conf"
    before = hyprland.read_text()
    assert cli.omarchy_install() == 0
    assert all(cli.omarchy_status().values())
    hook = home / ".config" / "omarchy" / "hooks" / "theme-set.d" / "herald-os"
    assert hook.stat().st_mode & 0o111 and "herald-os theme omarchy" in hook.read_text()
    assert cli.HYPR_SOURCE in hyprland.read_text()
    binds = (home / ".config" / "hypr" / "herald-os.conf").read_text()
    assert "bindd = SUPER ALT, H, Herald OS keys, submap, herald" in binds and binds.rstrip().endswith("submap = reset")
    # Installing twice adds nothing twice.
    cli.omarchy_install()
    assert hyprland.read_text().count(cli.HYPR_SOURCE) == 1
    assert cli.omarchy_remove() == 0
    assert not any(cli.omarchy_status().values())
    assert hyprland.read_text() == before


def test_omarchy_install_never_overwrites_the_persons_files(tmp_path, monkeypatch, capsys):
    home = omarchy_home(tmp_path, monkeypatch)
    hook = home / ".config" / "omarchy" / "hooks" / "theme-set"
    hook.parent.mkdir(parents=True)
    hook.write_text("#!/bin/sh\nnotify-send theme \"$1\"\n")
    menu = home / ".config" / "omarchy" / "extensions" / "omarchy-menu.jsonc"
    menu.parent.mkdir(parents=True)
    menu.write_text("[ { \"label\": \"Mine\" } ]\n")
    cli.omarchy_install()
    out = capsys.readouterr().out
    assert hook.read_text() == "#!/bin/sh\nnotify-send theme \"$1\"\n" and "theme-set.d" in out
    assert menu.read_text() == "[ { \"label\": \"Mine\" } ]\n" and '"herald-os"' in out
    cli.omarchy_remove()
    assert hook.exists() and menu.exists()


class FakeHermes:
    """`hermes` as setup sees it: replies by command, and a config that `config set` changes."""

    def __init__(self, replies: dict[str, tuple[int, str]] | None = None, tool_search: str = "auto"):
        self.replies = replies or {}
        self.tool_search = tool_search
        self.ran: list[list[str]] = []

    def __call__(self, argv, **kwargs):
        args = argv[1:]
        self.ran.append(args)
        if args[:2] == ["config", "get"]:
            return subprocess.CompletedProcess(argv, 0, f"{self.tool_search}\n", "")
        if args[:2] == ["config", "set"]:
            self.tool_search = args[3]
        code, out = self.replies.get(" ".join(args), (0, "✓ done"))
        return subprocess.CompletedProcess(argv, code, out, "")


@pytest.fixture
def hermes_setup(tmp_path, monkeypatch):
    bridge = tmp_path / "share" / "bridge"
    bridge.mkdir(parents=True)
    (bridge / "plugin.yaml").write_text("name: herald-os-bridge\n")
    hermes_home = tmp_path / ".hermes"
    monkeypatch.setattr(cli, "BRIDGE_DIRS", [tmp_path / "missing", bridge])
    monkeypatch.setattr(cli, "HERMES_HOME", hermes_home)
    monkeypatch.setattr(cli, "hermes_command", lambda: ["/usr/bin/hermes"])
    monkeypatch.setattr(cli, "is_omarchy", lambda: False)

    def install(hermes: FakeHermes) -> FakeHermes:
        monkeypatch.setattr(cli.subprocess, "run", hermes)
        return hermes

    return bridge, hermes_home, install


def test_setup_links_the_bridge_enables_it_and_says_what_changed(hermes_setup, capsys):
    bridge, hermes_home, install = hermes_setup
    hermes = install(FakeHermes())
    assert cli.setup([]) == 0
    link = hermes_home / "plugins" / "herald-os-bridge"
    assert link.is_symlink() and link.resolve() == bridge.resolve()
    assert ["plugins", "enable", "herald-os-bridge"] in hermes.ran and ["tools", "enable", "herald_os"] in hermes.ran
    assert ["config", "set", "tools.tool_search.enabled", "off"] in hermes.ran
    assert (hermes_home / "herald-os" / "tool-search-before").read_text() == "auto\n"
    out = capsys.readouterr().out
    assert "plugins.enabled" in out and "platform_toolsets.cli" in out and "it was auto" in out and "setup --undo" in out
    # Running it again replaces its own link and keeps the value from before Herald OS.
    assert cli.setup([]) == 0 and link.is_symlink()
    assert hermes.ran.count(["config", "set", "tools.tool_search.enabled", "off"]) == 1
    assert (hermes_home / "herald-os" / "tool-search-before").read_text() == "auto\n"


@pytest.mark.parametrize("step, reply", [
    ("plugins enable herald-os-bridge", (1, "No plugin named 'herald-os-bridge'.")),
    # An unknown toolset is a ✗ line with exit 0.
    ("tools enable herald_os", (0, "✗ Unknown toolset 'herald_os'")),
])
def test_setup_stops_at_a_failed_hermes_step(hermes_setup, capsys, step, reply):
    _, hermes_home, install = hermes_setup
    hermes = install(FakeHermes({step: reply}))
    with pytest.raises(SystemExit) as stopped:
        cli.setup([])
    assert stopped.value.code == 1
    assert ["config", "set", "tools.tool_search.enabled", "off"] not in hermes.ran
    assert reply[1] in capsys.readouterr().err
    assert not (hermes_home / "herald-os" / "tool-search-before").exists()


def test_setup_undo_takes_back_every_change(hermes_setup, capsys):
    _, hermes_home, install = hermes_setup
    hermes = install(FakeHermes(tool_search="on"))
    cli.setup([])

    assert cli.setup(["--undo"]) == 0

    assert hermes.ran[-4:] == [["tools", "disable", "herald_os"], ["plugins", "disable", "herald-os-bridge"], ["config", "get", "tools.tool_search.enabled"], ["config", "set", "tools.tool_search.enabled", "on"]]
    assert not (hermes_home / "plugins" / "herald-os-bridge").exists()
    assert not (hermes_home / "herald-os" / "tool-search-before").exists()
    # The app's first start must not turn it all back on.
    assert (hermes_home / "herald-os" / "bridge-enabled").exists()


def test_setup_undo_finishes_what_is_left(hermes_setup, capsys):
    _, hermes_home, install = hermes_setup
    hermes = install(FakeHermes({"tools disable herald_os": (0, "✗ Unknown toolset 'herald_os'"), "plugins disable herald-os-bridge": (1, "No plugin named 'herald-os-bridge'.")}, tool_search="off"))

    assert cli.setup(["--undo"]) == 0

    out = capsys.readouterr().out
    assert out.count("nothing to change") == 2
    # No record (a setup from before it was kept): back to Hermes's default, saying how to undo that.
    assert ["config", "set", "tools.tool_search.enabled", "auto"] in hermes.ran and "hermes config set tools.tool_search.enabled off" in out


def test_setup_undo_leaves_tool_search_the_person_changed_since(hermes_setup, capsys):
    _, hermes_home, install = hermes_setup
    hermes = install(FakeHermes())
    cli.setup([])
    hermes.tool_search = "auto"

    assert cli.setup(["--undo"]) == 0

    assert hermes.ran.count(["config", "set", "tools.tool_search.enabled", "auto"]) == 0
    assert "left as it is" in capsys.readouterr().out
    assert not (hermes_home / "herald-os" / "tool-search-before").exists()


def test_setup_leaves_a_foreign_plugin_folder_alone(tmp_path, monkeypatch):
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    (bridge / "plugin.yaml").write_text("name: herald-os-bridge\n")
    hermes_home = tmp_path / ".hermes"
    (hermes_home / "plugins" / "herald-os-bridge").mkdir(parents=True)
    monkeypatch.setattr(cli, "BRIDGE_DIRS", [bridge])
    monkeypatch.setattr(cli, "HERMES_HOME", hermes_home)
    monkeypatch.setattr(cli, "hermes_command", lambda: ["/usr/bin/hermes"])
    with pytest.raises(SystemExit):
        cli.setup([])
    assert (hermes_home / "plugins" / "herald-os-bridge").is_dir()


def test_unknown_keymap_falls_back_to_herald(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "KEYMAP_FILE", tmp_path / "keymap")
    assert cli.current_keymap() == "herald"
    (tmp_path / "keymap").write_text("vim\n")
    assert cli.current_keymap() == "herald"
    (tmp_path / "keymap").write_text("omarchy\n")
    assert cli.current_keymap() == "omarchy"


def test_pam_line_goes_first_once():
    sudo = "#%PAM-1.0\nauth\t\tinclude\t\tsystem-auth\naccount\t\tinclude\t\tsystem-auth\n"
    updated = cli.pam_with(sudo, "auth sufficient pam_fprintd.so")
    assert updated.splitlines() == ["#%PAM-1.0", "auth sufficient pam_fprintd.so", "auth\t\tinclude\t\tsystem-auth", "account\t\tinclude\t\tsystem-auth"]
    # Already there (whatever the spacing): nothing to change.
    assert cli.pam_with(updated.replace("auth sufficient", "auth   sufficient"), "auth sufficient pam_fprintd.so") is None
    # A file with only includes and comments gets it after them.
    assert cli.pam_with("#%PAM-1.0\n# swaylock\n-include login\n", "auth sufficient pam_u2f.so cue").splitlines()[2] == "auth sufficient pam_u2f.so cue"


def test_bar_words_become_registry_commands():
    assert cli.bar_args([]) == ("bar.layout", {})
    assert cli.bar_args(["hide", "bluetooth"]) == ("bar.hide", {"item": "bluetooth"})
    assert cli.bar_args(["move", "clock", "first"]) == ("bar.move", {"item": "clock", "position": "first"})
    assert cli.bar_args(["move", "clock", "3"]) == ("bar.move", {"item": "clock", "position": "3"})
    assert cli.bar_args(["move", "battery", "after", "wifi"]) == ("bar.move", {"item": "battery", "after": "wifi"})
    assert cli.bar_args(["clock", "24h", "seconds", "date", "none"]) == ("bar.clock", {"hours": "24", "seconds": True, "date": "none"})
    assert cli.bar_args(["clock", "System", "no-seconds"]) == ("bar.clock", {"hours": "system", "seconds": False})
    assert cli.bar_args(["reset"]) == ("bar.reset", {})
    for bad in (["move", "clock"], ["move", "clock", "middle"], ["clock"], ["clock", "25h"], ["hide"], ["reset", "now"], ["paint"]):
        with pytest.raises(SystemExit) as stopped:
            cli.bar_args(bad)
        assert stopped.value.code == 2, bad


def test_lock_draws_the_branded_picture_behind_the_ring(tmp_path):
    cfg, image = tmp_path / "config", tmp_path / "lock.jpg"
    assert cli.lock_command(cfg, None) == ["swaylock", "-f", "-C", str(cfg)]
    assert cli.lock_command(None, image) == ["swaylock", "-f", "--color", "04113f", "--image", str(image), "--scaling", "fill"]


def test_branding_lock_image_stays_inside_the_branding_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "BRANDING_DIR", tmp_path)
    assert cli.branding_lock_image() is None
    (tmp_path / "lock.png").write_bytes(b"png")
    (tmp_path / "branding.json").write_text('{"lock": "lock.png"}')
    assert cli.branding_lock_image() == tmp_path / "lock.png"
    (tmp_path / "branding.json").write_text('{"lock": "../lock.png"}')
    assert cli.branding_lock_image() is None


def test_branding_set_makes_paths_absolute(tmp_path):
    patch = cli.branding_patch(["--logo", "art/logo.svg", "--name", "Acme Corp", "--lock", "/srv/beach.jpg"], tmp_path)
    assert patch == {"logo": str((tmp_path / "art" / "logo.svg").resolve()), "name": "Acme Corp", "lock": str(Path("/srv/beach.jpg").resolve())}
    for bad in ([], ["--logo"], ["--colour", "red"], ["logo.png"]):
        with pytest.raises(SystemExit) as stopped:
            cli.branding_patch(bad, tmp_path)
        assert stopped.value.code == 2, bad


class _Stdin:
    def __init__(self, tty: bool):
        self.tty = tty

    def isatty(self) -> bool:
        return self.tty


def test_plugin_enable_asks_the_person_and_never_runs_unattended(monkeypatch, capsys):
    sent = []
    listing = {"ok": True, "plugins": [{"id": "weather-strip", "name": "Weather strip", "errors": [], "grants": ["Connect to api.open-meteo.com"]}]}
    monkeypatch.setattr(cli, "relay", lambda cmd, args, *rest, **kwargs: sent.append(args) or (listing if args == ["list"] else {"ok": True}))
    monkeypatch.setattr(cli.sys, "stdin", _Stdin(False))
    with pytest.raises(SystemExit) as stopped:
        cli.plugin_cmd(["enable", "weather-strip"])
    assert stopped.value.code == 2 and sent == [["list"]]
    # At a terminal it lists what the plugin may do, and turns it on only after a yes.
    monkeypatch.setattr(cli.sys, "stdin", _Stdin(True))
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    assert cli.plugin_cmd(["enable", "weather-strip"]) == 1
    assert ["enable", "weather-strip"] not in sent
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    assert cli.plugin_cmd(["enable", "weather-strip"]) == 0
    assert sent[-1] == ["enable", "weather-strip"]
    assert "Connect to api.open-meteo.com" in capsys.readouterr().out


def test_plugin_add_waits_for_the_clone_and_says_it_is_off(monkeypatch, capsys):
    calls = []
    reply = {"ok": True, "plugin": {"id": "weather-strip", "name": "Weather strip", "version": "1.0.0"}}
    monkeypatch.setattr(cli, "relay", lambda cmd, args, *rest, **kwargs: calls.append((cmd, args, kwargs.get("timeout"))) or reply)
    assert cli.plugin_cmd(["add", "https://example.com/weather-strip.git"]) == 0
    assert calls == [("plugin", ["add", "https://example.com/weather-strip.git"], 180)]
    assert "turned off (herald-os plugin enable weather-strip)" in capsys.readouterr().out
    with pytest.raises(SystemExit) as stopped:
        cli.plugin_cmd(["remove"])
    assert stopped.value.code == 2
