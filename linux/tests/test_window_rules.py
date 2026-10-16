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
    for title in ("Herald OS", "Herald OS · Docs", "Herald OS · Sheets", "Herald OS · Slides", "Herald OS · Canvas", "Herald OS · Studio", "Herald OS · Pet Room", "Preview", "YouTube"):
        assert FLOATS not in props("herald-os", title), title


def test_office_windows_tile_at_three_quarters_of_the_screen():
    mode = (DESKTOP / "electron" / "shell" / "mode.ts").read_text()
    titles = re.findall(r"(?:docs|sheets|slides): \{ title: '([^']+)'", mode)
    assert len(titles) == 3
    for title in titles:
        rules = props("herald-os", title)
        assert "default-column-width { proportion 0.75; }" in rules, title
        assert FLOATS not in rules, title


def test_the_pet_room_tiles_at_a_third_of_the_screen_beside_the_work_and_is_never_taken_for_the_pet():
    title = re.search(r"room: \{ title: '([^']+)'", (DESKTOP / "electron" / "shell" / "mode.ts").read_text()).group(1)
    for app_id in ("herald-os", "Herald OS"):
        rules = props(app_id, title)
        assert _last(rules, "default-column-width") == "default-column-width { proportion 0.33333; }"
        assert FLOATS not in rules
        assert "border { off; }" not in rules


def test_herald_calc_floats_over_the_work_at_the_size_the_shell_opens_it_with():
    calc = re.search(r"calc: \{ title: '([^']+)', width: (\d+), height: (\d+) \}", (DESKTOP / "electron" / "shell" / "mode.ts").read_text())
    title, width, height = calc.groups()
    assert (width, height) == ("780", "560")
    for app_id in ("herald-os", "Herald OS"):
        rules = props(app_id, title)
        assert FLOATS in rules
        assert _last(rules, "default-column-width") == f"default-column-width {{ fixed {width}; }}"
        assert _last(rules, "default-window-height") == f"default-window-height {{ fixed {height}; }}"
        # A rounded glass tile like the shell's other apps, not a frameless surface.
        assert _last(rules, "geometry-corner-radius") == "geometry-corner-radius 14"
        assert "border { off; }" not in rules
    # The rule is Calc's alone: the Hermes window and the other apps still tile.
    for other in ("Herald OS", "Herald OS · Sheets", "Herald OS · Pet Room"):
        assert FLOATS not in props("herald-os", other), other


def test_the_audience_window_opens_full_screen_and_leaves_the_keys_to_the_presenter_view():
    title = re.search(r"const AUDIENCE_TITLE = '([^']+)'", (DESKTOP / "electron" / "office" / "presenter.ts").read_text()).group(1)
    rules = props("herald-os", title)
    assert "open-fullscreen true" in rules
    assert "open-focused false" in rules
    assert FLOATS not in rules


def _last(rules, name):
    """What a window ends up with for one property: niri lets a later rule override an earlier one."""
    lines = [line for line in rules if line.split(" ", 1)[0] == name]
    return lines[-1] if lines else None


def test_the_pet_floats_above_the_dock_never_takes_the_keys_as_it_opens_and_has_no_frame():
    title = re.search(r"pet: '([^']+)'", (DESKTOP / "electron" / "shell" / "mode.ts").read_text()).group(1)
    for app_id in ("herald-os", "Herald OS"):
        rules = props(app_id, title)
        assert FLOATS in rules
        assert _last(rules, "open-focused") == "open-focused false"
        assert _last(rules, "default-floating-position") == 'default-floating-position x=24 y=104 relative-to="bottom-right"'
        assert _last(rules, "border") == "border { off; }"
        assert _last(rules, "focus-ring") == "focus-ring { off; }"
        assert _last(rules, "shadow") == "shadow { off; }"
        # Rounded or clipped like the shell's tiles, the sprite would lose its corners.
        assert _last(rules, "geometry-corner-radius") == "geometry-corner-radius 0"
        assert _last(rules, "clip-to-geometry") == "clip-to-geometry false"


def test_the_dock_menu_floats_above_the_dock_leaves_the_keys_to_it_and_has_no_frame():
    mode = (DESKTOP / "electron" / "shell" / "mode.ts").read_text()
    title = re.search(r"DOCK_MENU_TITLE = '([^']+)'", mode).group(1)
    dock = re.search(r"dock: '([^']+)'", mode).group(1)
    for app_id in ("herald-os", "Herald OS"):
        rules = props(app_id, title)
        assert FLOATS in rules
        # Opened with the keys, it would pull the pointer to it (warp-mouse-to-focus).
        assert _last(rules, "open-focused") == "open-focused false"
        # The shell's geometry puts the menu over the Dock's middle icon exactly there.
        assert _last(rules, "default-floating-position") == 'default-floating-position x=0 y=68 relative-to="bottom"'
        assert _last(rules, "border") == "border { off; }"
        assert _last(rules, "focus-ring") == "focus-ring { off; }"
        assert _last(rules, "shadow") == "shadow { off; }"
        assert _last(rules, "geometry-corner-radius") == "geometry-corner-radius 0"
        assert _last(rules, "clip-to-geometry") == "clip-to-geometry false"
        # And the Dock keeps its own place.
        assert _last(props(app_id, dock), "default-floating-position") == 'default-floating-position x=0 y=0 relative-to="bottom"'


def test_super_ctrl_h_hides_or_shows_the_pet():
    binds = [line.strip() for line in CONFIG.splitlines() if line.strip().startswith("Mod+Ctrl+H ")]
    assert binds == ['Mod+Ctrl+H hotkey-overlay-title="Hide or show the pet" repeat=false { spawn "herald-os" "os" "pet.toggle"; }']
