"""linux/image/unattended.ks erases one disk, the one its %pre picks, and leaves every other disk alone."""

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
KICKSTART = (ROOT / "linux" / "image" / "unattended.ks").read_text()
INCLUDE = "/tmp/herald-os-disk.ks"
PRE = re.search(r"^%pre [^\n]*\n(.*?)^%end$", KICKSTART, re.M | re.S).group(1)

# The fakes answer the lsblk, findmnt and readlink calls the %pre makes, from files in $FAKE.
LSBLK = """#!/usr/bin/env bash
dev="${@: -1}"
lookup() {
  while read -r name type rm ro tran; do
    [[ "/dev/$name" == "$dev" ]] && { echo "$name $type $ro"; return 0; }
  done < <(cat "$FAKE/disks" "$FAKE/devices")
  echo "lsblk: $dev: not a block device" >&2
  exit 32
}
case "$*" in
  "-nsro NAME "*)
    while read -r from names; do [[ "/dev/$from" == "$dev" ]] && { tr ' ' '\\n' <<<"$names"; exit 0; }; done <"$FAKE/below"
    echo "${dev#/dev/}"
    exit 0 ;;
  "-nro TYPE,FSTYPE "*)
    if [[ -f "$FAKE/trees/${dev#/dev/}" ]]; then cat "$FAKE/trees/${dev#/dev/}"; else echo "disk "; fi
    exit 0 ;;
  "-ndo TYPE "*) found="$(lookup)" || exit 32; read -r name type ro <<<"$found"; echo "$type"; exit 0 ;;
  "-ndro NAME,RO "*) found="$(lookup)" || exit 32; read -r name type ro <<<"$found"; echo "$name $ro"; exit 0 ;;
  "-dnro NAME,TYPE,RM,RO,TRAN") cat "$FAKE/disks"; exit 0 ;;
esac
echo "fake lsblk: unexpected $*" >&2
exit 99
"""
FINDMNT = """#!/usr/bin/env bash
while read -r mount source; do [[ "$mount" == "${@: -1}" ]] && { echo "$source"; exit 0; }; done <"$FAKE/mounts"
exit 1
"""
READLINK = """#!/usr/bin/env bash
while read -r link target; do [[ "$link" == "${@: -1}" ]] && { echo "$target"; exit 0; }; done <"$FAKE/links"
echo "${@: -1}"
"""

NONE, SEVERAL = "no internal disk", "internal disks"
MPATH = ["disk mpath_member", "mpath "]
# Each machine: lsblk -dnro NAME,TYPE,RM,RO,TRAN, then any of: the installer's mounts, what
# lsblk -s lists from a mounted device down to its disks, and what lsblk -nro TYPE,FSTYPE shows
# under a disk. Last, the one disk the kickstart
# may erase, or NONE or SEVERAL when it stops without erasing any.
MACHINES = {
    "one virtio disk": (["vda disk 0 0 "], {}, "vda"),
    "two virtio disks": (["vdb disk 0 0 ", "vda disk 0 0 "], {}, SEVERAL),
    "two NVMe disks and a USB stick": (
        ["nvme0n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme", "sda disk 1 0 usb"],
        {"mounts": ["/run/install/repo /dev/sda1"], "below": ["sda1 sda1 sda"]},
        SEVERAL,
    ),
    "installer on a USB stick": (
        ["sda disk 1 0 usb", "nvme0n1 disk 0 0 nvme"],
        {"mounts": ["/run/install/repo /dev/sda1"], "below": ["sda1 sda1 sda"]},
        "nvme0n1",
    ),
    "USB disk left plugged in": (["sda disk 0 0 usb", "sdb disk 0 0 sata"], {}, "sdb"),
    "installer on an internal disk": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata"],
        {"mounts": ["/run/install/repo /dev/sda2"], "below": ["sda2 sda2 sda"]},
        "sdb",
    ),
    "ISO file on a data disk": (
        ["nvme0n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme"],
        {"mounts": ["/run/install/repo /dev/loop0", "/run/install/isodir /dev/nvme0n1p3[/isos]"], "below": ["nvme0n1p3 nvme0n1p3 nvme0n1"]},
        "nvme1n1",
    ),
    "installer DVD": (
        ["sr0 rom 1 0 sata", "sda disk 0 0 sata"], {"mounts": ["/run/install/repo /dev/sr0"]}, "sda",
    ),
    "zram swap": (["zram0 disk 0 0 ", "vda disk 0 0 "], {}, "vda"),
    "card reader and eMMC boot areas": (
        ["mmcblk1 disk 1 0 mmc", "mmcblk0boot0 disk 0 1 mmc", "mmcblk0 disk 0 0 mmc"], {}, "mmcblk0",
    ),
    "two paths to a SAN disk": (
        ["sda disk 0 0 fc", "sdb disk 0 0 fc", "nvme0n1 disk 0 0 nvme"], {"trees": {"sda": MPATH, "sdb": MPATH}}, "nvme0n1",
    ),
    "multipath without the member tag": (
        ["sda disk 0 0 iscsi", "sdb disk 0 0 iscsi", "vda disk 0 0 "],
        {"trees": {"sda": ["disk ", "mpath "], "sdb": ["disk ", "mpath "]}},
        "vda",
    ),
    "Intel RST RAID": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata", "nvme0n1 disk 0 0 nvme"],
        {"trees": {"sda": ["disk isw_raid_member"], "sdb": ["disk isw_raid_member"]}},
        "nvme0n1",
    ),
    "DDF RAID set up through md": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata", "nvme0n1 disk 0 0 nvme"],
        {"trees": {"sda": ["disk ddf_raid_member", "raid1 "], "sdb": ["disk ddf_raid_member", "raid1 "]}},
        "nvme0n1",
    ),
    "BIOS RAID through dmraid": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata", "nvme0n1 disk 0 0 nvme"],
        {"trees": {"sda": ["disk ", "dmraid "], "sdb": ["disk ", "dmraid "]}},
        "nvme0n1",
    ),
    "ISO file on an LVM volume": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata"],
        {
            "mounts": ["/run/install/repo /dev/loop0", "/run/install/isodir /dev/mapper/data-isos[/herald]"],
            "below": ["mapper/data-isos data-isos sdb2 sdb"],
        },
        "sda",
    ),
    "ISO file on an LVM volume across two disks": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata", "sdc disk 0 0 sata"],
        {
            "mounts": ["/run/install/repo /dev/loop0", "/run/install/isodir /dev/mapper/data-isos"],
            "below": ["mapper/data-isos data-isos sdb1 sdb sdc1 sdc"],
        },
        "sda",
    ),
    "only BIOS RAID members": (
        ["sda disk 0 0 sata", "sdb disk 0 0 sata"],
        {"trees": {"sda": ["disk isw_raid_member"], "sdb": ["disk isw_raid_member"]}},
        NONE,
    ),
    "only the installer stick": (
        ["sda disk 1 0 usb"], {"mounts": ["/run/install/repo /dev/sda1"], "below": ["sda1 sda1 sda"]}, NONE,
    ),
    "no disks": ([], {}, NONE),
}


def run_pre(tmp_path: Path, disks, pre: str = PRE, **machine) -> tuple[subprocess.CompletedProcess, Path, Path]:
    fake, bin_dir = tmp_path / "fake", tmp_path / "bin"
    (fake / "trees").mkdir(parents=True)
    bin_dir.mkdir()
    files = {"disks": disks, "devices": [], "mounts": [], "below": [], "links": []}
    files.update({name: lines for name, lines in machine.items() if name != "trees"})
    for name, lines in files.items():
        (fake / name).write_text("".join(f"{line}\n" for line in lines))
    for name, lines in machine.get("trees", {}).items():
        (fake / "trees" / name).write_text("".join(f"{line}\n" for line in lines))
    for name, script in (("lsblk", LSBLK), ("findmnt", FINDMNT), ("readlink", READLINK)):
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


def with_disk(disk: str) -> str:
    pre = PRE.replace('DISK=""', f'DISK="{disk}"', 1)
    assert pre != PRE
    return pre


def erases_only(out: Path, disk: str) -> bool:
    return out.read_text() == (
        f"ignoredisk --only-use={disk}\n"
        f"clearpart --all --drives={disk} --initlabel --disklabel=gpt\n"
    )


def refused(found: subprocess.CompletedProcess, out: Path, console: Path, *said: str) -> bool:
    told = [found.stderr, console.read_text()]
    return (
        found.returncode != 0
        and not out.exists()
        and all("nothing was erased" in text and "erasing" not in text for text in told)
        and all(words in text for words in said for text in told)
    )


def test_the_disk_commands_come_only_from_the_pre():
    commands = [line.split()[0] for line in main_section().splitlines() if line and not line.startswith("#")]
    assert "clearpart" not in commands
    assert "ignoredisk" not in commands
    assert f"%include {INCLUDE}" in main_section().splitlines()
    assert "--erroronfail" in KICKSTART.split("\n%pre ", 1)[1].splitlines()[0]


@pytest.mark.parametrize("name", MACHINES)
def test_the_pre_uses_the_only_internal_disk_or_erases_nothing(name, tmp_path):
    disks, machine, expected = MACHINES[name]
    found, out, console = run_pre(tmp_path, disks, **machine)
    if expected in (NONE, SEVERAL):
        assert refused(found, out, console, expected, "Set DISK= in the kickstart's %pre")
        return
    assert found.returncode == 0, found.stderr
    assert erases_only(out, expected)
    assert f"erasing {expected}, and only {expected}" in console.read_text()


def test_several_internal_disks_are_named_in_natural_order(tmp_path):
    disks = ["nvme10n1 disk 0 0 nvme", "sdb disk 0 0 sata", "nvme2n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme", "sda disk 0 0 sata"]
    found, out, console = run_pre(tmp_path, disks)
    assert refused(found, out, console, "found 5 internal disks (nvme1n1 nvme2n1 nvme10n1 sda sdb)")


def test_set_members_are_left_out_of_the_disks_it_names(tmp_path):
    disks = ["sda disk 0 0 fc", "sdb disk 0 0 sata", "nvme0n1 disk 0 0 nvme", "nvme1n1 disk 0 0 nvme"]
    found, out, console = run_pre(tmp_path, disks, trees={"sda": MPATH, "sdb": ["disk isw_raid_member"]})
    assert refused(found, out, console, "found 2 internal disks (nvme0n1 nvme1n1)")


TWO_DISKS = ["vda disk 0 0 ", "vdb disk 0 0 "]
BY_ID = "/dev/disk/by-id/virtio-data"


@pytest.mark.parametrize(
    ("disk", "expected"),
    [("vdb", "vdb"), ("vda", "vda"), ("/dev/vdb", "vdb"), (BY_ID, "vdb"), ("/dev/../dev/vda", "vda")],
)
def test_a_disk_set_in_the_pre_is_used_on_a_two_disk_machine(disk, expected, tmp_path):
    links = [f"{BY_ID} /dev/vdb", "/dev/../dev/vda /dev/vda"]
    found, out, console = run_pre(tmp_path, TWO_DISKS, with_disk(disk), links=links)
    assert found.returncode == 0, found.stderr
    assert erases_only(out, expected)
    assert f"erasing {expected}, and only {expected}" in console.read_text()


def test_a_disk_set_in_the_pre_may_be_a_set_member(tmp_path):
    found, out, _ = run_pre(tmp_path, TWO_DISKS, with_disk("vdb"), trees={"vdb": ["disk isw_raid_member"]})
    assert found.returncode == 0, found.stderr
    assert erases_only(out, "vdb")


# A machine beyond TWO_DISKS: an internal SATA disk sda, and the installer on a USB stick (sdb)
# beside a disk with the ISO file on an LVM volume (sdc).
INSTALLER = {
    "devices": [
        "sda disk 0 0 sata", "sda1 part 0 0 sata", "sdb disk 1 0 usb", "sdc disk 0 0 sata",
        "loop0 loop 0 0 ", "sr0 rom 0 0 sata", "sr1 rom 1 1 sata", "vdc disk 0 1 ",
    ],
    "links": [
        "/dev/disk/by-id/usb-stick /dev/sdb",
        "/dev/disk/by-id/ata-data-part1 /dev/sda1",
        "/dev/disk/by-id/gone /dev/sdz",
    ],
    "mounts": ["/run/install/repo /dev/sdb1", "/run/install/isodir /dev/mapper/data-isos[/isos]"],
    "below": ["sdb1 sdb1 sdb", "mapper/data-isos data-isos sdc2 sdc"],
}
NOT_A_NAME = "is not a disk name"
# Each DISK= the %pre must refuse, and what it says.
BAD_DISKS = {
    "sdz": 'DISK="sdz" is not a block device',
    "/dev/sdz": "is not a block device",
    "/dev/disk/by-id/gone": "is not a block device",
    "/etc/passwd": "is not a block device",
    "sdb": "is /dev/sdb, the disk the installer started from",
    "/dev/disk/by-id/usb-stick": "is /dev/sdb, the disk the installer started from",
    "sdc": "is /dev/sdc, the disk the installer started from",
    "sda1": "is /dev/sda1, a part and not a whole disk",
    "/dev/disk/by-id/ata-data-part1": "is /dev/sda1, a part and not a whole disk",
    "loop0": "is /dev/loop0, a loop and not a whole disk",
    "sr0": "is /dev/sr0, a rom and not a whole disk",
    "sr1": "is /dev/sr1, a rom and not a whole disk",
    "vdc": "is /dev/vdc, which is read-only",
    "sda --foo": NOT_A_NAME,
    "--foo": NOT_A_NAME,
    "-sda": NOT_A_NAME,
    "/dev/disk/by-id/--only-use=sda": NOT_A_NAME,
    "sda,sdb": NOT_A_NAME,
    "sda\tsdb": NOT_A_NAME,
    "sda\nsdb": NOT_A_NAME,
    " sda": NOT_A_NAME,
    "sda;reboot": NOT_A_NAME,
    "--only-use=sda": NOT_A_NAME,
}


@pytest.mark.parametrize("disk", BAD_DISKS)
def test_a_disk_set_in_the_pre_must_be_a_writable_whole_disk_other_than_the_installer(disk, tmp_path):
    found, out, console = run_pre(tmp_path, TWO_DISKS, with_disk(disk), **INSTALLER)
    assert refused(found, out, console, BAD_DISKS[disk])


def test_the_internal_disk_beside_the_installer_is_still_accepted(tmp_path):
    found, out, _ = run_pre(tmp_path, TWO_DISKS, with_disk("sda"), **INSTALLER)
    assert found.returncode == 0, found.stderr
    assert erases_only(out, "sda")


WHOLE_DISK_CHECK = re.compile(r'^  \[\[ "\$type" == disk \]\] \|\|\n(    .*\n)(      .*\n)?', re.M)


@pytest.mark.parametrize("disk", ["loop0", "sr0"])
def test_only_the_whole_disk_check_refuses_a_writable_loop_or_rom_device(disk, tmp_path):
    without = WHOLE_DISK_CHECK.sub("", with_disk(disk), count=1)
    assert without != with_disk(disk)
    found, out, _ = run_pre(tmp_path, TWO_DISKS, without, **INSTALLER)
    assert found.returncode == 0, found.stderr
    assert erases_only(out, disk)


def test_anaconda_reads_it_as_one_disk(tmp_path):
    parser_module = pytest.importorskip("pykickstart.parser")
    from pykickstart.constants import CLEARPART_TYPE_ALL
    from pykickstart.version import makeVersion

    found, out, _ = run_pre(tmp_path, TWO_DISKS, with_disk(BY_ID), links=[f"{BY_ID} /dev/vdb"])
    assert found.returncode == 0, found.stderr
    handler = makeVersion("F44")
    parser_module.KickstartParser(handler).readKickstartFromString(KICKSTART.replace(INCLUDE, str(out)))
    assert handler.ignoredisk.onlyuse == ["vdb"]
    assert handler.clearpart.type == CLEARPART_TYPE_ALL
    assert handler.clearpart.drives == ["vdb"]
    assert handler.zerombr.zerombr
    assert handler.autopart.autopart and handler.autopart.encrypted
    assert [script.interp for script in handler.scripts] == ["/usr/bin/bash"]
