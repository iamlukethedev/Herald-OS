"""The keyring (Secret Service) on the image: the packages, the portal configuration, the
gnome-keyring unit, and `herald-os keyring`."""

import configparser
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "linux" / "bin" / "herald-os"
_LOADER = importlib.machinery.SourceFileLoader("herald_os_keyring_cli", str(CLI))
_SPEC = importlib.util.spec_from_loader("herald_os_keyring_cli", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)
LINUX = ROOT / "linux"
PACKAGES_SH = (LINUX / "image" / "packages.sh").read_text()
PORTALS = LINUX / "session" / "heraldos-portals.conf"
DROP_IN = LINUX / "session" / "gnome-keyring-daemon.conf"
# The package each portal backend comes from.
BACKENDS = {"gnome": "xdg-desktop-portal-gnome", "gtk": "xdg-desktop-portal-gtk", "gnome-keyring": "gnome-keyring"}
INTERFACE = re.compile(r"org\.freedesktop\.impl\.portal\.[A-Z][A-Za-z]+")
SYSTEM_PORTALS = Path("/usr/share/xdg-desktop-portal/portals")


def image_packages() -> list[str]:
    lines = (LINUX / "image" / "packages.txt").read_text().splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def preferred() -> dict[str, list[str]]:
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read_string(PORTALS.read_text())
    assert parser.sections() == ["preferred"]
    return {key: [name for name in value.split(";") if name] for key, value in parser["preferred"].items()}


def test_the_image_ships_a_secret_service_and_the_tools_around_it():
    packages = image_packages()
    for package in ("gnome-keyring", "libsecret", "python3-gobject-base", "xdg-desktop-portal", *BACKENDS.values()):
        assert package in packages, package
    # Weak dependencies stay out, so a recommended package (niri's gnome-keyring) is not enough.
    assert "--setopt=install_weak_deps=False" in PACKAGES_SH


def test_the_portal_file_is_named_after_the_session_s_desktop():
    desktop = "HeraldOS"
    assert f"export XDG_CURRENT_DESKTOP={desktop}" in (LINUX / "session" / "herald-os-compositor").read_text()
    assert f'XDG_CURRENT_DESKTOP "{desktop}"' in (LINUX / "niri" / "config.kdl").read_text()
    assert f"DesktopNames={desktop}" in (LINUX / "session" / "herald-os.desktop").read_text()
    # xdg-desktop-portal looks for <desktop, lowercased>-portals.conf.
    assert PORTALS.name == f"{desktop.lower()}-portals.conf"


def test_the_portal_file_names_only_backends_the_image_ships():
    packages = image_packages()
    choices = preferred()
    for key, names in choices.items():
        assert key == "default" or INTERFACE.fullmatch(key), key
        assert names, key
        for name in names:
            assert name in BACKENDS, f"{key}: {name}"
            assert BACKENDS[name] in packages, f"{key}: {name}"
    # gnome's file chooser is Nautilus (xdg-desktop-portal-gnome 47 and later).
    if "gnome" in choices["org.freedesktop.impl.portal.FileChooser"]:
        assert "nautilus" in packages


def test_the_portal_file_chooses_the_secret_file_chooser_and_screen_backends():
    choices = preferred()
    assert choices["org.freedesktop.impl.portal.Secret"] == ["gnome-keyring"]
    assert choices["org.freedesktop.impl.portal.FileChooser"] == ["gnome", "gtk"]
    assert choices["org.freedesktop.impl.portal.Screenshot"] == ["gnome"]
    assert choices["org.freedesktop.impl.portal.ScreenCast"] == ["gnome"]
    assert choices["default"] == ["gnome", "gtk"]


@pytest.mark.skipif(not SYSTEM_PORTALS.is_dir(), reason="no portal backends installed here")
def test_each_installed_backend_implements_what_the_file_gives_it():
    checked = 0
    for interface, names in preferred().items():
        if interface == "default":
            continue
        for name in names:
            portal = SYSTEM_PORTALS / f"{name}.portal"
            if not portal.is_file():
                continue
            parser = configparser.ConfigParser(interpolation=None)
            parser.read(portal)
            assert interface in parser["portal"]["Interfaces"].split(";"), f"{name}: {interface}"
            checked += 1
    if not checked:
        pytest.skip("none of the backends the file names is installed here")


def test_the_drop_in_starts_only_the_secrets_component():
    lines = [line.strip() for line in DROP_IN.read_text().splitlines() if line.strip() and not line.startswith("#")]
    assert lines[0] == "[Service]"
    starts = [line.split("=", 1)[1] for line in lines if line.startswith("ExecStart=")]
    # An empty ExecStart= drops the packaged command; the next one replaces it.
    assert starts[0] == "" and len(starts) == 2
    argv = starts[1].split()
    assert argv[0] == "/usr/bin/gnome-keyring-daemon"
    assert "--foreground" in argv and "--components=secrets" in argv
    assert not any(arg.startswith("--components=") and arg != "--components=secrets" for arg in argv)
    # The packaged socket listens on %t/keyring/control; the daemon must take that socket over.
    assert "--control-directory=%t/keyring" in argv


def test_packages_sh_installs_the_drop_in_the_socket_and_the_portal_file():
    assert '"$LINUX/session/gnome-keyring-daemon.conf" /usr/lib/systemd/user/gnome-keyring-daemon.service.d/herald-os.conf' in PACKAGES_SH
    assert "systemctl --global enable gnome-keyring-daemon.socket" in PACKAGES_SH
    assert '"$LINUX/session/heraldos-portals.conf" /usr/share/xdg-desktop-portal/heraldos-portals.conf' in PACKAGES_SH


# ---------------------------------------------------------------------------------------------
# herald-os keyring.
SEALED = b"GnomeKeyring\n\r\x00\n\x00\x00"
PLAIN = b"[keyring]\ndisplay-name=Login\n"


def keyrings(tmp_path: Path, files: dict[str, bytes]) -> Path:
    folder = tmp_path / "keyrings"
    folder.mkdir()
    for name, body in files.items():
        (folder / name).write_bytes(body)
    return folder


@pytest.mark.parametrize("files, state", [
    ({}, "none"),
    ({"user.keystore": b"x"}, "none"),
    ({"login.keyring": PLAIN}, "open"),
    ({"login.keyring": SEALED}, "password"),
    ({"default": b"Default_keyring\n", "Default_keyring.keyring": PLAIN}, "open"),
    ({"default": b"work", "work.keyring": SEALED, "login.keyring": PLAIN}, "password"),
    # A default that names a keyring that is not there, with others beside it.
    ({"default": b"gone", "login.keyring": PLAIN}, "other"),
    ({"default": b"../login", "login.keyring": PLAIN}, "other"),
    ({"default": b"\xff\xfe"}, "other"),
    ({"login.keyring": b"something else"}, "other"),
    ({"default": b"\n", "login.keyring": SEALED}, "password"),
])
def test_the_keyring_state_comes_from_gnome_keyring_s_files(tmp_path, files, state):
    assert cli.keyring_state(keyrings(tmp_path, files)) == state


@pytest.mark.parametrize("name, where", [
    # A keyring outside the folder, which the name would reach.
    ("../login", lambda folder: folder.parent / "login.keyring"),
    ("sub/login", lambda folder: folder / "sub" / "login.keyring"),
    (".hidden", lambda folder: folder / ".hidden.keyring"),
])
def test_a_default_name_that_is_not_a_plain_file_name_is_not_followed(tmp_path, name, where):
    folder = keyrings(tmp_path, {"default": name.encode()})
    target = where(folder)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(PLAIN)
    assert cli.keyring_state(folder) == "other"


def test_a_missing_folder_is_no_keyring(tmp_path):
    assert cli.keyring_state(tmp_path / "nowhere") == "none"


def test_the_folder_follows_xdg_data_home(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert cli.keyring_dir() == tmp_path / "data" / "keyrings"
    monkeypatch.setenv("XDG_DATA_HOME", "relative/data")
    assert cli.keyring_dir() == cli.HOME / ".local" / "share" / "keyrings"
    monkeypatch.delenv("XDG_DATA_HOME")
    assert cli.keyring_dir() == cli.HOME / ".local" / "share" / "keyrings"


@pytest.mark.parametrize("password, again, said", [
    ("correct horse", "correct horse", None),
    ("correct horse", None, None),
    ("contraseña-ñ", None, None),
    ("correct horse", "correct house", "not the same"),
    ("short", None, "at least 8"),
    ("two\nlines-here", None, "one line"),
    ("nul\0inside-it", None, "one line"),
])
def test_keyring_password_rules(password, again, said):
    problem = cli.keyring_password_problem(password, again)
    assert (problem is None) if said is None else (said in problem and "Nothing was changed" in problem)


@pytest.mark.parametrize("stdin, password", [
    ("correct horse\n", "correct horse"),
    ("correct horse", "correct horse"),
    # Spaces are part of a password; only the one newline that ends the line goes.
    ("  correct horse  \n", "  correct horse  "),
    ("\tcorrect horse\t\n", "\tcorrect horse\t"),
])
def test_a_password_on_stdin_is_taken_as_typed(monkeypatch, stdin, password):
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO(stdin))
    assert cli.keyring_password_input() == password


@pytest.mark.parametrize("stdin", ["correct horse\n\n", "correct\nhorse\n", "\ncorrect horse\n"])
def test_more_than_one_line_on_stdin_is_refused(monkeypatch, capsys, stdin):
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO(stdin))
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_password_input()
    assert stopped.value.code == 2 and "one line" in capsys.readouterr().err


def test_the_unencrypted_note_is_only_for_a_disk_known_to_be_unencrypted(monkeypatch):
    monkeypatch.setattr(cli, "disk_devices", lambda: [])
    assert "not encrypted" in cli.keyring_unencrypted_note()
    monkeypatch.setattr(cli, "disk_devices", lambda: ["/dev/nvme0n1p3"])
    assert cli.keyring_unencrypted_note() is None

    def unknown():
        raise cli.DiskUnknown("lsblk could not run")
    monkeypatch.setattr(cli, "disk_devices", unknown)
    assert cli.keyring_unencrypted_note() is None


def run_cli(home: Path, *args: str, stdin: str = "", python: str = sys.executable, env: dict | None = None) -> subprocess.CompletedProcess:
    environment = {key: value for key, value in os.environ.items() if key not in {"XDG_DATA_HOME", "DISPLAY", "WAYLAND_DISPLAY"}}
    environment.update({"HOME": str(home), **(env or {})})
    return subprocess.run([python, str(CLI), "keyring", *args], input=stdin, capture_output=True, text=True, env=environment, timeout=60)


def test_status_is_json_and_needs_no_daemon(tmp_path):
    result = run_cli(tmp_path, "--status", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"keyring": "none", "folder": str(tmp_path / ".local" / "share" / "keyrings")}
    folder = tmp_path / ".local" / "share" / "keyrings"
    folder.mkdir(parents=True)
    (folder / "login.keyring").write_bytes(SEALED)
    assert json.loads(run_cli(tmp_path, "--status").stdout)["keyring"] == "password"


@pytest.mark.parametrize("body", [PLAIN, SEALED, b"something else"])
@pytest.mark.parametrize("flag", ["--no-password", "--password"])
def test_setup_never_replaces_a_keyring(tmp_path, body, flag):
    folder = tmp_path / ".local" / "share" / "keyrings"
    folder.mkdir(parents=True)
    (folder / "login.keyring").write_bytes(body)
    # No bus at all: the refusal comes before anything talks to a keyring service.
    result = run_cli(tmp_path, "setup", flag, stdin="correct horse\n", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert result.returncode == cli.KEYRING_EXISTS
    assert "already has a keyring" in result.stderr and "Nothing was changed" in result.stderr
    assert (folder / "login.keyring").read_bytes() == body


@pytest.mark.parametrize("args", [[], ["setup"], ["setup", "--no-password", "--password"], ["--status", "x"], ["make"]])
def test_keyring_usage(tmp_path, args):
    result = run_cli(tmp_path, *args)
    assert result.returncode == 2 and "keyring --status" in result.stderr


def test_a_bad_password_on_stdin_changes_nothing(tmp_path):
    result = run_cli(tmp_path, "setup", "--password", stdin="short\n", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert result.returncode == 2 and "at least 8" in result.stderr
    assert not (tmp_path / ".local" / "share" / "keyrings").exists()


def test_keyring_is_a_command_and_in_the_help():
    assert "keyring" in cli.COMMANDS
    for flag in ("--status", "--no-password", "--password"):
        assert flag in cli.COMMANDS["keyring"]
    assert "keyring --status" in cli.__doc__


# Against a real gnome-keyring-daemon, on a D-Bus session of the test's own.
def python_with_gi() -> str | None:
    for python in dict.fromkeys([sys.executable, "/usr/bin/python3"]):
        if Path(python).exists() and subprocess.run([python, "-c", "from gi.repository import Gio"], capture_output=True).returncode == 0:
            return python
    return None


GI_PYTHON = python_with_gi()
real_daemon = pytest.mark.skipif(
    not (GI_PYTHON and shutil.which("gnome-keyring-daemon") and shutil.which("dbus-run-session") and shutil.which("secret-tool")),
    reason="needs gnome-keyring-daemon, dbus-run-session, secret-tool and PyGObject",
)
LOCKED = """
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
def call(path, iface, method, args, reply):
    return bus.call_sync("org.freedesktop.secrets", path, iface, method, args, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 10000).unpack()
alias = call("/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "ReadAlias", GLib.Variant("(s)", ("default",)), "(o)")[0]
locked = call(alias, "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.freedesktop.Secret.Collection", "Locked")), "(v)")[0]
print(alias, locked)
"""


def session(tmp_path: Path, script: str, config: Path | None = None) -> subprocess.CompletedProcess:
    """A shell script on a fresh session bus, where D-Bus activation starts gnome-keyring-daemon."""
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if key not in {"XDG_DATA_HOME", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"}}
    env.update({"HOME": str(tmp_path), "XDG_RUNTIME_DIR": str(runtime), "PY": GI_PYTHON or "", "CLI": str(CLI), "LOCKED": LOCKED})
    argv = ["dbus-run-session", *(["--config-file", str(config)] if config else []), "--", "bash", "-c", script]
    return subprocess.run(argv, capture_output=True, text=True, env=env, timeout=120)


@real_daemon
def test_a_keyring_with_no_password_stores_and_looks_up_without_a_prompt(tmp_path):
    made = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password && printf s3cret | secret-tool store --label test service herald key test '
                             '&& secret-tool lookup service herald key test')
    assert made.returncode == 0, made.stderr
    assert "with no password of its own" in made.stdout and made.stdout.endswith("s3cret")
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert (folder / "default").read_text().strip() == "login"
    assert (folder / "login.keyring").read_bytes().startswith(b"[keyring]")
    assert json.loads(run_cli(tmp_path, "--status").stdout)["keyring"] == "open"
    # A later login: another daemon opens it with nothing typed.
    later = session(tmp_path, 'secret-tool lookup service herald key test')
    assert later.returncode == 0 and later.stdout == "s3cret", later.stderr


@real_daemon
def test_a_keyring_with_a_password_is_locked_at_the_next_login(tmp_path):
    made = session(tmp_path, 'printf "correct horse\\n" | "$PY" "$CLI" keyring setup --password && printf s3cret | secret-tool store --label test service herald key test')
    assert made.returncode == 0, made.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert (folder / "login.keyring").read_bytes().startswith(b"GnomeKeyring\n\r\x00\n")
    assert b"s3cret" not in (folder / "login.keyring").read_bytes()
    assert json.loads(run_cli(tmp_path, "--status").stdout)["keyring"] == "password"
    later = session(tmp_path, '"$PY" -c "$LOCKED"')
    assert later.returncode == 0, later.stderr
    assert later.stdout.split() == ["/org/freedesktop/secrets/collection/login", "True"]


@real_daemon
def test_a_default_keyring_the_daemon_still_holds_is_not_replaced(tmp_path):
    # The files are gone but the running daemon still has the keyring.
    result = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password && rm -rf "$HOME/.local/share/keyrings" && "$PY" "$CLI" keyring setup --password <<< "correct horse"')
    assert result.returncode == cli.KEYRING_EXISTS, result.stderr
    assert "already has a default keyring" in result.stderr


@real_daemon
def test_without_a_keyring_service_nothing_is_made(tmp_path):
    # A session bus that can start nothing.
    config = tmp_path / "bus.conf"
    config.write_text('<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" '
                      '"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n'
                      '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen>'
                      '<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>\n')
    result = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password', config)
    assert result.returncode == cli.KEYRING_NO_SERVICE, result.stderr
    assert "did not answer" in result.stderr and "Nothing was changed" in result.stderr
    assert not (tmp_path / ".local" / "share" / "keyrings").exists()
