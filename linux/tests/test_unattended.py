"""linux/image/unattended.ks erases one disk, the one its %pre picks, and leaves every other disk alone."""

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
KICKSTART = (ROOT / "linux" / "image" / "unattended.ks").read_text()
INCLUDE = "/tmp/herald-os-disk.ks"
PRE = re.search(r"^%pre [^\n]*\n(.*?)^%end$", KICKSTART, re.M | re.S).group(1)

LSBLK = """#!/usr/bin/env bash
if [[ "$*" == *PKNAME* ]]; then
  while read -r part parent; do [[ "/dev/$part" == "${@: -1}" ]] && echo "$parent"; done <"$FAKE/parents"
  exit 0
fi
cat "$FAKE/disks"
"""
FINDMNT = """#!/usr/bin/env bash
while read -r mount source; do [[ "$mount" == "${@: -1}" ]] && { echo "$source"; exit 0; }; done <"$FAKE/mounts"
exit 1
"""

# Each machine: lsblk -dnro NAME,TYPE,RM,RO,TRAN, the installer's mounts, partitions' parent disks,
# then the one disk the kickstart may erase (None: it stops instead).
MACHINES = {
    "one virtio disk": (["vda disk 0 0 "], [], [], "vda"),
    "two virtio disks": (["vdb disk 0 0 ", "vda disk 0 0 "], [], [], "vda"),
    "installer on a USB stick": (
        ["sda disk 1 0 usb", "nvme0n1 disk 0 0 nvme"], ["/run/install/repo /dev/sda1"], ["sda1 sda"], "nvme0n1",
    ),
    "USB disk left plugged in": (["sda disk 0 0 usb", "sdb disk 0 0 sata"], [], [], "sdb"),
    "installer on an internal disk": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata"], ["/run/install/repo /dev/sda2"], ["sda2 sda"], "sdb",
    ),
    "ISO file on a data disk": (
        ["nvme0n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme"],
        ["/run/install/repo /dev/loop0", "/run/install/isodir /dev/nvme0n1p3[/isos]"],
        ["nvme0n1p3 nvme0n1"],
        "nvme1n1",
    ),
    "installer DVD": (["sr0 rom 1 0 sata", "sda disk 0 0 sata"], ["/run/install/repo /dev/sr0"], [], "sda"),
    "zram swap": (["zram0 disk 0 0 ", "vda disk 0 0 "], [], [], "vda"),
    "card reader and eMMC boot areas": (
        ["mmcblk1 disk 1 0 mmc", "mmcblk0boot0 disk 0 1 mmc", "mmcblk0 disk 0 0 mmc"], [], [], "mmcblk0",
    ),
    "only the installer stick": (["sda disk 1 0 usb"], ["/run/install/repo /dev/sda1"], ["sda1 sda"], None),
    "no disks": ([], [], [], None),
}


def run_pre(tmp_path: Path, disks, mounts, parents, pre: str = PRE) -> tuple[subprocess.CompletedProcess, Path]:
    fake, bin_dir = tmp_path / "fake", tmp_path / "bin"
    fake.mkdir()
    bin_dir.mkdir()
    for name, lines in (("disks", disks), ("mounts", mounts), ("parents", parents)):
        (fake / name).write_text("".join(f"{line}\n" for line in lines))
    for name, script in (("lsblk", LSBLK), ("findmnt", FINDMNT)):
        (bin_dir / name).write_text(script)
        (bin_dir / name).chmod(0o755)
    out = tmp_path / "disk.ks"
    found = subprocess.run(
        ["bash", "-c", pre.replace(INCLUDE, str(out))],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE": str(fake)},
        capture_output=True,
        text=True,
        check=False,
    )
    return found, out


def main_section() -> str:
    return KICKSTART.split("\n%pre ", 1)[0]


def test_the_disk_commands_come_only_from_the_pre():
    commands = [line.split()[0] for line in main_section().splitlines() if line and not line.startswith("#")]
    assert "clearpart" not in commands
    assert "ignoredisk" not in commands
    assert f"%include {INCLUDE}" in main_section().splitlines()
    assert "--erroronfail" in KICKSTART.split("\n%pre ", 1)[1].splitlines()[0]


@pytest.mark.parametrize("name", MACHINES)
def test_the_pre_picks_one_internal_disk(name, tmp_path):
    disks, mounts, parents, expected = MACHINES[name]
    found, out = run_pre(tmp_path, disks, mounts, parents)
    if expected is None:
        assert found.returncode != 0
        assert not out.exists()
        assert "no internal disk" in found.stderr
        return
    assert found.returncode == 0, found.stderr
    assert out.read_text() == (
        f"ignoredisk --only-use={expected}\n"
        f"clearpart --all --drives={expected} --initlabel --disklabel=gpt\n"
    )


def test_a_disk_set_in_the_pre_wins(tmp_path):
    pre = PRE.replace('DISK=""', 'DISK="/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_S1"', 1)
    assert pre != PRE
    found, out = run_pre(tmp_path, ["nvme0n1 disk 0 0 nvme"], [], [], pre)
    assert found.returncode == 0, found.stderr
    assert out.read_text().splitlines()[0] == "ignoredisk --only-use=/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_S1"


def test_anaconda_reads_it_as_one_disk(tmp_path):
    parser_module = pytest.importorskip("pykickstart.parser")
    from pykickstart.constants import CLEARPART_TYPE_ALL
    from pykickstart.version import makeVersion

    found, out = run_pre(tmp_path, ["vda disk 0 0 ", "vdb disk 0 0 "], [], [])
    assert found.returncode == 0, found.stderr
    handler = makeVersion("F44")
    parser_module.KickstartParser(handler).readKickstartFromString(KICKSTART.replace(INCLUDE, str(out)))
    assert handler.ignoredisk.onlyuse == ["vda"]
    assert handler.clearpart.type == CLEARPART_TYPE_ALL
    assert handler.clearpart.drives == ["vda"]
    assert handler.zerombr.zerombr
    assert handler.autopart.autopart and handler.autopart.encrypted
    assert [script.interp for script in handler.scripts] == ["/usr/bin/bash"]
