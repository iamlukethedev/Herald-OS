"""linux/image/unattended.ks erases one disk, the one its %pre picks, and leaves every other disk alone."""

import base64
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
KICKSTART = (ROOT / "linux" / "image" / "unattended.ks").read_text()
INCLUDE = "/tmp/herald-os-disk.ks"
PRE = re.search(r"^%pre [^\n]*\n(.*?)^%end$", KICKSTART, re.M | re.S).group(1)
# The bash that runs the %pre and the fakes: Anaconda has bash 5, macOS CI has bash 3.2, so both
# must work. HERALD_OS_TEST_BASH=/path/to/bash-3.2 runs them under another one.
BASH = shutil.which(os.environ.get("HERALD_OS_TEST_BASH", "bash"))

# The fakes answer the lsblk, findmnt and readlink calls the %pre makes, from files in $FAKE.
LSBLK = """#!/usr/bin/env bash
dev="${!#}"
lookup() {
  while read -r name type _ ro _; do
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
while read -r mount source; do [[ "$mount" == "${!#}" ]] && { echo "$source"; exit 0; }; done <"$FAKE/mounts"
exit 1
"""
# Like udev's links, the ones in $FAKE/links point at relative targets (../../vdb): only
# readlink -f gives the device; plain readlink prints the target as it is, or nothing for a non-link.
READLINK = """#!/usr/bin/env bash
target_of() {
  local link target
  while read -r link target; do [[ "$link" == "$1" ]] && { echo "$target"; return 0; }; done <"$FAKE/links"
  return 1
}
normalize() {
  local IFS=/ part
  local parts=()
  for part in $1; do
    case "$part" in
      "" | .) ;;
      ..) [[ ${#parts[@]} -gt 0 ]] && unset "parts[${#parts[@]}-1]"; parts=(${parts[@]+"${parts[@]}"}) ;;
      *) parts+=("$part") ;;
    esac
  done
  echo "/${parts[*]}"
}
if [[ "$1" != -f ]]; then
  target_of "$1" || exit 1
  exit 0
fi
path="$(normalize "$2")"
while target="$(target_of "$path")"; do
  [[ "$target" == /* ]] || target="${path%/*}/$target"
  path="$(normalize "$target")"
done
echo "$path"
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
    "loop, RAID, LVM and DVD devices beside one disk": (
        ["loop0 loop 0 0 ", "md127 raid1 0 0 ", "dm-0 lvm 0 0 ", "sr0 rom 0 0 sata", "vda disk 0 0 "], {}, "vda",
    ),
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
    (bin_dir / "bash").symlink_to(BASH)
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


def command_lines() -> list[tuple[str, str]]:
    """Each line outside comments, with the section it is in ("" for the commands)."""
    section, lines = "", []
    for line in KICKSTART.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        if line == "%end":
            section = ""
        elif re.match(r"%(pre|post|packages|onerror|traceback|addon|anaconda)\b", line):
            section = line.split()[0]
        lines.append((section, line))
    return lines


def test_the_include_is_one_top_level_command_before_the_storage_commands():
    commands = [line for section, line in command_lines() if section == ""]
    includes = [line for _, line in command_lines() if line.lstrip().startswith("%include")]
    assert includes == [f"%include {INCLUDE}", f"%include {ACCOUNT_INCLUDE}"]
    words = [line.split()[0] for line in commands]
    at = words.index("%include")
    assert words[at : at + 3] == ["%include", "zerombr", "autopart"]
    assert words.index("lang") < at < words.index("ostreecontainer")
    everything = [line for _, line in command_lines()]
    assert everything.index(f"%include {INCLUDE}") < everything.index(next(line for line in everything if line.startswith("%pre ")))


def test_the_disk_commands_come_only_from_the_pre():
    commands = [line.split()[0] for line in main_section().splitlines() if line and not line.startswith("#")]
    assert "clearpart" not in commands
    assert "ignoredisk" not in commands
    assert f"%include {INCLUDE}" in main_section().splitlines()
    assert "--erroronfail" in KICKSTART.split("\n%pre ", 1)[1].splitlines()[0]


# What bash 3.2 (macOS) lacks, so the %pre and the fakes stay runnable there.
BASH_4_ONLY = {
    "mapfile or readarray": r"\b(mapfile|readarray)\b",
    "coproc": r"\bcoproc\b",
    "associative arrays or namerefs": r"\b(declare|local|typeset)\s+-[A-Za-z]*[An]",
    "case changes": r"\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?(,,?|\^\^?)\}",
    "@ transformations": r"\$\{[^}]*@[QEPAaKkUuL]\}",
    "negative indexes": r"\$\{[A-Za-z_][A-Za-z0-9_]*\[-",
    "|&": r"\|&",
    "&>>": r"&>>",
    "case fall-through": r";;?&",
    "fd variables": r"\{[A-Za-z_][A-Za-z0-9_]*\}[<>]",
    "bash 4 options": r"\b(wait\s+-n|read\s+-[A-Za-z]*[iN]|shopt\s+-s\s+(globstar|lastpipe|direxpand|autocd))\b",
}


@pytest.mark.parametrize("script", ["%pre", "account %pre", "lsblk", "findmnt", "readlink"])
def test_the_scripts_need_only_bash_3_2(script):
    text = {"%pre": PRE, "account %pre": ACCOUNT_PRE, "lsblk": LSBLK, "findmnt": FINDMNT, "readlink": READLINK}[script]
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    found = {name for name, pattern in BASH_4_ONLY.items() if re.search(pattern, code)}
    assert found == set()


@pytest.mark.parametrize("script", ["%pre", "account %pre", "lsblk", "findmnt", "readlink"])
def test_the_scripts_pass_shellcheck(script, tmp_path):
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck is not installed")
    text = {"%pre": PRE, "account %pre": ACCOUNT_PRE, "lsblk": LSBLK, "findmnt": FINDMNT, "readlink": READLINK}[script]
    path = tmp_path / "script.sh"
    path.write_text(text if text.startswith("#!") else "#!/usr/bin/env bash\n" + text)
    found = subprocess.run(["shellcheck", "--shell=bash", str(path)], capture_output=True, text=True, check=False)
    assert found.returncode == 0, found.stdout


def test_the_bash_3_2_check_finds_mapfile():
    assert re.search(BASH_4_ONLY["mapfile or readarray"], "  mapfile -t disks < <(internal_disks)")
    assert re.search(BASH_4_ONLY["case changes"], 'echo "${DISK,,}"')
    assert re.search(BASH_4_ONLY["associative arrays or namerefs"], "  local -A seen")
    assert not re.search(BASH_4_ONLY["case changes"], 'echo "${2//,/ }"')


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
    links = [f"{BY_ID} ../../vdb"]
    found, out, console = run_pre(tmp_path, TWO_DISKS, with_disk(disk), links=links)
    assert found.returncode == 0, found.stderr
    assert erases_only(out, expected)
    assert f"erasing {expected}, and only {expected}" in console.read_text()


def test_a_by_id_link_through_another_link_is_followed(tmp_path):
    links = ["/dev/disk/by-label/data ../by-id/virtio-data", f"{BY_ID} ../../vdb"]
    found, out, _ = run_pre(tmp_path, TWO_DISKS, with_disk("/dev/disk/by-label/data"), links=links)
    assert found.returncode == 0, found.stderr
    assert erases_only(out, "vdb")


# A machine beyond TWO_DISKS: an internal SATA disk sda, the installer on a USB stick (sdb) beside
# a disk with the ISO file on an LVM volume (sdc), sdd and sdg as the two paths of the multipath
# device mpatha (dm-0), and sde and sdf as whole-disk members of an md and a BIOS RAID set.
INSTALLER = {
    "devices": [
        "sda disk 0 0 sata", "sda1 part 0 0 sata", "sdb disk 1 0 usb", "sdc disk 0 0 sata",
        "loop0 loop 0 0 ", "sr0 rom 0 0 sata", "sr1 rom 1 1 sata", "vdc disk 0 1 ",
        "dm-0 mpath 0 0 ", "sdd disk 0 0 fc", "sdg disk 0 0 fc", "sde disk 0 0 sata", "sdf disk 0 0 sata",
    ],
    "links": [
        "/dev/disk/by-id/usb-stick ../../sdb",
        "/dev/disk/by-id/ata-data-part1 ../../sda1",
        "/dev/disk/by-id/gone ../../sdz",
        "/dev/mapper/mpatha ../dm-0",
        "/dev/disk/by-id/dm-uuid-mpath-3600 ../../dm-0",
        "/dev/disk/by-path/fc-0x500-lun-0 ../../sdd",
        "/dev/disk/by-id/ata-raid-disk ../../sde",
    ],
    "trees": {
        "sdd": ["disk mpath_member", "mpath "],
        "sdg": ["disk ", "mpath "],
        "sde": ["disk linux_raid_member", "raid1 "],
        "sdf": ["disk isw_raid_member"],
    },
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
    "/dev/mapper/mpatha": "is /dev/dm-0, a mpath and not a whole disk",
    "/dev/disk/by-id/dm-uuid-mpath-3600": "is /dev/dm-0, a mpath and not a whole disk",
    "sdd": "is /dev/sdd, part of a multipath device or RAID set",
    "sdg": "is /dev/sdg, part of a multipath device or RAID set",
    "/dev/disk/by-path/fc-0x500-lun-0": "is /dev/sdd, part of a multipath device or RAID set",
    "sde": "is /dev/sde, part of a multipath device or RAID set",
    "/dev/disk/by-id/ata-raid-disk": "is /dev/sde, part of a multipath device or RAID set",
    "sdf": "is /dev/sdf, part of a multipath device or RAID set",
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
    account = tmp_path / "account.ks"
    account.write_text("# nothing chosen\n")
    handler = makeVersion("F44")
    parser_module.KickstartParser(handler).readKickstartFromString(KICKSTART.replace(INCLUDE, str(out)).replace(ACCOUNT_INCLUDE, str(account)))
    assert handler.ignoredisk.onlyuse == ["vdb"]
    assert handler.clearpart.type == CLEARPART_TYPE_ALL
    assert handler.clearpart.drives == ["vdb"]
    assert handler.zerombr.zerombr
    assert handler.autopart.autopart and handler.autopart.encrypted
    assert [script.interp for script in handler.scripts] == ["/usr/bin/bash", "/usr/bin/bash"]


# The account %pre: the account's name and the SSH keys that may sign in to it, checked (and GitHub's
# keys read) before anything is erased, and written into the installed system by a %post it makes.
ACCOUNT_INCLUDE = "/tmp/herald-os-account.ks"
ACCOUNT_PRE = re.search(r"^%pre [^\n]*--log=/tmp/herald-os-account\.log\n(.*?)^%end$", KICKSTART, re.M | re.S).group(1)


def public_key(kind: str = "ssh-ed25519", comment: str = "me@laptop", seed: int = 1, data_kind: str | None = None) -> str:
    name = (data_kind or kind).encode()
    body = bytes([seed]) * 32
    blob = struct.pack(">I", len(name)) + name + struct.pack(">I", len(body)) + body
    return f"{kind} {base64.b64encode(blob).decode()} {comment}".strip()


def with_settings(pre: str = ACCOUNT_PRE, **settings: str) -> str:
    for name, value in settings.items():
        assert f'\n{name}=""\n' in pre
        pre = pre.replace(f'\n{name}=""\n', f"\n{name}={shlex.quote(value)}\n", 1)
    return pre


def run_account_pre(tmp_path: Path, pre: str = ACCOUNT_PRE, github: dict[str, str] | None = None) -> tuple[subprocess.CompletedProcess, Path, Path]:
    """The account %pre, with a stand-in curl that answers for github.com from `github`."""
    bin_dir, pages = tmp_path / "bin", tmp_path / "pages"
    bin_dir.mkdir()
    pages.mkdir()
    (bin_dir / "bash").symlink_to(BASH)
    (bin_dir / "python3").symlink_to(sys.executable)
    for name, text in (github or {}).items():
        (pages / f"{name}.keys").write_text(text)
    (bin_dir / "curl").write_text('#!/usr/bin/env bash\nurl="${!#}"\npage="$PAGES/${url##*/}"\n[[ -f "$page" ]] || exit 22\ncat "$page"\n')
    (bin_dir / "curl").chmod(0o755)
    out, console = tmp_path / "account.ks", tmp_path / "console"
    console.write_text("")
    found = subprocess.run(
        ["bash", "-c", pre.replace(ACCOUNT_INCLUDE, str(out)).replace("/dev/console", str(console))],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "PAGES": str(pages)},
        capture_output=True,
        text=True,
        check=False,
    )
    return found, out, console


def installed(tmp_path: Path, include: Path) -> dict[str, str]:
    """What the %post the account %pre wrote leaves in the installed system's /etc/herald-os."""
    post = re.search(r"^%post [^\n]*\n(.*?)^%end$", include.read_text(), re.M | re.S)
    if not post:
        return {}
    etc = tmp_path / "etc"
    found = subprocess.run(["bash", "-euc", post.group(1).replace("/etc/herald-os", str(etc / "herald-os"))], capture_output=True, text=True, check=False)
    assert found.returncode == 0, found.stderr
    return {path.name: path.read_text() for path in sorted((etc / "herald-os").iterdir())}


def account_refused(found: subprocess.CompletedProcess, out: Path, console: Path, *said: str) -> bool:
    told = [found.stderr, console.read_text()]
    return found.returncode != 0 and not out.exists() and all("nothing was erased" in text for text in told) and all(words in text for words in said for text in told)


def test_with_nothing_chosen_the_install_writes_nothing_and_ssh_stays_off(tmp_path):
    found, out, _ = run_account_pre(tmp_path)
    assert found.returncode == 0, found.stderr
    assert "%post" not in out.read_text() and installed(tmp_path, out) == {}
    assert "the account: hermes; SSH: off" in found.stderr


def test_the_chosen_name_and_keys_reach_the_installed_system(tmp_path):
    one, two = public_key(seed=1), public_key("ecdsa-sha2-nistp256", seed=2, comment="it's \"mine\" HERALD_OS_KEYS")
    pre = with_settings(ACCOUNT="luke", SSH_KEYS=f"# laptop\n  {one}\n\n{two}\n")
    found, out, _ = run_account_pre(tmp_path, pre)
    assert found.returncode == 0, found.stderr
    assert installed(tmp_path, out) == {"install.conf": "user=luke\n", "ssh-keys": f"{one}\n{two}\n"}
    assert "the account: luke; SSH: on at the first start, for 2 key(s) only" in found.stderr


def test_keys_alone_are_for_hermes(tmp_path):
    found, out, _ = run_account_pre(tmp_path, with_settings(SSH_KEYS=public_key()))
    assert found.returncode == 0, found.stderr
    assert installed(tmp_path, out) == {"ssh-keys": f"{public_key()}\n"}


def test_github_keys_are_read_while_the_installer_is_online_and_marked(tmp_path):
    one, two = public_key(comment="", seed=1), public_key(comment="", seed=2)
    found, out, _ = run_account_pre(tmp_path, with_settings(GITHUB_KEYS="octocat"), github={"octocat": f"{one}\n{two}\nssh-dss AAAA\n"})
    assert found.returncode == 0, found.stderr
    assert installed(tmp_path, out) == {"ssh-keys": f"{one} github:octocat\n{two} github:octocat\n"}


@pytest.mark.parametrize("name", ["root", "Luke", "1luke", "lu ke", "luke;reboot", "a" * 33])
def test_an_unusable_account_name_stops_the_install_before_any_disk_is_erased(tmp_path, name):
    assert account_refused(*run_account_pre(tmp_path, with_settings(ACCOUNT=name)), "is not an account name")


@pytest.mark.parametrize("key", [public_key("ssh-dss"), f"restrict {public_key()}", "ssh-ed25519 AAAA", public_key(data_kind="ssh-rsa"), "hello"])
def test_a_line_that_is_not_a_public_key_stops_the_install(tmp_path, key):
    assert account_refused(*run_account_pre(tmp_path, with_settings(SSH_KEYS=f"{public_key()}\n{key}")), "not an SSH public key")


def test_a_github_account_that_cannot_be_read_or_has_no_keys_stops_the_install(tmp_path):
    for name, (github, said) in {
        "missing": ({}, "could not read https://github.com/missing.keys"),
        "empty": ({"empty": "\n"}, "empty has no SSH keys on GitHub"),
        "-bad-": ({}, "is not a GitHub user name"),
    }.items():
        attempt = tmp_path / name
        attempt.mkdir()
        assert account_refused(*run_account_pre(attempt, with_settings(GITHUB_KEYS=name), github), said), name


def test_anaconda_reads_the_account_s_post(tmp_path):
    parser_module = pytest.importorskip("pykickstart.parser")
    from pykickstart.constants import KS_SCRIPT_POST
    from pykickstart.version import makeVersion

    (tmp_path / "disk").mkdir()
    (tmp_path / "account").mkdir()
    disk, disk_out, _ = run_pre(tmp_path / "disk", ["vda disk 0 0 "])
    found, out, _ = run_account_pre(tmp_path / "account", with_settings(ACCOUNT="luke", SSH_KEYS=public_key()))
    assert disk.returncode == 0 and found.returncode == 0, found.stderr
    handler = makeVersion("F44")
    text = KICKSTART.replace(INCLUDE, str(disk_out)).replace(ACCOUNT_INCLUDE, str(out))
    parser_module.KickstartParser(handler).readKickstartFromString(text)
    posts = [script for script in handler.scripts if script.type == KS_SCRIPT_POST]
    assert len(posts) == 1 and posts[0].interp == "/usr/bin/bash" and posts[0].errorOnFail and posts[0].inChroot
    assert "user=luke" in posts[0].script and "/etc/herald-os/ssh-keys" in posts[0].script


def test_the_account_pre_stops_on_error_and_logs_where_the_installer_keeps_logs():
    header = next(line for line in KICKSTART.splitlines() if line.startswith("%pre ") and "herald-os-account" in line)
    assert "--erroronfail" in header and "--log=/tmp/herald-os-account.log" in header
    everything = [line for _, line in command_lines()]
    assert everything.index(f"%include {ACCOUNT_INCLUDE}") > everything.index("reboot")


@pytest.mark.parametrize("check, old, new, settings", [
    ("account name", '[[ "$ACCOUNT" =~ $account_pattern && "$ACCOUNT" != root ]] ||', "true ||", {"ACCOUNT": "luke;reboot"}),
    ("root", ' && "$ACCOUNT" != root ]]', " ]]", {"ACCOUNT": "root"}),
    ("key", '  valid_key "$line" ||\n', "  true ||\n", {"SSH_KEYS": f'command="sh" {public_key()}'}),
    ("key data", "blob[4:4 + size] == fields[0].encode()", "True", {"SSH_KEYS": public_key(data_kind="ssh-rsa")}),
    ("github name", '[[ "$name" =~ $github_pattern ]] ||', "true ||", {"GITHUB_KEYS": "-bad-"}),
])
def test_each_account_check_is_caught_when_taken_out(tmp_path, check, old, new, settings):
    assert ACCOUNT_PRE.count(old) == 1, f"the account %pre no longer has exactly one {old!r}"
    (tmp_path / "real").mkdir()
    (tmp_path / "mutant").mkdir()
    github = {"-bad-": public_key()}
    assert account_refused(*run_account_pre(tmp_path / "real", with_settings(**settings), github))
    assert not account_refused(*run_account_pre(tmp_path / "mutant", with_settings(ACCOUNT_PRE.replace(old, new), **settings), github)), check
