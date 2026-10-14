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
# then the one disk the kickstart may erase, or NONE or SEVERAL when it stops without erasing any.
NONE, SEVERAL = "no internal disk", "internal disks"
MACHINES = {
    "one virtio disk": (["vda disk 0 0 "], [], [], "vda"),
    "two virtio disks": (["vdb disk 0 0 ", "vda disk 0 0 "], [], [], SEVERAL),
    "two NVMe disks and a USB stick": (
        ["nvme0n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme", "sda disk 1 0 usb"],
        ["/run/install/repo /dev/sda1"],
        ["sda1 sda"],
        SEVERAL,
    ),
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
    "only the installer stick": (["sda disk 1 0 usb"], ["/run/install/repo /dev/sda1"], ["sda1 sda"], NONE),
    "no disks": ([], [], [], NONE),
}


def run_pre(tmp_path: Path, disks, mounts, parents, pre: str = PRE) -> tuple[subprocess.CompletedProcess, Path, Path]:
    fake, bin_dir = tmp_path / "fake", tmp_path / "bin"
    fake.mkdir()
    bin_dir.mkdir()
    for name, lines in (("disks", disks), ("mounts", mounts), ("parents", parents)):
        (fake / name).write_text("".join(f"{line}\n" for line in lines))
    for name, script in (("lsblk", LSBLK), ("findmnt", FINDMNT)):
        (bin_dir / name).write_text(script)
        (bin_dir / name).chmod(0o755)
    out, console = tmp_path / "disk.ks", tmp_path / "console"
    console.write_text("")
    found = subprocess.run(
        ["bash", "-c", pre.replace(INCLUDE, str(out)).replace("/dev/console", str(console))],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE": str(fake)},
        capture_output=True,
        text=True,
        check=False,
    )
    return found, out, console


def main_section() -> str:
    return KICKSTART.split("\n%pre ", 1)[0]


def test_the_disk_commands_come_only_from_the_pre():
    commands = [line.split()[0] for line in main_section().splitlines() if line and not line.startswith("#")]
    assert "clearpart" not in commands
    assert "ignoredisk" not in commands
    assert f"%include {INCLUDE}" in main_section().splitlines()
    assert "--erroronfail" in KICKSTART.split("\n%pre ", 1)[1].splitlines()[0]


def with_disk(disk: str) -> str:
    pre = PRE.replace('DISK=""', f'DISK="{disk}"', 1)
    assert pre != PRE
    return pre


def erases_only(out: Path, disk: str) -> bool:
    return out.read_text() == (
        f"ignoredisk --only-use={disk}\n"
        f"clearpart --all --drives={disk} --initlabel --disklabel=gpt\n"
    )


@pytest.mark.parametrize("name", MACHINES)
def test_the_pre_uses_the_only_internal_disk_or_erases_nothing(name, tmp_path):
    disks, mounts, parents, expected = MACHINES[name]
    found, out, console = run_pre(tmp_path, disks, mounts, parents)
    if expected in (NONE, SEVERAL):
        assert found.returncode != 0
        assert not out.exists()
        for told in (found.stderr, console.read_text()):
            assert expected in told
            assert "nothing was erased" in told
            assert "Set DISK= in the kickstart's %pre" in told
        return
    assert found.returncode == 0, found.stderr
    assert erases_only(out, expected)
    assert f"erasing {expected}, and only {expected}" in console.read_text()


def test_several_internal_disks_are_named_and_none_is_chosen(tmp_path):
    found, out, console = run_pre(tmp_path, ["nvme1n1 disk 0 0 nvme", "nvme0n1 disk 0 0 nvme", "sda disk 0 0 sata"], [], [])
    assert found.returncode != 0
    assert not out.exists()
    assert "found 3 internal disks (nvme1n1 nvme0n1 sda)" in found.stderr
    assert "erasing" not in found.stderr + console.read_text()


@pytest.mark.parametrize("disk", ["vdb", "vda", "/dev/disk/by-id/virtio-data-disk"])
def test_a_disk_set_in_the_pre_is_used_on_a_two_disk_machine(disk, tmp_path):
    found, out, _ = run_pre(tmp_path, ["vda disk 0 0 ", "vdb disk 0 0 "], [], [], with_disk(disk))
    assert found.returncode == 0, found.stderr
    assert erases_only(out, disk)


def test_a_disk_set_in_the_pre_is_used_without_looking(tmp_path):
    found, out, _ = run_pre(tmp_path, [], [], [], with_disk("nvme0n1"))
    assert found.returncode == 0, found.stderr
    assert erases_only(out, "nvme0n1")


def test_anaconda_reads_it_as_one_disk(tmp_path):
    parser_module = pytest.importorskip("pykickstart.parser")
    from pykickstart.constants import CLEARPART_TYPE_ALL
    from pykickstart.version import makeVersion

    found, out, _ = run_pre(tmp_path, ["vda disk 0 0 ", "vdb disk 0 0 "], [], [], with_disk("vdb"))
    assert found.returncode == 0, found.stderr
    handler = makeVersion("F44")
    parser_module.KickstartParser(handler).readKickstartFromString(KICKSTART.replace(INCLUDE, str(out)))
    assert handler.ignoredisk.onlyuse == ["vdb"]
    assert handler.clearpart.type == CLEARPART_TYPE_ALL
    assert handler.clearpart.drives == ["vdb"]
    assert handler.zerombr.zerombr
    assert handler.autopart.autopart and handler.autopart.encrypted
    assert [script.interp for script in handler.scripts] == ["/usr/bin/bash"]
