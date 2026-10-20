"""The keyring (Secret Service) on the image: the packages, the portal configuration and the
gnome-keyring unit."""

import configparser
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
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
    for package in ("gnome-keyring", "libsecret", "xdg-desktop-portal", *BACKENDS.values()):
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
