"""The installer ISO's kickstart (linux/image/iso.toml): encrypted by default, the storage screen still
the person's, and the installer test covering both answers to "Encrypt my data"."""

import re
import sys
from pathlib import Path

import pytest
import yaml

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    tomllib = pytest.importorskip("tomli")

ROOT = Path(__file__).resolve().parents[2]
ISO = ROOT / "linux" / "image" / "iso.toml"
WORKFLOW = ROOT / ".github" / "workflows" / "installer-test.yml"


def kickstart() -> list[str]:
    contents = tomllib.loads(ISO.read_text())["customizations"]["installer"]["kickstart"]["contents"]
    return [line.strip() for line in contents.splitlines() if line.strip() and not line.strip().startswith("#")]


def test_the_automatic_layout_is_encrypted_and_asks_for_the_passphrase():
    layouts = [line for line in kickstart() if line.split()[0] == "autopart"]
    assert layouts == ["autopart --type=btrfs --encrypted"]
    # A passphrase here would be the same on every computer installed from the ISO.
    assert not any("--passphrase" in line for line in kickstart())


def test_the_storage_screen_stays_the_persons():
    """Nothing that erases, hides disks or completes the install without the person: no clearpart,
    zerombr or ignoredisk, no account or root password (so the hub never starts by itself), and no
    text mode or reboot."""
    commands = {line.split()[0] for line in kickstart()}
    assert commands == {"autopart", "xconfig"}


def test_the_kickstart_parses_where_pykickstart_is_installed():
    parser_module = pytest.importorskip("pykickstart.parser")
    version = pytest.importorskip("pykickstart.version")
    handler = version.makeVersion()
    parser = parser_module.KickstartParser(handler)
    parser.readKickstartFromString("\n".join(kickstart()) + "\n")
    assert handler.autopart.autopart and handler.autopart.encrypted and not handler.autopart.passphrase
    assert handler.autopart.type is not None


def test_the_installer_test_installs_both_ways():
    workflow = yaml.safe_load(WORKFLOW.read_text())
    job = workflow["jobs"]["install"]
    assert job["strategy"]["matrix"]["disk"] == ["encrypted", "unencrypted"]
    assert job["strategy"]["fail-fast"] is False
    steps = {step.get("name"): step.get("run", "") for step in job["steps"]}
    kickstart_step = steps["The ISO's kickstart, unattended"]
    # The ISO's own default is what the encrypted run checks, and its layout line gives way to the run's.
    assert "--encrypted( |$)" in kickstart_step and "sed -i '/^autopart" in kickstart_step
    assert re.search(r"autopart --type=btrfs --noswap --encrypted --passphrase=\$PASSPHRASE", kickstart_step)
    assert "echo 'autopart --type=btrfs --noswap'" in kickstart_step
    disk_step = steps["The disk is encrypted, or not"]
    assert "crypto_LUKS" in disk_step and "--test-passphrase" in disk_step
    boot_step = steps["Boot what was installed"]
    assert "passphrase for disk" in boot_step and "serial.sock" in boot_step
    # The passphrase is typed over the serial console and never printed with the kickstart.
    assert re.fullmatch(r"[a-z0-9]+", job["env"]["PASSPHRASE"])
    assert 's/$PASSPHRASE/<passphrase>/' in kickstart_step
    upload = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/upload-artifact"))
    assert "${{ matrix.disk }}" in upload["with"]["name"]


def test_the_release_builds_the_iso_from_this_kickstart():
    image = (ROOT / ".github" / "workflows" / "image.yml").read_text()
    assert re.search(r"type: anaconda-iso\s+config: iso\.toml", image)
