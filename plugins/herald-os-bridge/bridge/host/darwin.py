"""macOS host adapter built on the tools every Mac ships with: ``mdfind``, ``open``, ``lsof``,
``ps``, ``du``, ``osascript``, ``sw_vers``, ``sysctl``, ``vm_stat``, ``df``, ``pmset``."""

from __future__ import annotations

import json
import os
import plistlib
import re
import signal
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Sequence

from ..crash import MAC_REPORT_DIRS, is_crash_header, resolve_mac_report, summarise_ips
from ..documents import EMPTY_PAGE_CHARS, DocumentText, document_type
from ..util import ExecResult, run
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, PortListener, ProcessRow
from .posix import parse_du, parse_ps  # noqa: F401 - shared with Linux; re-exported for callers/tests.

APP_DIRS = ("/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", str(Path.home() / "Applications"))

# Spotlight metadata attribute queries per FileSearch.kind.
_KIND_QUERIES: dict[str, str] = {
    "image": 'kMDItemContentTypeTree == "public.image"',
    "screenshot": 'kMDItemIsScreenCapture == 1',
    "document": '(kMDItemContentTypeTree == "public.composite-content" || kMDItemContentTypeTree == "public.text" || kMDItemContentTypeTree == "com.microsoft.word.doc" || kMDItemContentTypeTree == "org.openxmlformats.wordprocessingml.document")',
    "pdf": 'kMDItemContentType == "com.adobe.pdf"',
    "video": 'kMDItemContentTypeTree == "public.movie"',
    "audio": 'kMDItemContentTypeTree == "public.audio"',
    "folder": 'kMDItemContentType == "public.folder"',
    "code": 'kMDItemContentTypeTree == "public.source-code"',
    "archive": 'kMDItemContentTypeTree == "public.archive"',
}


def _applescript_string(value: str) -> str:
    """Escape for interpolation inside an AppleScript double-quoted literal."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


# osascript exits 1 for every AppleScript error, so a refused Apple Event is only visible in stderr:
# -1743 (the person refused, or turned the switch off) and -1744 (macOS would have to ask first).
_APPLE_EVENTS_REFUSED = ("-1743", "-1744", "not authorized to send apple events", "not allowed to send apple events")


def apple_events_refused(stderr: str) -> bool:
    text = stderr.lower()
    return any(marker in text for marker in _APPLE_EVENTS_REFUSED)


def osascript_error(result: ExecResult, target: str, fallback: str) -> RuntimeError:
    """The error for a failed ``osascript`` call, naming the Automation switch when macOS refused it."""
    if apple_events_refused(result.stderr):
        return RuntimeError(
            f"macOS did not let Herald OS control {target}: turn on {target} under Herald OS in "
            "System Settings > Privacy & Security > Automation, then try again"
        )
    return RuntimeError(result.stderr.strip() or fallback)


FORCE_QUIT_GRACE = 2.0

# Processes that keep the session running (quitting one could sign the person out, blank the
# screen or drop a password prompt), System Events (which the bridge drives), and Herald OS itself,
# by name and by bundle id. Neither kind of quit ever reaches them.
SESSION_PROCESSES = frozenset({
    "loginwindow", "com.apple.loginwindow",
    "windowserver", "com.apple.windowserver",
    "dock", "com.apple.dock",
    "systemuiserver", "com.apple.systemuiserver",
    "controlcenter", "control center", "com.apple.controlcenter",
    "notificationcenter", "notification center", "com.apple.notificationcenterui",
    "securityagent", "com.apple.securityagent",
    "system events", "com.apple.systemevents",
})
HERALD_OS = frozenset({"herald os", "dev.iamluke.heraldos"})


# Safari and the apps updated with it run from a cryptex (a sealed, system-signed copy) since macOS
# 13, so ps shows them under one of these roots rather than /Applications.
CRYPTEX_APP_ROOTS = ("/System/Cryptexes/App/System/Applications", "/System/Volumes/Preboot/Cryptexes/App/System/Applications")


def bundle_executables(app_path: str) -> tuple[str, ...]:
    """Where the main executable of an app in an Applications folder may run from: its bundle's
    ``Contents/MacOS/``, and the same bundle in the system cryptex. Empty for any other path."""
    path = os.path.normpath(app_path or "")
    roots = ("/Applications", "/System/Applications", str(Path.home() / "Applications"))
    if not path.endswith(".app") or not any(path.startswith(f"{root}/") for root in roots):
        return ()
    bundles = [path]
    if os.path.dirname(path) in ("/Applications", "/System/Applications"):
        bundles += [f"{root}/{os.path.basename(path)}" for root in CRYPTEX_APP_ROOTS]
    return tuple(f"{bundle}/Contents/MacOS/" for bundle in bundles)


def ps_error(result: ExecResult) -> RuntimeError:
    return RuntimeError(f"could not read the process list (ps: {result.stderr.strip() or f'exit {result.code}'})")


def parse_pid_uid_comm(text: str) -> list[tuple[int, int, str]]:
    """``ps -o pid=,uid=,comm=`` lines -> (pid, uid, executable); the executable may hold spaces."""
    rows: list[tuple[int, int, str]] = []
    for line in text.splitlines():
        match = re.match(r"^\s*(\d+)\s+(\d+)\s+(.+?)\s*$", line)
        if match:
            rows.append((int(match[1]), int(match[2]), match[3]))
    return rows


def _mdfind_date(value: str, end_of_day: bool) -> str:
    """Spotlight wants ``$time.iso(...)``; accept ISO dates or datetimes."""
    value = value.strip()
    try:
        if len(value) == 10:
            dt = datetime.fromisoformat(value)
            if end_of_day:
                dt = dt + timedelta(days=1)
        else:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid date '{value}' (use YYYY-MM-DD or ISO 8601)") from exc
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return f'$time.iso("{dt.strftime("%Y-%m-%dT%H:%M:%S")}")'


def build_mdfind_query(search: FileSearch) -> str:
    """Compose the Spotlight predicate for a structured search (pure; unit-tested)."""
    clauses: list[str] = []
    kind = search.kind or "any"
    if kind != "any":
        clauses.append(_KIND_QUERIES[kind])
    if search.name:
        name = search.name.replace('"', '\\"')
        clauses.append(f'kMDItemFSName == "*{name}*"cd')
    if search.extensions:
        exts = " || ".join(f'kMDItemFSName == "*.{e.lstrip(".")}"c' for e in search.extensions)
        clauses.append(f"({exts})")
    if search.since:
        clauses.append(f"kMDItemContentCreationDate >= {_mdfind_date(search.since, False)}")
    if search.until:
        clauses.append(f"kMDItemContentCreationDate < {_mdfind_date(search.until, True)}")
    if search.text:
        text = search.text.replace('"', '\\"')
        clauses.append(f'(kMDItemTextContent == "*{text}*"cd || kMDItemDisplayName == "*{text}*"cd)')
    if not clauses:
        raise ValueError("search needs at least one of: text, name, kind, since/until, extensions")
    return " && ".join(clauses)


def parse_lsof(text: str, port: int) -> list[PortListener]:
    """Parse ``lsof -nP -iTCP:PORT -sTCP:LISTEN`` (and UDP) output."""
    out: list[PortListener] = []
    seen: set[tuple[int, int]] = set()
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 9:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        key = (pid, port)
        if key in seen:
            continue
        seen.add(key)
        out.append(PortListener(pid=pid, command=parts[0], user=parts[2], port=port, protocol=parts[7].lower()))
    return out


SETTINGS_PANES: dict[str, str] = {
    "general": "com.apple.systempreferences.GeneralSettings",
    "appearance": "com.apple.Appearance-Settings.extension",
    "accessibility": "com.apple.Accessibility-Settings.extension",
    "control_center": "com.apple.ControlCenter-Settings.extension",
    "desktop_and_dock": "com.apple.Desktop-Settings.extension",
    "displays": "com.apple.Displays-Settings.extension",
    "wallpaper": "com.apple.Wallpaper-Settings.extension",
    "screen_saver": "com.apple.ScreenSaver-Settings.extension",
    "battery": "com.apple.Battery-Settings.extension",
    "lock_screen": "com.apple.Lock-Screen-Settings.extension",
    "privacy_and_security": "com.apple.settings.PrivacySecurity.extension",
    "privacy": "com.apple.settings.PrivacySecurity.extension",
    "security": "com.apple.settings.PrivacySecurity.extension",
    "screen_recording": "com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
    "accessibility_privacy": "com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
    "automation": "com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
    "full_disk_access": "com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
    "microphone": "com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
    "camera": "com.apple.settings.PrivacySecurity.extension?Privacy_Camera",
    "calendars": "com.apple.settings.PrivacySecurity.extension?Privacy_Calendars",
    "input_monitoring": "com.apple.settings.PrivacySecurity.extension?Privacy_ListenEvent",
    "touch_id": "com.apple.Touch-ID-Settings.extension",
    "users_and_groups": "com.apple.Users-Groups-Settings.extension",
    "passwords": "com.apple.Passwords-Settings.extension",
    "internet_accounts": "com.apple.Internet-Accounts-Settings.extension",
    "wifi": "com.apple.wifi-settings-extension",
    "bluetooth": "com.apple.BluetoothSettings",
    "network": "com.apple.Network-Settings.extension",
    "notifications": "com.apple.Notifications-Settings.extension",
    "sound": "com.apple.Sound-Settings.extension",
    "focus": "com.apple.Focus-Settings.extension",
    "screen_time": "com.apple.Screen-Time-Settings.extension",
    "keyboard": "com.apple.Keyboard-Settings.extension",
    "trackpad": "com.apple.Trackpad-Settings.extension",
    "mouse": "com.apple.Mouse-Settings.extension",
    "printers": "com.apple.Print-Scan-Settings.extension",
    "software_update": "com.apple.Software-Update-Settings.extension",
    "storage": "com.apple.settings.Storage",
    "date_and_time": "com.apple.Date-Time-Settings.extension",
    "sharing": "com.apple.Sharing-Settings.extension",
    "siri": "com.apple.Siri-Settings.extension",
    "login_items": "com.apple.LoginItems-Settings.extension",
    "extensions": "com.apple.ExtensionsPreferences",
    "game_center": "com.apple.Game-Center-Settings.extension",
}


def parse_hardware_ports(text: str) -> list[dict[str, str]]:
    """``networksetup -listallhardwareports`` blocks -> [{name, device, mac}]."""
    ports: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("Hardware Port:"):
            current = {"name": line.split(":", 1)[1].strip()}
        elif line.startswith("Device:") and current:
            current["device"] = line.split(":", 1)[1].strip()
        elif line.startswith("Ethernet Address:") and current:
            current["mac"] = line.split(":", 1)[1].strip()
            if "device" in current:
                ports.append(current)
            current = {}
    return ports


def parse_airport(json_text: str) -> dict[str, Any] | None:
    """``system_profiler SPAirPortDataType -json`` -> the station interface's connection summary."""
    try:
        data = json.loads(json_text or "{}")
        interfaces = data["SPAirPortDataType"][0]["spairport_airport_interfaces"]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    for entry in interfaces:
        if entry.get("_name", "").startswith("awdl"):
            continue
        status = str(entry.get("spairport_status_information", ""))
        net = entry.get("spairport_current_network_information") or {}
        ssid = net.get("_name")
        return {
            "interface": entry.get("_name"),
            "connected": status.endswith("connected"),
            "ssid": None if not ssid or "redacted" in str(ssid) else ssid,
            "phy_mode": net.get("spairport_network_phymode"),
            "channel": net.get("spairport_network_channel"),
            "rate_mbps": net.get("spairport_network_rate"),
            "signal_noise": net.get("spairport_signal_noise"),
            "security": (net.get("spairport_security_mode") or "").replace("spairport_security_mode_", "") or None,
        }
    return None


def parse_bluetooth(json_text: str) -> dict[str, Any]:
    """``system_profiler SPBluetoothDataType -json`` -> power + connected / paired device names."""
    try:
        data = json.loads(json_text or "{}")["SPBluetoothDataType"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return {"powered_on": None, "connected": [], "paired": []}
    state = str((data.get("controller_properties") or {}).get("controller_state", ""))
    names = lambda key: [name for item in (data.get(key) or []) for name in item.keys()]  # noqa: E731
    return {"powered_on": state.endswith("on") if state else None, "connected": names("device_connected"), "paired": names("device_not_connected")}


def parse_volume_settings(text: str) -> dict[str, Any]:
    """``get volume settings`` -> {output_volume, input_volume, alert_volume, muted}."""
    out: dict[str, Any] = {}
    for key, label in (("output_volume", "output volume"), ("input_volume", "input volume"), ("alert_volume", "alert volume")):
        match = re.search(rf"{label}:(\d+)", text)
        out[key] = int(match[1]) if match else None
    muted = re.search(r"output muted:(true|false)", text)
    out["muted"] = muted[1] == "true" if muted else None
    return out


# PDF text page by page through PDFKit, and on-device text recognition through Vision for pages that
# are pictures of text (scans) and for images. Both ship with macOS, so nothing is installed; the same
# JavaScript-for-Automation approach as the shell's screen-text reader. Prints ASCII-only JSON.
DOCUMENT_SCRIPT = r"""ObjC.import('Foundation')
ObjC.import('AppKit')
ObjC.import('PDFKit')
ObjC.import('Vision')
function recognise(handler) {
  const request = $.VNRecognizeTextRequest.alloc.init
  request.recognitionLevel = 0
  request.usesLanguageCorrection = true
  const error = $()
  if (!handler.performRequestsError($.NSArray.arrayWithObject(request), error)) {
    throw new Error(error.localizedDescription ? error.localizedDescription.js : 'Vision could not read the page')
  }
  const lines = []
  const results = request.results
  for (let i = 0; i < results.count; i++) lines.push(results.objectAtIndex(i).topCandidates(1).objectAtIndex(0).string.js)
  return lines.join('\n')
}
function ascii(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4))
}
function run(argv) {
  const [kind, file, maxPages, ocrFlag, minChars] = argv
  const ocr = ocrFlag === '1'
  const url = $.NSURL.fileURLWithPath(file)
  if (kind === 'image') {
    if (!ocr) return ascii({ count: 1, pages: [''], ocr: [], notes: ['OCR is off and an image has no text layer.'] })
    return ascii({ count: 1, pages: [recognise($.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary))], ocr: [1], notes: [] })
  }
  const doc = $.PDFDocument.alloc.initWithURL(url)
  if (!doc || doc.isNil()) return ascii({ error: 'not a readable PDF' })
  const count = Number(doc.pageCount)
  if (doc.isLocked) return ascii({ error: 'the PDF is password protected', count })
  const pages = []
  const used = []
  const notes = []
  for (let i = 0; i < Math.min(count, Number(maxPages)); i++) {
    const page = doc.pageAtIndex(i)
    const text = page.string
    let value = text && !text.isNil() ? text.js : ''
    if (ocr && value.replace(/\s/g, '').length < Number(minChars)) {
      try {
        const box = page.boundsForBox(0)
        const scale = 2200 / Math.max(box.size.width, box.size.height, 1)
        const image = page.thumbnailOfSizeForBox($.NSMakeSize(box.size.width * scale, box.size.height * scale), 0)
        value = recognise($.VNImageRequestHandler.alloc.initWithDataOptions(image.TIFFRepresentation, $.NSDictionary.dictionary))
        used.push(i + 1)
      } catch (e) {
        notes.push('Page ' + (i + 1) + ' could not be read with OCR: ' + e.message)
      }
    }
    pages.push(value)
  }
  return ascii({ count, pages, ocr: used, notes })
}
"""


def parse_document_output(stdout: str, kind: str) -> DocumentText:
    """The document script's JSON -> DocumentText; a reported error raises (pure; tested)."""
    try:
        data = json.loads(stdout.strip() or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"PDFKit returned unreadable output: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("PDFKit returned an unexpected reply")
    if data.get("error"):
        raise RuntimeError(str(data["error"]))
    pages = [str(page) for page in data.get("pages") or []]
    ocr_pages = [int(n) for n in data.get("ocr") or []]
    engine = "Vision" if kind == "image" else "PDFKit + Vision" if ocr_pages else "PDFKit"
    return DocumentText(pages=pages, page_count=int(data.get("count") or len(pages)), ocr_pages=ocr_pages, engine=engine, notes=[str(n) for n in data.get("notes") or []])


def parse_displays(json_text: str) -> list[dict[str, Any]]:
    try:
        gpus = json.loads(json_text or "{}")["SPDisplaysDataType"]
    except (KeyError, TypeError, ValueError):
        return []
    displays = []
    for gpu in gpus:
        for disp in gpu.get("spdisplays_ndrvs") or []:
            displays.append({
                "name": disp.get("_name"),
                "resolution": disp.get("_spdisplays_resolution") or disp.get("spdisplays_resolution"),
                "main": str(disp.get("spdisplays_main", "")).endswith("yes"),
                "connection": (disp.get("spdisplays_connection_type") or "").replace("spdisplays_", "") or None,
            })
    return displays


class DarwinHost(HostAdapter):
    platform = "darwin"

    # --- read -------------------------------------------------------------------------------
    def system_info(self) -> dict[str, Any]:
        name = run(["sw_vers", "-productName"]).stdout.strip() or "macOS"
        version = run(["sw_vers", "-productVersion"]).stdout.strip()
        build = run(["sw_vers", "-buildVersion"]).stdout.strip()
        chip = run(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.strip()
        cores = run(["sysctl", "-n", "hw.ncpu"]).stdout.strip()
        mem_bytes = int(run(["sysctl", "-n", "hw.memsize"]).stdout.strip() or 0)
        vm = run(["vm_stat"]).stdout
        page = re.search(r"page size of (\d+)", vm)
        page_size = int(page[1]) if page else 16384

        def pages(label: str) -> int:
            m = re.search(rf"{label}:\s+(\d+)", vm)
            return int(m[1]) if m else 0

        used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page_size
        load = run(["sysctl", "-n", "vm.loadavg"]).stdout.strip().strip("{} ").split()
        uptime = run(["sysctl", "-n", "kern.boottime"]).stdout
        boot = re.search(r"sec = (\d+)", uptime)
        uptime_s = int(datetime.now().timestamp() - int(boot[1])) if boot else None
        disks = []
        for line in run(["df", "-kP"]).stdout.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 6 and (parts[5] == "/" or parts[5].startswith("/Volumes/")):
                disks.append({"mount": parts[5], "total_bytes": int(parts[1]) * 1024, "used_bytes": int(parts[2]) * 1024, "free_bytes": int(parts[3]) * 1024})
        batt = run(["pmset", "-g", "batt"]).stdout
        battery = None
        m = re.search(r"(\d+)%;\s*([a-zA-Z ]+?);", batt)
        if m:
            battery = {"percent": int(m[1]), "state": m[2].strip()}
        return {
            "os": f"{name} {version}", "build": build, "hostname": os.uname().nodename, "arch": os.uname().machine,
            "chip": chip, "cpu_cores": int(cores or 0),
            "memory_total_bytes": mem_bytes, "memory_used_bytes": used,
            "load_average": [float(x) for x in load[:3]] if load else None,
            "uptime_seconds": uptime_s, "disks": disks, "battery": battery,
            "user": os.environ.get("USER"), "home": str(Path.home()),
        }

    def _ps(self) -> list[ProcessRow]:
        result = run(["ps", "-Axo", "pid=,ppid=,user=,%cpu=,%mem=,rss=,comm="])
        if not result.ok:
            raise ps_error(result)
        return parse_ps(result.stdout)

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        rows = self._ps()
        rows.sort(key=(lambda r: r.cpu_percent) if sort == "cpu" else (lambda r: r.rss_bytes), reverse=True)
        return rows[:limit]

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        needle = name.lower()
        rows = [r for r in self._ps() if needle in r.command.lower()]
        rows.sort(key=lambda r: r.cpu_percent, reverse=True)
        return rows[:limit]

    def listeners_on_port(self, port: int) -> list[PortListener]:
        tcp = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"]).stdout
        udp = run(["lsof", "-nP", f"-iUDP:{port}"]).stdout
        return parse_lsof(tcp, port) + parse_lsof(udp, port)

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        result = run(["du", "-k", "-d", str(depth), str(path)], timeout=timeout)
        rows = parse_du(result.stdout)
        total = next((b for b, p in rows if p.rstrip("/") == str(path).rstrip("/")), None)
        children = sorted((r for r in rows if r[1].rstrip("/") != str(path).rstrip("/")), key=lambda r: r[0], reverse=True)
        return {
            "path": str(path), "total_bytes": total, "timed_out": result.code == 124,
            "entries": [{"path": p, "bytes": b} for b, p in children[:limit]],
            "note": "Sizes exclude items du could not read (permission denied)." if "Permission denied" in result.stderr else None,
        }

    def find_files(self, query: FileSearch) -> list[FoundFile]:
        predicate = build_mdfind_query(query)
        argv = ["mdfind"]
        if query.scope:
            argv += ["-onlyin", str(Path(os.path.expanduser(query.scope)))]
        argv.append(predicate)
        result = run(argv, timeout=30)
        found: list[FoundFile] = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            if len(found) >= max(1, query.limit):
                break
            p = Path(line)
            try:
                st = p.stat()
                found.append(FoundFile(path=line, size=st.st_size, modified=datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"), kind="folder" if p.is_dir() else "file"))
            except OSError:
                found.append(FoundFile(path=line))
        found.sort(key=lambda f: f.modified or "", reverse=True)
        return found

    def installed_apps(self) -> list[AppInfo]:
        apps: dict[str, AppInfo] = {}
        for directory in APP_DIRS:
            try:
                entries = sorted(os.listdir(directory))
            except OSError:
                continue
            for entry in entries:
                if entry.endswith(".app") and not entry.startswith("."):
                    name = entry[:-4]
                    apps.setdefault(name, AppInfo(name=name, path=os.path.join(directory, entry), bundle_id=self._bundle_id(os.path.join(directory, entry))))
        return sorted(apps.values(), key=lambda a: a.name.lower())

    @staticmethod
    def _bundle_id(app_path: str) -> str | None:
        try:
            with open(os.path.join(app_path, "Contents", "Info.plist"), "rb") as fh:
                return plistlib.load(fh).get("CFBundleIdentifier")
        except Exception:  # noqa: BLE001
            return None

    def running_apps(self) -> list[AppInfo]:
        script = 'tell application "System Events" to get {name, unix id} of (every application process whose background only is false)'
        result = run(["osascript", "-e", script], timeout=10)
        if not result.ok:
            raise osascript_error(result, "System Events", "could not list the running apps")
        # Output: "Finder, Safari, ..., 123, 456, ..." (names then pids).
        parts = [p.strip() for p in result.stdout.strip().split(",")]
        half = len(parts) // 2
        names, pids = parts[:half], parts[half:]
        apps: list[AppInfo] = []
        for name, pid in zip(names, pids):
            try:
                apps.append(AppInfo(name=name, path="", running=True, pid=int(pid)))
            except ValueError:
                apps.append(AppInfo(name=name, path="", running=True))
        return apps

    # --- act --------------------------------------------------------------------------------
    def resolve_app(self, name: str) -> AppInfo | None:
        needle = name.strip().lower().removesuffix(".app")
        candidates = self.installed_apps()
        for app in candidates:
            if app.name.lower() == needle:
                return app
        for app in candidates:
            if needle in app.name.lower() or (app.bundle_id and needle == app.bundle_id.lower()):
                return app
        return None

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        app = self.resolve_app(name)
        target = app.path if app else name
        result = run(["open", "-a", target, *(["--args", *args] if args else [])], timeout=20)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not open {name}")

    def open_url(self, url: str, app: str | None = None) -> None:
        argv = ["open"]
        if app:
            resolved = self.resolve_app(app)
            argv += ["-a", resolved.path if resolved else app]
        argv.append(url)
        result = run(argv, timeout=20)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not open {url}")

    def open_path(self, path: Path, app: str | None = None) -> None:
        argv = ["open"]
        if app:
            resolved = self.resolve_app(app)
            argv += ["-a", resolved.path if resolved else app]
        argv.append(str(path))
        result = run(argv, timeout=20)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not open {path}")

    def reveal(self, path: Path) -> None:
        result = run(["open", "-R", str(path)], timeout=20)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not reveal {path}")

    def _resolve_exact(self, name: str) -> AppInfo | None:
        """An installed app by its exact name or bundle id (force quit never guesses)."""
        needle = name.strip().lower().removesuffix(".app")
        for app in self.installed_apps():
            if app.name.lower() == needle or (app.bundle_id and app.bundle_id.lower() == needle):
                return app
        return None

    def _own_app_processes(self, bundles: tuple[str, ...], pid: int | None = None) -> list[int]:
        """This user's processes running the app's main executable, read with ``ps`` (no
        Automation permission needed); with ``pid``, whether that one process still is. A ``ps``
        that fails raises rather than reading as "not running"."""
        argv = ["ps", "-o", "pid=,uid=,comm="] + (["-p", str(pid)] if pid is not None else ["-U", str(os.getuid())])
        result = run(argv, timeout=10)
        # `ps -p` exits 1 with no output at all when the process has gone.
        if not result.ok and not (pid is not None and result.code == 1 and not result.stdout.strip() and not result.stderr.strip()):
            raise ps_error(result)
        rows = parse_pid_uid_comm(result.stdout)
        excluded = {0, 1, os.getpid(), os.getppid()}
        return sorted({p for p, uid, command in rows if uid == os.getuid() and command.startswith(bundles) and p not in excluded})

    def _terminate(self, label: str, bundles: tuple[str, ...], pids: list[int]) -> None:
        """TERM, up to ``FORCE_QUIT_GRACE`` seconds to exit, then KILL; each process is checked
        again right before each signal, so a reused pid is never hit. If ``ps`` fails partway, the
        error names the signals already sent, since the app may be half stopped."""
        denied: set[int] = set()
        sent: list[str] = []

        def send(sig: signal.Signals, targets: list[int]) -> None:
            for pid in targets:
                if pid in denied or not self._own_app_processes(bundles, pid):
                    continue
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    continue
                except PermissionError:
                    denied.add(pid)
                    continue
                sent.append(f"{sig.name.removeprefix('SIG')} to process {pid}")

        try:
            send(signal.SIGTERM, pids)
            deadline = time.monotonic() + FORCE_QUIT_GRACE
            remaining = [p for p in pids if p not in denied]
            while remaining and time.monotonic() < deadline:
                time.sleep(0.2)
                remaining = [p for p in remaining if self._own_app_processes(bundles, p)]
            send(signal.SIGKILL, remaining)
        except RuntimeError as exc:
            if not sent:
                raise
            raise RuntimeError(f"{exc} while force quitting {label}, after sending {', '.join(sent)}") from exc
        if denied:
            raise RuntimeError(f"macOS did not let Herald OS stop {label} (process {', '.join(str(p) for p in sorted(denied))})")

    @staticmethod
    def _refuse_protected(*names: str | None) -> None:
        """Refuse the session processes and Herald OS itself, whichever name or bundle id names them."""
        for name in names:
            key = (name or "").strip().lower().removesuffix(".app")
            if key in HERALD_OS:
                raise RuntimeError("Herald OS does not quit itself")
            if key in SESSION_PROCESSES:
                raise RuntimeError(f"{name.strip()} is part of macOS and is never quit by Herald OS")

    def _quit_by_name(self, label: str) -> bool:
        """Ask an app to quit through AppleScript alone (Finder, one in ~/Downloads); False when no
        app by that name is open. ``is running`` asks Launch Services, so an app that is not open is
        never launched just to be told to quit."""
        quoted = _applescript_string(label)
        script = f'if application "{quoted}" is running then\ntell application "{quoted}" to quit\nreturn "quit"\nend if\nreturn "not running"'
        result = run(["osascript", "-e", script], timeout=20)
        if not result.ok:
            raise osascript_error(result, label, f"could not quit {label}")
        return result.stdout.strip() == "quit"

    def quit_app(self, name: str, force: bool) -> None:
        label = name.strip()
        self._refuse_protected(label)
        app = self._resolve_exact(label)
        if app is not None:
            self._refuse_protected(app.name, app.bundle_id)
        if force:
            bundles = bundle_executables(app.path) if app else ()
            if app is None:
                raise RuntimeError(f"no app called {label} in the Applications folders (force quit needs the app's exact name or bundle id)")
            if not bundles:
                raise RuntimeError(f"{app.name} is not in an Applications folder")
            pids = self._own_app_processes(bundles)
            if not pids:
                raise RuntimeError(f"{app.name} is not running")
            self._terminate(app.name, bundles, pids)
            return
        # Polite: the exact app, then an app open under exactly that name, and only then a partial
        # match, so "Dock" can never reach Docker.
        if app is None:
            if self._quit_by_name(label):
                return
            app = self.resolve_app(label)
            if app is None:
                raise RuntimeError(f"{label} is not running")
            self._refuse_protected(app.name, app.bundle_id)
        bundles = bundle_executables(app.path)
        if not bundles:
            if not self._quit_by_name(app.name):
                raise RuntimeError(f"{app.name} is not running")
            return
        if not self._own_app_processes(bundles):
            raise RuntimeError(f"{app.name} is not running")
        result = run(["osascript", "-e", f'tell application "{_applescript_string(app.name)}" to quit'], timeout=20)
        if not result.ok:
            raise osascript_error(result, app.name, f"could not quit {app.name}")

    # --- system state (read) -----------------------------------------------------------------
    def network_status(self) -> dict[str, Any]:
        default = run(["route", "-n", "get", "default"], timeout=5).stdout
        iface = (re.search(r"interface:\s*(\S+)", default) or [None, None])[1]
        gateway = (re.search(r"gateway:\s*(\S+)", default) or [None, None])[1]
        ports = parse_hardware_ports(run(["networksetup", "-listallhardwareports"], timeout=10).stdout)
        interfaces = []
        for port in ports:
            addr = run(["ipconfig", "getifaddr", port["device"]], timeout=5).stdout.strip()
            if addr or port["device"] == iface:
                interfaces.append({**port, "ipv4": addr or None, "default_route": port["device"] == iface})
        wifi = parse_airport(run(["system_profiler", "SPAirPortDataType", "-json"], timeout=20).stdout)
        dns = sorted({m for m in re.findall(r"nameserver\[\d+\]\s*:\s*(\S+)", run(["scutil", "--dns"], timeout=5).stdout)})
        return {
            "online": bool(iface), "default_interface": iface, "gateway": gateway, "dns": dns[:6],
            "interfaces": interfaces, "wifi": wifi,
            "note": "macOS hides the Wi-Fi network name unless Location Services is granted to the process." if wifi and wifi.get("connected") and not wifi.get("ssid") else None,
        }

    def bluetooth_status(self) -> dict[str, Any]:
        return parse_bluetooth(run(["system_profiler", "SPBluetoothDataType", "-json"], timeout=20).stdout)

    def audio_status(self) -> dict[str, Any]:
        out = run(["osascript", "-e", "get volume settings"], timeout=10).stdout
        return parse_volume_settings(out)

    def appearance_status(self) -> dict[str, Any]:
        style = run(["defaults", "read", "-g", "AppleInterfaceStyle"], timeout=5)
        dark = style.ok and "dark" in style.stdout.lower()
        displays = run(["system_profiler", "SPDisplaysDataType", "-json"], timeout=20).stdout
        return {"dark_mode": dark, "displays": parse_displays(displays)}

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        predicates = {"error": "messageType == 16", "fault": "messageType == 17", "any": None}
        clauses = [predicates.get(level, "messageType == 16")]
        if process:
            clauses.append(f'process == "{_applescript_string(process)}"')
        predicate = " AND ".join(c for c in clauses if c)
        argv = ["log", "show", "--last", f"{minutes}m", "--style", "compact"]
        if predicate:
            argv += ["--predicate", predicate]
        result = run(argv, timeout=60)
        lines = [ln for ln in result.stdout.splitlines() if ln.strip() and not ln.startswith(("Filtering", "Timestamp"))]
        return lines[-limit:]

    def crash_reports(self, limit: int) -> list[dict[str, Any]]:
        files: list[tuple[float, Path]] = []
        for base in MAC_REPORT_DIRS:
            try:
                files.extend((entry.stat().st_mtime, entry) for entry in base.glob("*.ips"))
            except OSError:
                continue
        out: list[dict[str, Any]] = []
        for mtime, entry in sorted(files, reverse=True):
            try:
                with entry.open("r", errors="replace") as handle:
                    header = json.loads(handle.readline() or "{}")
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(header, dict) or not is_crash_header(header):
                continue
            out.append({"report": str(entry), "app": header.get("app_name") or header.get("name"), "time": datetime.fromtimestamp(mtime).isoformat(timespec="seconds")})
            if len(out) >= limit:
                break
        return out

    def crash_report(self, ref: str) -> dict[str, Any]:
        path = resolve_mac_report(ref)
        return {"report": str(path), **summarise_ips(path.read_text(errors="replace"))}

    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        kind = document_type(path) or "pdf"
        argv = ["osascript", "-l", "JavaScript", "-e", DOCUMENT_SCRIPT, kind, str(path), str(max_pages), "1" if ocr else "0", str(EMPTY_PAGE_CHARS)]
        result = run(argv, timeout=20.0 + 10.0 * max_pages, encoding="utf-8")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"PDFKit could not read {path.name}")
        return parse_document_output(result.stdout, kind)

    # --- system control ----------------------------------------------------------------------
    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        if percent is not None:
            run(["osascript", "-e", f"set volume output volume {max(0, min(100, int(percent)))}"], timeout=10)
        if muted is not None:
            run(["osascript", "-e", f"set volume output muted {'true' if muted else 'false'}"], timeout=10)
        return self.audio_status()

    def set_dark_mode(self, enabled: bool) -> None:
        result = run(["osascript", "-e", f'tell application "System Events" to tell appearance preferences to set dark mode to {"true" if enabled else "false"}'], timeout=15)
        if not result.ok:
            raise osascript_error(result, "System Events", "could not change appearance")

    def open_settings(self, pane: str) -> str:
        key = pane.strip().lower().replace(" ", "_").replace("&", "and")
        target = SETTINGS_PANES.get(key)
        if target is None:
            for name, value in SETTINGS_PANES.items():
                if key in name:
                    target = value
                    break
        if target is None:
            raise ValueError(f"unknown settings pane '{pane}'. Known: {', '.join(sorted(SETTINGS_PANES))}")
        result = run(["open", f"x-apple.systempreferences:{target}"], timeout=15)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not open System Settings")
        return target

    def lock_screen(self) -> None:
        result = run(["osascript", "-e", 'tell application "System Events" to keystroke "q" using {command down, control down}'], timeout=10)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not lock the screen (grant Accessibility permission)")

    def sleep_display(self) -> None:
        result = run(["pmset", "displaysleepnow"], timeout=10)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not sleep the display")

    def set_wifi_power(self, enabled: bool) -> None:
        ports = parse_hardware_ports(run(["networksetup", "-listallhardwareports"], timeout=10).stdout)
        wifi = next((p for p in ports if "wi-fi" in p["name"].lower() or "airport" in p["name"].lower()), None)
        if not wifi:
            raise RuntimeError("no Wi-Fi interface found")
        result = run(["networksetup", "-setairportpower", wifi["device"], "on" if enabled else "off"], timeout=15)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not change Wi-Fi power")

    # --- destructive ------------------------------------------------------------------------
    def kill(self, pid: int, force: bool) -> None:
        os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)

    def trash(self, paths: Sequence[Path]) -> None:
        # Finder's trash keeps the operation reversible; never `rm`.
        items = ", ".join(f'POSIX file "{_applescript_string(str(p))}"' for p in paths)
        script = f'tell application "Finder" to delete {{{items}}}'
        result = run(["osascript", "-e", script], timeout=30)
        if not result.ok:
            raise osascript_error(result, "Finder", "Finder refused to move items to the Trash")

    def notify(self, title: str, body: str) -> None:
        script = f'display notification "{_applescript_string(body)}" with title "{_applescript_string(title)}"'
        result = run(["osascript", "-e", script], timeout=10)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not show the notification")
