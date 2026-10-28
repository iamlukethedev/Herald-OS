"""The keyring (Secret Service) on the image: the packages, the portal configuration, the
gnome-keyring unit, and `herald-os keyring`."""

import configparser
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
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


@pytest.mark.parametrize("name", [b"lo\0gin", b"\0", b"login\0", b"\0login\n"])
def test_a_default_name_with_a_nul_byte_is_other(tmp_path, name):
    folder = keyrings(tmp_path, {"default": name, "login.keyring": PLAIN})
    assert cli.keyring_state(folder) == "other"


def test_status_and_setup_take_a_nul_byte_in_default_without_a_traceback(tmp_path):
    folder = tmp_path / ".local" / "share" / "keyrings"
    folder.mkdir(parents=True)
    (folder / "default").write_bytes(b"lo\0gin")
    status = run_cli(tmp_path, "--status", env={"PATH": f"{disk_tools(tmp_path, None, None)}:{os.environ['PATH']}"})
    assert status.returncode == 0 and json.loads(status.stdout)["keyring"] == "other", status.stderr
    setup = run_cli(tmp_path, "setup", "--no-password", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert setup.returncode == cli.KEYRING_EXISTS and "one Herald OS did not make" in setup.stderr
    for result in (status, setup):
        assert "Traceback" not in result.stderr
    assert (folder / "default").read_bytes() == b"lo\0gin"


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
    # Seven characters are one too few; eight are enough.
    ("correct", None, "at least 8"),
    ("correct", "correct", "at least 8"),
    ("correct!", None, None),
    ("correct!", "correct!", None),
    # Characters (code points), as setup counts them too: 8 UTF-16 units each, but 4 and 7 characters.
    ("😀😀😀😀", None, "at least 8"),
    ("abcdef😀", None, "at least 8"),
    ("abcdefg😀", None, None),
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


@pytest.mark.parametrize("encrypted, noted", [(False, True), (True, False), (None, False)])
def test_the_unencrypted_note_is_only_for_a_keyring_disk_known_to_be_unencrypted(monkeypatch, tmp_path, encrypted, noted):
    asked = []
    monkeypatch.setattr(cli, "keyring_encrypted", lambda directory: asked.append(directory) or encrypted)
    note = cli.keyring_unencrypted_note(tmp_path / "keyrings")
    assert asked == [tmp_path / "keyrings"]
    assert (note is not None and "not encrypted" in note) == noted


# Where the keyring folder is kept: lsblk's tree and findmnt's list for each kind of machine.
def disk(path: str, fstype: str | None, mounts=(), uuid: str | None = None, children=(), kind: str = "part") -> dict:
    return {"name": path, "path": path, "type": kind, "fstype": fstype, "uuid": uuid, "mountpoints": list(mounts) or [None], "children": list(children) or None}


def mount(target: str, source: str, uuid: str | None = None, fstype: str | None = None) -> dict:
    return {"target": target, "source": source, "fstype": fstype, "uuid": uuid}


ESP = disk("/dev/nvme0n1p1", "vfat", ["/boot/efi"])
ROOT_LUKS = disk("/dev/nvme0n1p2", "crypto_LUKS", uuid="L1", children=[disk("/dev/mapper/luks-L1", "btrfs", ["/"], uuid="B1", kind="crypt")])
ROOT_PLAIN = disk("/dev/nvme0n1p2", "btrfs", ["/"], uuid="B1")
HOME_PLAIN = disk("/dev/nvme0n1p3", "ext4", ["/home"], uuid="H1")
HOME_LUKS = disk("/dev/nvme0n1p3", "crypto_LUKS", uuid="L2", children=[disk("/dev/mapper/luks-L2", "ext4", ["/home"], uuid="H1", kind="crypt")])
ROOT_MOUNTS = [mount("/", "/dev/mapper/luks-L1", "B1"), mount("/boot/efi", "/dev/nvme0n1p1")]
PLACE = "/home/ana/.local/share/keyrings"


def nvme(*parts: dict) -> list:
    return [disk("/dev/nvme0n1", None, kind="disk", children=parts)]


MACHINES = {
    "root encrypted, no separate home": (nvme(ESP, ROOT_LUKS), ROOT_MOUNTS, PLACE, True),
    "root encrypted, home on a partition that is not": (nvme(ESP, ROOT_LUKS, HOME_PLAIN), ROOT_MOUNTS + [mount("/home", "/dev/nvme0n1p3", "H1")], PLACE, False),
    "root encrypted, home encrypted on its own": (nvme(ESP, ROOT_LUKS, HOME_LUKS), ROOT_MOUNTS + [mount("/home", "/dev/mapper/luks-L2", "H1")], PLACE, True),
    "root not encrypted, home encrypted": (nvme(ESP, ROOT_PLAIN, HOME_LUKS), [mount("/", "/dev/nvme0n1p2", "B1"), mount("/home", "/dev/mapper/luks-L2", "H1")], PLACE, True),
    "nothing encrypted": (nvme(ESP, ROOT_PLAIN), [mount("/", "/dev/nvme0n1p2", "B1")], PLACE, False),
    # The image: / is composefs, /var a bind mount of the encrypted btrfs (findmnt -v leaves out the
    # [/ostree/deploy/default/var] part, which is also cut here when it is there), /home a link to /var/home.
    "the image, encrypted": (nvme(ESP, ROOT_LUKS), [mount("/", "composefs"), mount("/sysroot", "/dev/mapper/luks-L1", "B1"),
                                                    mount("/var", "/dev/mapper/luks-L1[/ostree/deploy/default/var]", "B1")], "/var/home/ana/.local/share/keyrings", True),
    "the image, not encrypted": (nvme(ESP, ROOT_PLAIN), [mount("/", "composefs"), mount("/sysroot", "/dev/nvme0n1p2", "B1"),
                                                         mount("/var", "/dev/nvme0n1p2", "B1")], "/var/home/ana/.local/share/keyrings", False),
    # A disk that is not encrypted, mounted inside the keyring folder of an encrypted home.
    "a plain disk mounted below the keyring folder": (nvme(ESP, ROOT_LUKS) + [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "ext4", [PLACE + "/usb"])])],
                                                      ROOT_MOUNTS + [mount(PLACE + "/usb", "/dev/sda1")], PLACE, False),
    "an encrypted disk mounted below it": (nvme(ESP, ROOT_LUKS, HOME_LUKS), ROOT_MOUNTS + [mount(PLACE + "/more", "/dev/mapper/luks-L2", "H1")], PLACE, True),
    # Not block devices lsblk knows: cannot be told.
    "home over NFS": (nvme(ESP, ROOT_LUKS), ROOT_MOUNTS + [mount("/home", "nas:/export/home")], PLACE, None),
    "a tmpfs on the keyring folder": (nvme(ESP, ROOT_LUKS), ROOT_MOUNTS + [mount(PLACE, "tmpfs")], PLACE, None),
    "home over NFS and a plain disk below": (nvme(ESP, ROOT_LUKS, HOME_PLAIN), ROOT_MOUNTS + [mount("/home", "nas:/export/home"), mount(PLACE + "/x", "/dev/nvme0n1p3", "H1")], PLACE, False),
    "no mount holds it": (nvme(ESP, ROOT_LUKS), [mount("/boot/efi", "/dev/nvme0n1p1")], PLACE, None),
    "no mounts at all": (nvme(ESP, ROOT_LUKS), [], PLACE, None),
    "no disks at all": ([], ROOT_MOUNTS, PLACE, None),
    # A home mounted at /home/ana2 holds nothing of /home/ana.
    "a mount that only shares the prefix": (nvme(ESP, ROOT_LUKS, HOME_PLAIN), ROOT_MOUNTS + [mount("/home/an", "/dev/nvme0n1p3", "H1")], PLACE, True),
    "a mount beside the keyring folder": (nvme(ESP, ROOT_LUKS, HOME_PLAIN), ROOT_MOUNTS + [mount(PLACE + "-old", "/dev/nvme0n1p3", "H1")], PLACE, True),
    # Mounted over: the later one is in use.
    "a plain home mounted over an encrypted one": (nvme(ESP, ROOT_LUKS, HOME_LUKS, disk("/dev/nvme0n1p4", "ext4", ["/home"], uuid="H2")),
                                                   ROOT_MOUNTS + [mount("/home", "/dev/mapper/luks-L2", "H1"), mount("/home", "/dev/nvme0n1p4", "H2")], PLACE, False),
    # A btrfs over two disks, one of them not encrypted: the mount names only the first.
    "btrfs over an encrypted disk and a plain one": (nvme(ESP, ROOT_LUKS) + [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "btrfs", uuid="B1")])],
                                                     ROOT_MOUNTS, PLACE, False),
    "btrfs over two encrypted disks": (nvme(ESP, ROOT_LUKS) + [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "crypto_LUKS", uuid="L3", children=[disk("/dev/mapper/luks-L3", "btrfs", uuid="B1", kind="crypt")])])],
                                       ROOT_MOUNTS, PLACE, True),
    # Without udev's data lsblk knows no UUIDs, so a btrfs's other disks cannot be found: unknown, even
    # where findmnt has the UUID and a second, plain disk would make it false.
    "btrfs without lsblk's UUID, over an encrypted disk and a plain one": (
        nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", "btrfs", ["/"], kind="crypt")]))
        + [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "btrfs")])],
        [mount("/", "/dev/mapper/luks-L1", "B1", "btrfs")], PLACE, None),
    "btrfs without lsblk's UUID, on one encrypted disk": (
        nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", "btrfs", ["/"], kind="crypt")])),
        [mount("/", "/dev/mapper/luks-L1", "B1", "btrfs")], PLACE, None),
    "btrfs known only to findmnt, without any UUID": (
        nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", None, ["/"], kind="crypt")])),
        [mount("/", "/dev/mapper/luks-L1", None, "btrfs")], PLACE, None),
    "a filesystem nobody names, without a UUID": (
        nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", None, ["/"], kind="crypt")])),
        [mount("/", "/dev/mapper/luks-L1")], PLACE, None),
    # lsblk has the UUID and findmnt does not: lsblk's is the one that finds the plain disk.
    "btrfs with lsblk's UUID only, over an encrypted disk and a plain one": (
        nvme(ESP, ROOT_LUKS) + [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "btrfs", uuid="B1")])],
        [mount("/", "/dev/mapper/luks-L1", None, "btrfs")], PLACE, False),
    # A filesystem on one disk needs no UUID.
    "ext4 without a UUID on LUKS": (
        nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", "ext4", ["/"], kind="crypt")])),
        [mount("/", "/dev/mapper/luks-L1", None, "ext4")], PLACE, True),
    # Encrypted, but not with LUKS (plain dm-crypt has no header): cannot be checked, so not "not encrypted".
    "home on plain dm-crypt": (nvme(ESP, ROOT_LUKS, disk("/dev/nvme0n1p3", None, children=[disk("/dev/mapper/home", "ext4", ["/home"], uuid="H1", kind="crypt")])),
                               ROOT_MOUNTS + [mount("/home", "/dev/mapper/home", "H1")], PLACE, None),
    "LVM on plain dm-crypt": (nvme(ESP, disk("/dev/nvme0n1p2", None, children=[disk("/dev/mapper/plain", "LVM2_member", kind="crypt", children=[
                                  disk("/dev/mapper/vg-root", "ext4", ["/"], uuid="R1", kind="lvm")])])), [mount("/", "/dev/mapper/vg-root", "R1")], PLACE, None),
    "plain dm-crypt beside a plain partition": (nvme(ESP, ROOT_LUKS, disk("/dev/nvme0n1p3", None, children=[disk("/dev/mapper/home", "ext4", ["/home"], uuid="H1", kind="crypt")]),
                                                     disk("/dev/nvme0n1p4", "ext4", uuid="X1")),
                                                ROOT_MOUNTS + [mount("/home", "/dev/mapper/home", "H1"), mount(PLACE + "/x", "/dev/nvme0n1p4", "X1")], PLACE, False),
    "LVM inside LUKS": (nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", uuid="L1", children=[disk("/dev/mapper/luks-L1", "LVM2_member", kind="crypt", children=[
                            disk("/dev/mapper/vg-root", "ext4", ["/"], uuid="R1", kind="lvm")])])), [mount("/", "/dev/mapper/vg-root", "R1")], PLACE, True),
}


@pytest.mark.parametrize("name", MACHINES)
def test_whether_the_keyring_folder_is_encrypted_comes_from_the_disks_that_hold_it(name):
    tree, mounts, place, encrypted = MACHINES[name]
    assert cli.keyring_mounts_encrypted(place, mounts, tree) is encrypted


def test_devices_are_compared_as_resolved():
    # findmnt may name /dev/dm-0 where lsblk says /dev/mapper/luks-L1.
    tree, _, place, _ = MACHINES["root encrypted, no separate home"]
    links = {"/dev/mapper/luks-L1": "/dev/dm-0"}
    assert cli.keyring_mounts_encrypted(place, [mount("/", "/dev/dm-0", "B1")], tree, lambda device: links.get(device, device)) is True
    assert cli.keyring_mounts_encrypted(place, [mount("/", "/dev/dm-0", "B1")], tree) is None


@pytest.mark.parametrize("values, answer", [
    ([], True), ([True, True], True), ([True, None], None), ([None, False], False), ([False, True], False), ([None], None),
])
def test_keyring_all(values, answer):
    assert cli.keyring_all(values) is answer


def test_a_raid_leg_on_luks_and_one_on_plain_dm_crypt_cannot_be_told():
    raid = disk("/dev/md0", "ext4", ["/"], uuid="R1", kind="raid1")
    tree = [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "crypto_LUKS", children=[disk("/dev/mapper/a", "linux_raid_member", kind="crypt", children=[raid])])]),
            disk("/dev/sdb", None, kind="disk", children=[disk("/dev/sdb1", None, children=[disk("/dev/mapper/b", "linux_raid_member", kind="crypt", children=[raid])])])]
    for order in (tree, tree[::-1]):
        assert cli.lsblk_on_luks(order)["/dev/md0"] is None
        assert cli.keyring_mounts_encrypted(PLACE, [mount("/", "/dev/md0", "R1")], order) is None


@pytest.mark.parametrize("plain_first", [False, True])
def test_a_device_under_several_parents_is_on_luks_only_under_each(plain_first):
    raid = disk("/dev/md0", "ext4", ["/"], uuid="R1", kind="raid1")
    tree = [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "crypto_LUKS", children=[disk("/dev/mapper/a", "linux_raid_member", kind="crypt", children=[raid])])]),
            disk("/dev/sdb", None, kind="disk", children=[disk("/dev/sdb1", "linux_raid_member", children=[raid])])]
    tree = tree[::-1] if plain_first else tree
    assert cli.lsblk_on_luks(tree)["/dev/md0"] is False
    assert cli.keyring_mounts_encrypted(PLACE, [mount("/", "/dev/md0", "R1")], tree) is False


def test_findmnt_is_asked_for_the_filesystem_type(tmp_path):
    # lsblk cannot name the filesystem (no udev data) and knows no UUID; findmnt's FSTYPE says ext4, which
    # spans one disk, so the answer is known.
    tree = nvme(ESP, disk("/dev/nvme0n1p2", "crypto_LUKS", children=[disk("/dev/mapper/luks-L1", None, ["/"], kind="crypt")]))
    tools = disk_tools(tmp_path, tree, [mount("/", "/dev/mapper/luks-L1", None, "ext4")])
    (tools / "findmnt").write_text('#!/bin/sh\ncase "$*" in *TARGET,SOURCE,FSTYPE,UUID*) ;; *) echo "findmnt was not asked for FSTYPE" >&2; exit 1;; esac\n'
                                   + (tools / "findmnt").read_text().split("\n", 1)[1])
    result = run_cli(tmp_path, "--status", env={"PATH": f"{tools}:{os.environ['PATH']}"})
    assert result.returncode == 0 and json.loads(result.stdout)["encrypted"] is True, result.stderr


def disk_tools(tmp_path: Path, tree: list | None, mounts: list | None) -> Path:
    """lsblk and findmnt stand-ins that print `tree` and `mounts`, or fail when given None."""
    tools = tmp_path / "tools"
    tools.mkdir(exist_ok=True)
    for name, key, value in (("lsblk", "blockdevices", tree), ("findmnt", "filesystems", mounts)):
        body = f"echo {name} failed >&2; exit 1" if value is None else f"cat <<'JSON'\n{json.dumps({key: value})}\nJSON"
        (tools / name).write_text(f"#!/bin/sh\n{body}\n")
        (tools / name).chmod(0o755)
    return tools


@pytest.mark.parametrize("name", ["root encrypted, home on a partition that is not", "root encrypted, home encrypted on its own", "home over NFS"])
def test_status_says_whether_the_keyring_folder_is_encrypted(tmp_path, name):
    tree, mounts, _, encrypted = MACHINES[name]
    home = tmp_path / "home" / "ana"
    home.mkdir(parents=True)
    # The stand-ins describe a machine whose /home is this test's own folder.
    mounts = [dict(item, target=str(tmp_path) + item["target"]) if item["target"].startswith("/home") else item for item in mounts]
    tools = disk_tools(tmp_path, tree, mounts)
    result = run_cli(home, "--status", env={"PATH": f"{tools}:{os.environ['PATH']}"})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["encrypted"] is encrypted


def test_status_follows_links_to_the_folder(tmp_path):
    # As on the image, where /home is a link to /var/home.
    real = tmp_path / "var" / "home" / "ana"
    real.mkdir(parents=True)
    (tmp_path / "home").symlink_to(tmp_path / "var" / "home")
    tree = nvme(ESP, ROOT_LUKS, HOME_PLAIN)
    tools = disk_tools(tmp_path, tree, ROOT_MOUNTS + [mount(str(tmp_path / "var"), "/dev/nvme0n1p3", "H1")])
    result = run_cli(tmp_path / "home" / "ana", "--status", env={"PATH": f"{tools}:{os.environ['PATH']}"})
    assert json.loads(result.stdout)["encrypted"] is False, result.stderr


@pytest.mark.parametrize("tree, mounts", [(None, []), ([], None)])
def test_status_says_null_when_lsblk_or_findmnt_cannot_say(tmp_path, tree, mounts):
    tools = disk_tools(tmp_path, tree if tree is None else nvme(ESP, ROOT_LUKS), mounts if mounts is None else ROOT_MOUNTS)
    result = run_cli(tmp_path, "--status", env={"PATH": f"{tools}:{os.environ['PATH']}"})
    assert result.returncode == 0 and json.loads(result.stdout)["encrypted"] is None


def run_cli(home: Path, *args: str, stdin: str = "", python: str = sys.executable, env: dict | None = None) -> subprocess.CompletedProcess:
    environment = {key: value for key, value in os.environ.items() if key not in {"XDG_DATA_HOME", "DISPLAY", "WAYLAND_DISPLAY"}}
    environment.update({"HOME": str(home), **(env or {})})
    return subprocess.run([python, str(CLI), "keyring", *args], input=stdin, capture_output=True, text=True, env=environment, timeout=60)


def test_status_is_json_and_needs_no_daemon(tmp_path):
    tools = disk_tools(tmp_path, None, None)
    result = run_cli(tmp_path, "--status", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent", "PATH": f"{tools}:{os.environ['PATH']}"})
    assert result.returncode == 0
    assert json.loads(result.stdout) == {"keyring": "none", "folder": str(tmp_path / ".local" / "share" / "keyrings"), "encrypted": None}
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


def test_a_seven_character_password_on_stdin_is_refused_before_the_keyring_service_is_asked(tmp_path):
    result = run_cli(tmp_path, "setup", "--password", stdin="correct\n", env={"DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert result.returncode == 2 and "at least 8" in result.stderr
    assert not (tmp_path / ".local" / "share" / "keyrings").exists()


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


def session(tmp_path: Path, script: str, config: Path | None = None, env: dict | None = None) -> subprocess.CompletedProcess:
    """A shell script on a fresh session bus, where D-Bus activation starts gnome-keyring-daemon."""
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    extra = env
    env = {key: value for key, value in os.environ.items() if key not in {"XDG_DATA_HOME", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"}}
    env.update({"HOME": str(tmp_path), "XDG_RUNTIME_DIR": str(runtime), "PY": GI_PYTHON or "", "CLI": str(CLI), "LOCKED": LOCKED, **(extra or {})})
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


def test_the_lock_lives_in_the_runtime_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    assert cli.keyring_lock_path() == tmp_path / "herald-os-keyring.lock"
    monkeypatch.delenv("XDG_RUNTIME_DIR")
    assert cli.keyring_lock_path() == cli.CONFIG_DIR / "herald-os-keyring.lock"


def test_a_setup_that_cannot_get_the_lock_gives_up_and_says_why(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(cli, "KEYRING_LOCK_WAIT", 0.3)
    with open(tmp_path / "herald-os-keyring.lock", "a") as held:
        import fcntl
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(SystemExit) as stopped:
            with cli.keyring_lock():
                pytest.fail("the lock was taken twice")
    assert stopped.value.code == 1 and "still running" in capsys.readouterr().err
    # Free again, it is taken at once.
    with cli.keyring_lock():
        pass


needs_flock = pytest.mark.skipif(not shutil.which("flock"), reason="needs flock(1) from util-linux")


@real_daemon
@needs_flock
def test_a_setup_waits_for_one_already_running(tmp_path):
    # The shell holds the lock as a running setup would; the command must wait for it before it looks.
    result = session(tmp_path, 'exec 9>"$XDG_RUNTIME_DIR/herald-os-keyring.lock" && flock 9 && '
                               '{ "$PY" "$CLI" keyring setup --no-password 9>&- & pid=$!; } && sleep 1.5 && '
                               '{ kill -0 "$pid" && [ ! -e "$HOME/.local/share/keyrings/login.keyring" ] && echo waited; }; '
                               'flock -u 9; wait "$pid"; echo "rc=$?"')
    assert result.stdout.split()[0] == "waited", result.stdout + result.stderr
    assert "rc=0" in result.stdout, result.stderr


@real_daemon
def test_two_setups_at_once_make_one_keyring(tmp_path):
    result = session(tmp_path, 'for flag in --no-password --password; do { printf "correct horse\\n" | "$PY" "$CLI" keyring setup "$flag"; '
                               'echo "rc=$?" >> "$XDG_RUNTIME_DIR/codes"; } & done; wait; cat "$XDG_RUNTIME_DIR/codes"')
    assert sorted(re.findall(r"rc=(\d+)", result.stdout)) == ["0", "3"], result.stdout + result.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert sorted(path.name for path in folder.glob("*.keyring")) == ["login.keyring"]
    assert (folder / "default").read_text().strip() == "login"


@real_daemon
@needs_flock
def test_a_keyring_made_while_setup_waited_is_found_under_the_lock(tmp_path):
    result = session(tmp_path, 'exec 9>"$XDG_RUNTIME_DIR/herald-os-keyring.lock" && flock 9 && '
                               '{ "$PY" "$CLI" keyring setup --no-password 9>&- & pid=$!; } && sleep 1 && '
                               'mkdir -p "$HOME/.local/share/keyrings" && printf "[keyring]\\ndisplay-name=Login\\n" > "$HOME/.local/share/keyrings/login.keyring"; '
                               'flock -u 9; wait "$pid"; echo "rc=$?"')
    assert "rc=3" in result.stdout, result.stdout + result.stderr
    assert "already has a keyring (with no password of its own)" in result.stderr


# The Arch package.
ARCH = ROOT / "packaging" / "arch"
ARCH_BACKENDS = {"gnome": "xdg-desktop-portal-gnome", "gtk": "xdg-desktop-portal-gtk", "gnome-keyring": "org.freedesktop.secrets"}


def is_gnu_install(version: str) -> bool:
    """`install --version`'s first line is GNU coreutils' own: "install (GNU coreutils) 9.4"."""
    return re.fullmatch(r"install \(GNU coreutils\) \d[\w.+-]*", version.split("\n", 1)[0].strip()) is not None


def gnu_install() -> bool:
    try:
        return is_gnu_install(subprocess.run(["install", "--version"], capture_output=True, text=True).stdout)
    except OSError:
        return False


@pytest.mark.parametrize("version, gnu", [
    ("install (GNU coreutils) 9.4\nCopyright (C) 2023 Free Software Foundation, Inc.\n", True),
    ("install (GNU coreutils) 8.32\n", True),
    ("install (GNU coreutils) 9.5.12-abcd\n", True),
    # Other installs that mention GNU coreutils, or look like it, are not it.
    ("install (uutils coreutils) 0.0.28\n", False),
    ("usage: install [-bCcpSsUv] [-B suffix] ... (see GNU coreutils for install -D)\n", False),
    ("BusyBox v1.36.1 multi-call binary.\nGNU coreutils compatible\n", False),
    ("ginstall (GNU coreutils) 9.4\n", False),
    ("install (GNU coreutils)\n", False),
    ("", False),
])
def test_only_gnu_install_counts_as_gnu_install(version, gnu):
    assert is_gnu_install(version) is gnu


@pytest.mark.skipif(not gnu_install(), reason="the package script needs GNU install (install -D), as on Arch")
@pytest.mark.parametrize("flavour", ["herald-os-bin", "herald-os-git"])
def test_the_arch_package_installs_the_portal_file(tmp_path, flavour):
    # An unpacked build as the tarball has it: the CLIs, session and data under resources.
    app = tmp_path / "app"
    linux = app / "resources" / "herald-os-linux"
    for folder in ("bin", "session", "niri", "omakase", "migrations", "plymouth"):
        shutil.copytree(LINUX / folder, linux / folder, ignore=shutil.ignore_patterns("__pycache__"))
    for name in ("app.asar", "LICENSE", "NOTICE", "icons/herald-os.png"):
        (app / "resources" / name).parent.mkdir(parents=True, exist_ok=True)
        (app / "resources" / name).write_text("")
    for folder in ("themes", "catalog", "herald-os-bridge"):
        (app / "resources" / folder).mkdir()
    (app / "chrome-sandbox").write_text("")
    pkgdir = tmp_path / "pkg"
    script = ARCH / flavour / "herald-os-package.sh"
    result = subprocess.run(["bash", "-c", f'set -e; pkgdir="$1"; pkgname={flavour}; source "$2"; _herald_os_package "$3"', "-", str(pkgdir), str(script), str(app)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    installed = pkgdir / "usr" / "share" / "xdg-desktop-portal" / "heraldos-portals.conf"
    assert installed.read_bytes() == PORTALS.read_bytes()
    assert (pkgdir / "usr" / "share" / "wayland-sessions" / "herald-os.desktop").is_file()


@pytest.mark.parametrize("flavour", ["herald-os-bin", "herald-os-git"])
def test_the_arch_package_recommends_every_backend_the_portal_file_names(flavour):
    listed = subprocess.run(["bash", "-c", 'source "$1"; printf "%s\\n" "${optdepends[@]}"', "-", str(ARCH / flavour / "PKGBUILD")], capture_output=True, text=True).stdout
    recommended = {line.split(":", 1)[0] for line in listed.splitlines()}
    named = {name for names in preferred().values() for name in names}
    assert {ARCH_BACKENDS[name] for name in named} <= recommended


@pytest.mark.parametrize("flavour", ["herald-os-bin", "herald-os-git"])
def test_the_arch_package_pins_the_package_script_it_ships(flavour):
    import hashlib
    sums = subprocess.run(["bash", "-c", 'source "$1"; printf "%s\\n" "${sha256sums[@]}"', "-", str(ARCH / flavour / "PKGBUILD")], capture_output=True, text=True).stdout.split()
    assert hashlib.sha256((ARCH / flavour / "herald-os-package.sh").read_bytes()).hexdigest() in sums


def test_without_pygobject_setup_says_so_and_does_not_blame_the_keyring_service(tmp_path):
    # A gi that cannot be imported, ahead of any real one.
    fake = tmp_path / "nogi" / "gi"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text('raise ImportError("no PyGObject here")\n')
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    result = run_cli(tmp_path, "setup", "--no-password", env={"PYTHONPATH": str(tmp_path / "nogi"), "XDG_RUNTIME_DIR": str(runtime),
                                                              "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    assert result.returncode == cli.KEYRING_NO_GOBJECT == 5, result.stderr
    assert "needs PyGObject" in result.stderr and "python-gobject" in result.stderr and "python3-gobject-base" in result.stderr
    assert "did not answer" not in result.stderr
    assert not (tmp_path / ".local" / "share" / "keyrings").exists()


@pytest.mark.parametrize("flavour", ["herald-os-bin", "herald-os-git"])
def test_the_arch_package_depends_on_pygobject_for_herald_os_keyring(flavour):
    listed = subprocess.run(["bash", "-c", 'source "$1"; printf "%s\\n" "${depends[@]}"', "-", str(ARCH / flavour / "PKGBUILD")], capture_output=True, text=True).stdout
    assert "python-gobject" in listed.split()


@pytest.mark.parametrize("errors", ["surrogateescape", "strict"])
def test_bytes_that_are_not_text_on_stdin_are_refused_before_the_lock_or_the_bus(tmp_path, errors):
    # surrogateescape is what Python's UTF-8 mode (the C locale) gives stdin; strict, a full UTF-8 locale.
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
    environment.update({"HOME": str(tmp_path), "XDG_RUNTIME_DIR": str(runtime), "PYTHONIOENCODING": f"utf-8:{errors}",
                        # Were the bus reached, this would end in exit 4 instead.
                        "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    result = subprocess.run([sys.executable, str(CLI), "keyring", "setup", "--password"], input=b"abcdefgh\xff\n", capture_output=True, env=environment, timeout=60)
    stderr = result.stderr.decode("utf-8", "replace")
    assert result.returncode == 2, stderr
    assert cli.KEYRING_NOT_TEXT in stderr and "Traceback" not in stderr
    assert list(runtime.iterdir()) == [], "the lock was taken"
    assert not (tmp_path / ".local" / "share" / "keyrings").exists()


class Undecodable(io.StringIO):
    def read(self, *args):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")


@pytest.mark.parametrize("stdin", [io.StringIO("abcdefgh\udcff\n"), io.StringIO("\udcffabcdefgh"), Undecodable("")])
def test_a_password_that_is_not_text_gets_one_clean_message(monkeypatch, capsys, stdin):
    monkeypatch.setattr(cli.sys, "stdin", stdin)
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_password_input()
    assert stopped.value.code == 2 and cli.KEYRING_NOT_TEXT in capsys.readouterr().err


@pytest.mark.parametrize("typed", [["abcdefgh\udcff", "abcdefgh\udcff"], ["abcdefgh", "abcdefgh\udcff"]])
def test_the_terminal_gives_the_same_message_for_bytes_that_are_not_text(monkeypatch, capsys, typed):
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True, raising=False)
    answers = iter(typed)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: next(answers))
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_password_input()
    assert stopped.value.code == 2 and cli.KEYRING_NOT_TEXT in capsys.readouterr().err

    def undecodable(prompt):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
    monkeypatch.setattr(cli.getpass, "getpass", undecodable)
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_password_input()
    assert stopped.value.code == 2 and cli.KEYRING_NOT_TEXT in capsys.readouterr().err


# Stopped half-way: Ctrl+C, and a rerun finishing the keyring.
def sealed(name: bytes) -> bytes:
    """The start of a sealed keyring file as gnome-keyring writes it: magic, versions, cipher, hash, name."""
    return b"GnomeKeyring\n\r\x00\n" + b"\x00\x00\x00\x00" + len(name).to_bytes(4, "big") + name + b"\x00" * 16


@pytest.mark.parametrize("body, label", [
    (b"[keyring]\ndisplay-name=login\nctime=1\n", "login"),
    (b"[keyring]\ndisplay-name=Login\n", "Login"),
    (b"[keyring]\nctime=1\n\n[1]\ndisplay-name=an item\n", None),
    (sealed(b"login"), "login"),
    (sealed(b"Login"), "Login"),
    (sealed("Anmeldung".encode()), "Anmeldung"),
    (sealed(b"login")[:22], None),
    (b"GnomeKeyring\n\r\x00\n\x00\x00\x00\x00\x00\x00\x00\x09login", None),
    (b"GnomeKeyring\n\r\x00\n\x00\x00\x00\x00\xff\xff\xff\xff", None),
    (b"something else", None),
])
def test_a_keyring_file_s_label(tmp_path, body, label):
    (tmp_path / "x.keyring").write_bytes(body)
    assert cli.keyring_label(tmp_path / "x.keyring") == label


def test_a_missing_keyring_file_has_no_label(tmp_path):
    assert cli.keyring_label(tmp_path / "none.keyring") is None


@pytest.mark.parametrize("files, unfinished", [
    ({"login.keyring": b"[keyring]\ndisplay-name=login\n"}, "open"),
    ({"default": b"login\n", "login.keyring": b"[keyring]\ndisplay-name=login\n"}, "open"),
    ({"login.keyring": sealed(b"login")}, "password"),
    ({"default": b"login", "login.keyring": sealed(b"login")}, "password"),
    # Finished ones, gnome-keyring's own (named in the language of the session), and others' are not.
    ({"default": b"login", "login.keyring": b"[keyring]\ndisplay-name=Login\n"}, None),
    ({"login.keyring": sealed(b"Login")}, None),
    ({"login.keyring": sealed("Anmeldung".encode())}, None),
    ({"default": b"work", "work.keyring": b"[keyring]\ndisplay-name=login\n"}, None),
    ({"default": b"work", "login.keyring": b"[keyring]\ndisplay-name=login\n"}, None),
    # The default is another keyring: a login one still labelled "login" beside it must not take its place.
    ({"default": b"work", "work.keyring": b"[keyring]\ndisplay-name=Work\n", "login.keyring": b"[keyring]\ndisplay-name=login\n"}, None),
    ({"default": b"lo\0gin", "login.keyring": b"[keyring]\ndisplay-name=login\n"}, None),
    ({}, None),
])
def test_a_keyring_stopped_half_way_is_recognised(tmp_path, files, unfinished):
    assert cli.keyring_unfinished(keyrings(tmp_path, files)) == unfinished


class FakeGLibError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def fake_keyring_service(monkeypatch, stop_at: str | None, calls: list, denied: bool = False, fail_at: str | None = None, locked: bool = True):
    """A stand-in for PyGObject and the keyring service. At `stop_at` it does what Ctrl+C does while that
    call is under way: KeyboardInterrupt in the main thread, with the call itself still waiting. At
    `fail_at` the call fails with an error that is not a refused password."""
    import _thread
    import threading
    import types

    held = threading.Event()
    answers = {"ReadAlias": ("/",), "OpenSession": (None, "/org/freedesktop/secrets/session/s1"), "CreateWithMasterPassword": (cli.KEYRING_LOGIN,),
               "Get": (locked,)}

    class Bus:
        def call_sync(self, name, path, interface, method, args, reply, flags, timeout):
            calls.append(method)
            if method == stop_at:
                _thread.interrupt_main()
                held.wait(5)
            if method == fail_at:
                raise FakeGLibError("GDBus.Error:org.freedesktop.DBus.Error.Failed: Something went wrong")
            if denied and method == "ChangeWithMasterPassword":
                raise FakeGLibError("GDBus.Error:org.gnome.keyring.Error.Denied: The password was invalid")
            return types.SimpleNamespace(unpack=lambda: answers.get(method, ()))

    glib = types.SimpleNamespace(Error=FakeGLibError, Variant=lambda kind, value: value, VariantType=lambda reply: reply)
    gio = types.SimpleNamespace(bus_get_sync=lambda kind: Bus(), BusType=types.SimpleNamespace(SESSION=0), DBusCallFlags=types.SimpleNamespace(NONE=0))
    repository = types.ModuleType("gi.repository")
    repository.Gio, repository.GLib = gio, glib
    gi = types.ModuleType("gi")
    gi.repository = repository
    monkeypatch.setitem(sys.modules, "gi", gi)
    monkeypatch.setitem(sys.modules, "gi.repository", repository)
    return held


MAKING = ["ReadAlias", "OpenSession", "CreateWithMasterPassword", "SetAlias", "Set", "Close"]


@pytest.mark.parametrize("stop_at, said", [
    ("ReadAlias", "stopped. Nothing was changed."),
    ("OpenSession", "stopped. Nothing was changed."),
    ("CreateWithMasterPassword", "which it may have done. Run `herald-os keyring setup --no-password` again: it finishes the keyring if it was made"),
    ("SetAlias", "stopped after the keyring was made, before it was finished as the default one. Run `herald-os keyring setup --no-password` again to finish it."),
    # Relabelling under way: it may or may not have landed, so the advice covers both.
    ("Set", "stopped while the keyring was being finished as the default one. Running `herald-os keyring setup --no-password` again finishes it if it was not, or says this account already has a keyring if it was."),
    # Relabelled: finished, and a rerun would refuse it, so there is nothing to run again.
    ("Close", "stopped, but the keyring was already finished: it is the default one and ready to use. There is nothing to run again."),
])
def test_ctrl_c_while_making_the_keyring_says_how_far_it_got(monkeypatch, capsys, stop_at, said):
    calls: list = []
    held = fake_keyring_service(monkeypatch, stop_at, calls)
    try:
        with pytest.raises(SystemExit) as stopped:
            cli.keyring_create("", "--no-password")
    finally:
        held.set()
    err = capsys.readouterr().err
    assert stopped.value.code == cli.KEYRING_STOPPED == 130
    assert said in err and "Traceback" not in err
    assert calls == MAKING[:MAKING.index(stop_at) + 1]


def test_making_the_keyring_runs_every_call_in_order(monkeypatch):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls)
    assert cli.keyring_create("correct horse", "--password") == cli.KEYRING_LOGIN
    assert calls == MAKING


@pytest.mark.parametrize("stop_at, said", [
    *[(stage, "stopped before the keyring was finished. Run `herald-os keyring setup --password` again to finish it.")
      for stage in ("OpenSession", "ChangeWithMasterPassword", "Get", "UnlockWithMasterPassword", "SetAlias")],
    ("Set", "stopped while the keyring was being finished as the default one. Running `herald-os keyring setup --password` again finishes it if it was not"),
    ("Close", "stopped, but the keyring was already finished: it is the default one and ready to use. There is nothing to run again."),
])
def test_ctrl_c_while_finishing_says_how_far_it_got(monkeypatch, capsys, stop_at, said):
    calls: list = []
    held = fake_keyring_service(monkeypatch, stop_at, calls)
    try:
        with pytest.raises(SystemExit) as stopped:
            cli.keyring_finish("correct horse", "--password")
    finally:
        held.set()
    err = capsys.readouterr().err
    assert stopped.value.code == 130
    assert said in err and "Traceback" not in err


def test_finishing_with_the_wrong_password_changes_nothing(monkeypatch, capsys):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls, denied=True)
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_finish("not it at all", "--password")
    err = capsys.readouterr().err
    # Its own exit, so setup asks for the password again: 3 would read as a keyring left as it is, and 2
    # as a password too short.
    assert stopped.value.code == cli.KEYRING_WRONG_PASSWORD == 6 and "not the password the keyring was made with" in err
    # Checked by changing it to itself, which never locks the keyring; nothing after the refusal.
    assert calls == ["OpenSession", "ChangeWithMasterPassword"]


def test_finishing_without_a_password_a_keyring_that_has_one_names_the_flag_that_finishes_it(monkeypatch, capsys):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls, denied=True)
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_finish("", "--no-password")
    assert stopped.value.code == cli.KEYRING_EXISTS and "`herald-os keyring setup --password` finishes it" in capsys.readouterr().err


def test_finishing_stops_when_the_password_cannot_be_checked(monkeypatch, capsys):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls, fail_at="ChangeWithMasterPassword")
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_finish("correct horse", "--password")
    err = capsys.readouterr().err
    assert stopped.value.code == 1, err
    assert "could not check the keyring's password (GDBus.Error:org.freedesktop.DBus.Error.Failed: Something went wrong). Nothing was changed." in err
    # Nothing after the failed check: no unlock, no default, no label.
    assert calls == ["OpenSession", "ChangeWithMasterPassword"]


def test_finishing_stops_when_the_keyring_cannot_be_opened(monkeypatch, capsys):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls, fail_at="UnlockWithMasterPassword")
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_finish("correct horse", "--password")
    assert stopped.value.code == 1 and "could not open the keyring to finish it" in capsys.readouterr().err
    assert calls == ["OpenSession", "ChangeWithMasterPassword", "Get", "UnlockWithMasterPassword"]


@pytest.mark.parametrize("locked, opened", [(True, ["UnlockWithMasterPassword"]), (False, [])])
def test_finishing_never_locks_the_keyring_and_opens_it_only_if_it_is_locked(monkeypatch, locked, opened):
    calls: list = []
    fake_keyring_service(monkeypatch, None, calls, locked=locked)
    cli.keyring_finish("correct horse", "--password")
    assert calls == ["OpenSession", "ChangeWithMasterPassword", "Get", *opened, "SetAlias", "Set", "Close"]
    assert "Lock" not in calls


def test_ctrl_c_while_waiting_for_the_lock_changes_nothing(tmp_path, monkeypatch, capsys):
    import fcntl
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(cli, "keyring_dir", lambda: tmp_path / "keyrings")

    def interrupted(seconds):
        raise KeyboardInterrupt
    with open(tmp_path / "herald-os-keyring.lock", "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        monkeypatch.setattr(cli.time, "sleep", interrupted)
        with pytest.raises(SystemExit) as stopped:
            cli.keyring_cmd(["setup", "--no-password"])
    assert stopped.value.code == 130 and "stopped. Nothing was changed." in capsys.readouterr().err


# The same against a real gnome-keyring-daemon: a keyring made but not finished, as a stopped setup leaves it.
MAKE_UNFINISHED = """
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
def call(path, iface, method, args, reply):
    return bus.call_sync("org.freedesktop.secrets", path, iface, method, args, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 10000).unpack()
session = call("/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "OpenSession", GLib.Variant("(sv)", ("plain", GLib.Variant("s", ""))), "(vo)")[1]
label = {"org.freedesktop.Secret.Collection.Label": GLib.Variant("s", "login")}
call("/org/freedesktop/secrets", "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface", "CreateWithMasterPassword",
     GLib.Variant("(a{sv}(oayays))", (label, (session, b"", sys.argv[1].encode(), "text/plain"))), "(o)")
"""


def unfinished_keyring(tmp_path: Path, password: str = "") -> Path:
    made = session(tmp_path, f'"$PY" -c "$MAKE" {shlex.quote(password)}', env={"MAKE": MAKE_UNFINISHED})
    assert made.returncode == 0, made.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert not (folder / "default").exists() and cli.keyring_label(folder / "login.keyring") == "login"
    return folder


@real_daemon
def test_a_rerun_finishes_a_keyring_with_no_password_stopped_half_way(tmp_path):
    folder = unfinished_keyring(tmp_path)
    assert cli.keyring_unfinished(folder) == "open"
    result = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password && printf s3cret | secret-tool store --label t service herald key t && secret-tool lookup service herald key t')
    assert result.returncode == 0, result.stderr
    assert "Finished the keyring" in result.stdout and result.stdout.endswith("s3cret")
    assert (folder / "default").read_text().strip() == "login" and cli.keyring_label(folder / "login.keyring") == "Login"
    assert cli.keyring_state(folder) == "open"
    # Finished, it is an existing keyring like any other.
    again = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password')
    assert again.returncode == cli.KEYRING_EXISTS, again.stderr


@real_daemon
def test_a_rerun_finishes_a_keyring_with_a_password_only_with_that_password(tmp_path):
    folder = unfinished_keyring(tmp_path, "correct horse")
    assert cli.keyring_unfinished(folder) == "password"
    before = (folder / "login.keyring").read_bytes()
    wrong_kind = session(tmp_path, '"$PY" "$CLI" keyring setup --no-password')
    assert wrong_kind.returncode == cli.KEYRING_EXISTS and "`herald-os keyring setup --password` finishes it" in wrong_kind.stderr
    wrong = session(tmp_path, 'printf "not the one\\n" | "$PY" "$CLI" keyring setup --password')
    assert wrong.returncode == cli.KEYRING_WRONG_PASSWORD and "not the password the keyring was made with" in wrong.stderr
    assert (folder / "login.keyring").read_bytes() == before and not (folder / "default").exists()
    right = session(tmp_path, 'printf "correct horse\\n" | "$PY" "$CLI" keyring setup --password')
    assert right.returncode == 0 and "Finished the keyring" in right.stdout, right.stderr
    assert (folder / "default").read_text().strip() == "login" and cli.keyring_label(folder / "login.keyring") == "Login"
    assert cli.keyring_state(folder) == "password"


@real_daemon
def test_a_rerun_in_the_same_session_finishes_it_too(tmp_path):
    # The daemon that made it is still running, as after Ctrl+C in a terminal.
    result = session(tmp_path, f'"$PY" -c "$MAKE" "" && "$PY" "$CLI" keyring setup --no-password', env={"MAKE": MAKE_UNFINISHED})
    assert result.returncode == 0 and "Finished the keyring" in result.stdout, result.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert (folder / "default").read_text().strip() == "login" and cli.keyring_label(folder / "login.keyring") == "Login"


@real_daemon
def test_ctrl_c_while_the_keyring_service_does_not_answer(tmp_path):
    # The daemon is frozen, so ReadAlias waits; Ctrl+C must stop it at once, not after the call's 20 s.
    result = session(tmp_path, 'set -m; secret-tool search --all nothing here >/dev/null 2>&1; '
                               'pid=$(dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus '
                               'org.freedesktop.DBus.GetConnectionUnixProcessID string:org.freedesktop.secrets | awk "/uint32/ {print \\$2}"); '
                               'kill -STOP "$pid"; start=$SECONDS; "$PY" "$CLI" keyring setup --no-password & cli=$!; sleep 1; kill -INT "$cli"; '
                               'wait "$cli"; echo "rc=$? took=$((SECONDS - start))"; kill -CONT "$pid"')
    assert "rc=130" in result.stdout, result.stdout + result.stderr
    assert int(re.search(r"took=(\d+)", result.stdout).group(1)) < 10
    assert "stopped. Nothing was changed." in result.stderr and "Traceback" not in result.stderr
    # The daemon makes the folder when it starts; nothing is written into it.
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert not list(folder.glob("*.keyring")) and not (folder / "default").exists()


# Unusual layouts that are encrypted all the same, and must still count as true.
def luks(path: str, inner: dict, uuid: str = "LX", kind: str = "part") -> dict:
    return disk(path, "crypto_LUKS", uuid=uuid, children=[inner], kind=kind)


EXOTIC_TRUE = {
    "LUKS on RAID over two plain partitions": (
        [disk("/dev/sda", None, kind="disk", children=[disk("/dev/sda1", "linux_raid_member", children=[
            luks("/dev/md0", disk("/dev/mapper/luks-md", "ext4", ["/"], uuid="R1", kind="crypt"), kind="raid1")])]),
         disk("/dev/sdb", None, kind="disk", children=[disk("/dev/sdb1", "linux_raid_member", children=[
             luks("/dev/md0", disk("/dev/mapper/luks-md", "ext4", ["/"], uuid="R1", kind="crypt"), kind="raid1")])])],
        [mount("/", "/dev/mapper/luks-md", "R1", "ext4")], PLACE),
    "LUKS on an LVM volume": (
        nvme(ESP, disk("/dev/nvme0n1p2", "LVM2_member", children=[luks("/dev/mapper/vg-home", disk("/dev/mapper/luks-home", "xfs", ["/"], uuid="X1", kind="crypt"), kind="lvm")])),
        [mount("/", "/dev/mapper/luks-home", "X1", "xfs")], PLACE),
    "LUKS inside LUKS": (
        nvme(ESP, luks("/dev/nvme0n1p2", disk("/dev/mapper/outer", "crypto_LUKS", uuid="L2", kind="crypt", children=[
            disk("/dev/mapper/inner", "ext4", ["/"], uuid="I1", kind="crypt")]))),
        [mount("/", "/dev/mapper/inner", "I1", "ext4")], PLACE),
    "LUKS on a whole disk, no partitions": (
        [disk("/dev/sda", "crypto_LUKS", kind="disk", uuid="L9", children=[disk("/dev/mapper/luks-sda", "ext4", ["/"], uuid="E1", kind="crypt")])],
        [mount("/", "/dev/mapper/luks-sda", "E1", "ext4")], PLACE),
    "LUKS on a loop device": (
        nvme(ESP, ROOT_LUKS) + [disk("/dev/loop0", "crypto_LUKS", kind="loop", uuid="L5", children=[disk("/dev/mapper/vault", "ext4", [PLACE], uuid="V1", kind="crypt")])],
        ROOT_MOUNTS + [mount(PLACE, "/dev/mapper/vault", "V1", "ext4")], PLACE),
    "the keyring folder is itself a mount on LUKS, under a plain home": (
        nvme(ESP, ROOT_PLAIN, luks("/dev/nvme0n1p3", disk("/dev/mapper/k", "ext4", [PLACE], uuid="K1", kind="crypt"))),
        [mount("/", "/dev/nvme0n1p2", "B1", "btrfs"), mount(PLACE, "/dev/mapper/k", "K1", "ext4")], PLACE),
    "several mounts below the folder, each on LUKS": (
        nvme(ESP, ROOT_LUKS, HOME_LUKS, luks("/dev/nvme0n1p4", disk("/dev/mapper/luks-4", "ext4", uuid="F4", kind="crypt"), uuid="L4")),
        ROOT_MOUNTS + [mount(PLACE + "/a", "/dev/mapper/luks-L2", "H1"), mount(PLACE + "/a/b", "/dev/mapper/luks-4", "F4", "ext4")], PLACE),
    "btrfs over three LUKS disks, mounted as a subvolume": (
        nvme(ESP, ROOT_LUKS) + [disk(f"/dev/sd{letter}", None, kind="disk", children=[luks(f"/dev/sd{letter}1", disk(f"/dev/mapper/luks-{letter}", "btrfs", uuid="B1", kind="crypt"), uuid=f"L{letter}")])
                                for letter in "ab"],
        [mount("/", "/dev/mapper/luks-L1[/root]", "B1", "btrfs"), mount("/home", "/dev/mapper/luks-a[/home]", "B1", "btrfs")], PLACE),
}


@pytest.mark.parametrize("name", EXOTIC_TRUE)
def test_unusual_encrypted_layouts_still_count_as_encrypted(name):
    tree, mounts, place = EXOTIC_TRUE[name]
    assert cli.keyring_mounts_encrypted(place, mounts, tree) is True


def test_a_source_named_by_a_link_counts_as_its_device():
    # findmnt may name a device by a /dev/disk link, which resolves to the mapper device lsblk names.
    tree, _, place, _ = MACHINES["root encrypted, no separate home"]
    links = {"/dev/disk/by-uuid/B1": "/dev/dm-0", "/dev/mapper/luks-L1": "/dev/dm-0"}
    assert cli.keyring_mounts_encrypted(place, [mount("/", "/dev/disk/by-uuid/B1", "B1", "btrfs")], tree, lambda device: links.get(device, device)) is True


UNLOCK = """
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
def call(path, iface, method, args, reply):
    return bus.call_sync("org.freedesktop.secrets", path, iface, method, args, GLib.VariantType(reply), Gio.DBusCallFlags.NONE, 10000).unpack()
session = call("/org/freedesktop/secrets", "org.freedesktop.Secret.Service", "OpenSession", GLib.Variant("(sv)", ("plain", GLib.Variant("s", ""))), "(vo)")[1]
for password in sys.argv[1:]:
    try:
        call("/org/freedesktop/secrets", "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface", "UnlockWithMasterPassword",
             GLib.Variant("(o(oayays))", ("/org/freedesktop/secrets/collection/login", (session, b"", password.encode(), "text/plain"))), "()")
        print("opens")
    except GLib.Error:
        print("refused")
"""


@real_daemon
def test_a_wrong_password_is_refused_while_the_half_made_keyring_is_still_open(tmp_path):
    # Right after Ctrl+C, in the session that made it, the keyring is unlocked, and gnome-keyring opens an
    # unlocked keyring with any password: the rerun must still check it.
    result = session(tmp_path, '"$PY" -c "$MAKE" "First pw 188!" && '
                               '{ printf "Second pw 188?\\n" | "$PY" "$CLI" keyring setup --password; echo "wrong=$?"; } && '
                               '{ printf "First pw 188!\\n" | "$PY" "$CLI" keyring setup --password; echo "right=$?"; }',
                     env={"MAKE": MAKE_UNFINISHED})
    assert "wrong=6" in result.stdout and "right=0" in result.stdout, result.stdout + result.stderr
    assert "not the password the keyring was made with" in result.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert (folder / "default").read_text().strip() == "login" and cli.keyring_label(folder / "login.keyring") == "Login"
    # At the next login it opens with the password it was made with, and not the other one.
    later = session(tmp_path, '"$PY" -c "$UNLOCK" "Second pw 188?" "First pw 188!"', env={"UNLOCK": UNLOCK})
    assert later.stdout.split() == ["refused", "opens"], later.stderr


@real_daemon
def test_a_wrong_password_leaves_the_half_made_keyring_as_it_was(tmp_path):
    result = session(tmp_path, '"$PY" -c "$MAKE" "First pw 188!" && printf "Second pw 188?\\n" | "$PY" "$CLI" keyring setup --password; echo "rc=$?"',
                     env={"MAKE": MAKE_UNFINISHED})
    assert "rc=6" in result.stdout, result.stdout + result.stderr
    folder = tmp_path / ".local" / "share" / "keyrings"
    assert not (folder / "default").exists() and cli.keyring_label(folder / "login.keyring") == "login"
    assert cli.keyring_unfinished(folder) == "password"


def test_under_the_lock_a_keyring_no_longer_half_made_is_not_finished(tmp_path, monkeypatch, capsys):
    # While this run waited for the lock, the person made another keyring, "work", the default one.
    # Finishing "login" now would take the default away from it.
    folder = keyrings(tmp_path, {"default": b"work", "work.keyring": b"[keyring]\ndisplay-name=Work\n"})
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(cli, "keyring_dir", lambda: folder)
    looks = iter(["open", None])
    monkeypatch.setattr(cli, "keyring_unfinished", lambda directory: next(looks))
    finished = []
    monkeypatch.setattr(cli, "keyring_finish", lambda password, flag: finished.append(flag))
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_cmd(["setup", "--no-password"])
    assert stopped.value.code == cli.KEYRING_EXISTS and "already has a keyring" in capsys.readouterr().err
    assert finished == []
    assert (folder / "default").read_bytes() == b"work"


def test_under_the_lock_a_keyring_still_half_made_is_finished(tmp_path, monkeypatch, capsys):
    folder = keyrings(tmp_path, {"login.keyring": b"[keyring]\ndisplay-name=login\n"})
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(cli, "keyring_dir", lambda: folder)
    finished = []
    monkeypatch.setattr(cli, "keyring_finish", lambda password, flag: finished.append((password, flag)))
    assert cli.keyring_cmd(["setup", "--no-password"]) == 0
    assert finished == [("", "--no-password")] and "Finished the keyring" in capsys.readouterr().out


class Interrupted(io.StringIO):
    def read(self, *args):
        raise KeyboardInterrupt


def test_ctrl_c_while_the_password_is_read_from_a_pipe_changes_nothing(monkeypatch, capsys):
    monkeypatch.setattr(cli.sys, "stdin", Interrupted(""))
    with pytest.raises(SystemExit) as stopped:
        cli.keyring_password_input()
    assert stopped.value.code == cli.KEYRING_STOPPED and "stopped. Nothing was changed." in capsys.readouterr().err


def test_ctrl_c_on_a_pipe_that_sends_nothing_exits_130_without_a_traceback(tmp_path):
    # `sleep 30 | herald-os keyring setup --password`, stopped with Ctrl+C before anything arrives.
    runtime = tmp_path / "runtime"
    runtime.mkdir(mode=0o700)
    environment = {key: value for key, value in os.environ.items() if key != "XDG_DATA_HOME"}
    environment.update({"HOME": str(tmp_path), "XDG_RUNTIME_DIR": str(runtime), "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent"})
    command = subprocess.Popen([sys.executable, str(CLI), "keyring", "setup", "--password"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment)
    try:
        time.sleep(1)
        assert command.poll() is None, "it should be waiting for the password"
        command.send_signal(signal.SIGINT)
        _, err = command.communicate(timeout=10)
    finally:
        command.kill()
    err = err.decode("utf-8", "replace")
    # 130 as an exit code of its own, not death by SIGINT (-2), and no traceback.
    assert command.returncode == 130, err
    assert "stopped. Nothing was changed." in err and "Traceback" not in err
    assert list(runtime.iterdir()) == [] and not (tmp_path / ".local" / "share" / "keyrings").exists()


@real_daemon
def test_a_wrong_password_does_not_disturb_programs_using_the_half_made_keyring(tmp_path):
    # In the session that made it the keyring is open, and another program keeps a secret in it. Checking
    # a wrong password must not lock it: the program must still read its secret without being asked.
    result = session(tmp_path, '"$PY" -c "$MAKE" "First pw 188!" && printf s3cret | secret-tool store --label t service herald key t && '
                               '{ printf "Second pw 188?\\n" | "$PY" "$CLI" keyring setup --password; echo "wrong=$?"; } && '
                               'echo "read=$(secret-tool lookup service herald key t)" && '
                               '{ printf "First pw 188!\\n" | "$PY" "$CLI" keyring setup --password; echo "right=$?"; } && '
                               'echo "after=$(secret-tool lookup service herald key t)"',
                     env={"MAKE": MAKE_UNFINISHED})
    assert "wrong=6" in result.stdout and "right=0" in result.stdout, result.stdout + result.stderr
    assert "read=s3cret" in result.stdout and "after=s3cret" in result.stdout, result.stdout + result.stderr


def test_the_wrong_password_has_an_exit_code_of_its_own():
    codes = {"exists": cli.KEYRING_EXISTS, "no service": cli.KEYRING_NO_SERVICE, "no PyGObject": cli.KEYRING_NO_GOBJECT,
             "stopped": cli.KEYRING_STOPPED, "usage or a refused password": 2, "other failures": 1}
    assert cli.KEYRING_WRONG_PASSWORD == 6 and cli.KEYRING_WRONG_PASSWORD not in codes.values()
