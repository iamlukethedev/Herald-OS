"""niri's window rules for the shell's windows, checked against the titles the shell gives them."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = (ROOT / "linux" / "niri" / "config.kdl").read_text()
DESKTOP = ROOT / "apps" / "desktop"
FLOATS = "open-floating true"


def _rules(text):
    """The lines of each top-level window-rule block."""
    rules, current, depth = [], None, 0
    for line in (raw.strip() for raw in text.splitlines()):
        if not line or line.startswith("//"):
            continue
        if current is None:
            if line == "window-rule {":
                current, depth = [], 1
            continue
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            rules.append(current)
            current = None
        else:
            current.append(line)
    return rules


def _matcher(line):
    found = {}
    for m in re.finditer(r'(app-id|title)=(?:r#"(?P<raw>.*?)"#|"(?P<plain>[^"]*)")', line):
        found[m.group(1)] = m.group("raw") if m.group("raw") is not None else m.group("plain")
    return found


def props(app_id, title):
    """What niri's rules give a window, in order: a rule applies when one of its match lines does and no exclude line does."""
    window = {"app-id": app_id, "title": title}

    def hit(matcher):
        return all(re.search(pattern, window[key]) for key, pattern in matcher.items())

    out = []
    for rule in _rules(CONFIG):
        matches = [_matcher(line) for line in rule if line.startswith("match ")]
        excludes = [_matcher(line) for line in rule if line.startswith("exclude ")]
        if (not matches or any(hit(m) for m in matches)) and not any(hit(e) for e in excludes):
            out += [line for line in rule if not line.startswith(("match ", "exclude "))]
    return out


def _dialog_titles():
    """The titles the main process gives the dialogs it opens, from its source."""
    titles = set()
    nouns = re.search(r"OFFICE_NOUNS[^=]*=\s*\{([^}]*)\}", (DESKTOP / "shared" / "office" / "files.ts").read_text()).group(1)
    for source in ("electron/office/ipc.ts", "electron/canvas/ipc.ts"):
        text = (DESKTOP / source).read_text()
        for expr in re.findall(r"\btitle: ([^,}\n]+)", text):
            # A ternary's titles are its branches, not what it compares.
            titles |= set(re.findall(r"'([^']+)'", expr.split("?", 1)[-1]))
        titles |= set(re.findall(r"(?<!function )pickPdf\([^'\n]*'([^']+)'", text))
        if "title: `Open a ${OFFICE_NOUNS[app]}`" in text:
            titles |= {f"Open a {noun}" for noun in re.findall(r"'([^']+)'", nouns)}
    return titles


def test_the_shell_s_dialogs_float_in_a_checkout_and_packaged():
    titles = _dialog_titles()
    assert {"Open a document", "Open a spreadsheet", "Open a presentation", "Save as", "Export as PDF", "Print to File", "Open in Herald Canvas"} <= titles
    # GTK titles its own print dialog.
    for title in titles | {"Print"}:
        for app_id in ("electron", "herald-os"):
            assert FLOATS in props(app_id, title), (app_id, title)
            assert "open-focused true" in props(app_id, title), (app_id, title)


def test_the_shell_s_own_windows_are_not_taken_for_dialogs():
    for title in ("Herald OS", "Herald OS · Docs", "Herald OS · Sheets", "Herald OS · Slides", "Herald OS · Canvas", "Herald OS · Studio", "Preview", "YouTube"):
        assert FLOATS not in props("herald-os", title), title


def test_office_windows_tile_at_three_quarters_of_the_screen():
    mode = (DESKTOP / "electron" / "shell" / "mode.ts").read_text()
    titles = re.findall(r"(?:docs|sheets|slides): \{ title: '([^']+)'", mode)
    assert len(titles) == 3
    for title in titles:
        rules = props("herald-os", title)
        assert "default-column-width { proportion 0.75; }" in rules, title
        assert FLOATS not in rules, title


def test_the_audience_window_opens_full_screen_and_leaves_the_keys_to_the_presenter_view():
    title = re.search(r"const AUDIENCE_TITLE = '([^']+)'", (DESKTOP / "electron" / "office" / "presenter.ts").read_text()).group(1)
    rules = props("herald-os", title)
    assert "open-fullscreen true" in rules
    assert "open-focused false" in rules
    assert FLOATS not in rules
