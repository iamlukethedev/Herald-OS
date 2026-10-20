"""`herald-os password --disk`: finding the root's LUKS devices, and changing the passphrase on real
LUKS2 images (file-backed, and a loop device where root is at hand). The images are made with a cheap
key derivation; the passphrases the change adds use cryptsetup's own defaults, as on a real disk, so
each change takes several seconds."""

import importlib.machinery
import importlib.util
import json
import os
import pty
import select
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "linux" / "bin" / "herald-os"
_LOADER = importlib.machinery.SourceFileLoader("herald_os_disk", str(CLI))
_SPEC = importlib.util.spec_from_loader("herald_os_disk", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

CRYPTSETUP = shutil.which("cryptsetup") or next((p for p in ("/usr/sbin/cryptsetup", "/sbin/cryptsetup") if os.access(p, os.X_OK)), None)
needs_cryptsetup = pytest.mark.skipif(CRYPTSETUP is None or sys.platform != "linux", reason="cryptsetup is not installed")
C_ENV = {**os.environ, "LC_ALL": "C", "PATH": f"{Path(CRYPTSETUP).parent}:{os.environ.get('PATH', '')}" if CRYPTSETUP else os.environ.get("PATH", "")}

OLD = "old disk pass 1"
NEW = "New-disk-pass-2"


def node(path, fstype=None, uuid=None, mounts=None, children=None, kind="part"):
    return {"name": path, "path": path, "type": kind, "fstype": fstype, "uuid": uuid, "mountpoints": mounts or [None], "children": children or []}


def bootc_tree(encrypted=True):
    root = node("/dev/mapper/luks-1", "btrfs", "fs-1", ["/sysroot", "/var", "/etc"], kind="crypt")
    third = node("/dev/vda3", "crypto_LUKS", "luks-1", children=[root]) if encrypted else node("/dev/vda3", "btrfs", "fs-1", ["/sysroot", "/var"])
    return [node("/dev/vda", kind="disk", children=[node("/dev/vda1", "vfat", "efi", ["/boot/efi"]), node("/dev/vda2", "ext4", "boot", ["/boot"]), third])]


def test_the_root_luks_device_of_an_image_install():
    assert cli.lsblk_root_luks(bootc_tree(), "fs-1") == ["/dev/vda3"]


def test_an_unencrypted_root_has_no_luks_device():
    assert cli.lsblk_root_luks(bootc_tree(encrypted=False), "fs-1") == []


def test_a_btrfs_over_two_encrypted_disks_finds_both():
    tree = bootc_tree()
    second = node("/dev/mapper/luks-2", "btrfs", "fs-1", kind="crypt")
    tree.append(node("/dev/vdb", kind="disk", children=[node("/dev/vdb1", "crypto_LUKS", "luks-2", children=[second])]))
    assert cli.lsblk_root_luks(tree, "fs-1") == ["/dev/vda3", "/dev/vdb1"]
    # Without the root's UUID (findmnt failed), the mount still finds the first.
    assert cli.lsblk_root_luks(tree, None) == ["/dev/vda3"]


def test_an_encrypted_data_disk_is_not_the_root():
    tree = bootc_tree()
    data = node("/dev/mapper/luks-data", "ext4", "data", ["/var/mnt/data"], kind="crypt")
    tree.append(node("/dev/sdb", "crypto_LUKS", "luks-data", children=[data], kind="disk"))
    assert cli.lsblk_root_luks(tree, "fs-1") == ["/dev/vda3"]


def test_lvm_inside_luks_and_an_older_lsblk():
    lv = {"name": "/dev/mapper/fedora-root", "path": "/dev/mapper/fedora-root", "type": "lvm", "fstype": "xfs", "uuid": "fs-9", "mountpoint": "/"}
    pv = {"name": "/dev/mapper/luks-9", "path": "/dev/mapper/luks-9", "type": "crypt", "fstype": "LVM2_member", "uuid": "pv", "mountpoint": None, "children": [lv]}
    tree = [{"name": "/dev/sda", "type": "disk", "children": [{"name": "/dev/sda2", "type": "part", "fstype": "crypto_LUKS", "children": [pv]}]}]
    assert cli.lsblk_root_luks(tree, None) == ["/dev/sda2"]
    assert cli.lsblk_root_luks("not a list", None) == []


def test_crypttab_names_its_devices_as_paths():
    text = "\n".join([
        "# <name> <device> <password> <options>",
        "luks-1 UUID=1111-2222 none discard",
        "luks-2 PARTUUID=aaaa none",
        "swap /dev/vdb2 /dev/urandom swap",
        "data LABEL=data none",
        "",
        "luks-1 UUID=1111-2222 none",
        "bad",
    ])
    assert cli.crypttab_sources(text) == ["/dev/disk/by-uuid/1111-2222", "/dev/disk/by-partuuid/aaaa", "/dev/vdb2", "/dev/disk/by-label/data"]


def test_what_a_new_disk_password_must_be():
    assert cli.disk_password_problem("long enough", "long enough", "the old one") is None
    assert "not the same" in cli.disk_password_problem("long enough", "long enougj", "x")
    assert "at least 8" in cli.disk_password_problem("short", "short", "x")
    assert "ASCII" in cli.disk_password_problem("senha-coração", "senha-coração", "x")
    assert "ASCII" in cli.disk_password_problem("密码密码密码密码", "密码密码密码密码", "x")
    assert "ASCII" in cli.disk_password_problem("tab\there!", "tab\there!", "x")
    assert "same as the current" in cli.disk_password_problem("the old one", "the old one", "the old one")


def test_the_other_slots_and_the_tokens_left_without_one():
    metadata = {"keyslots": {"0": {}, "1": {}, "3": {}}, "tokens": {"0": {"type": "systemd-tpm2", "keyslots": ["1"]}, "1": {"type": "x", "keyslots": ["3", "0"]}, "2": {"type": "y", "keyslots": []}}}
    assert cli.luks_extra(metadata, 3) == ([0, 1], [0, 2])
    assert cli.luks_extra({}, 0) == ([], [])


def test_a_reset_says_what_it_leaves_on_the_disk():
    assert "not a secure erase" in cli.reset_disk_note(False)
    assert "tell it to them" in cli.reset_disk_note(True)


def test_the_cli_refuses_wrong_disk_arguments():
    for wrong in (["--disk", "--now"], ["--disk", "--status", "--new-owner"], ["--disk", "--new-owner", "--new-owner"], ["extra"]):
        result = subprocess.run([sys.executable, str(CLI), "password", *wrong], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        assert result.returncode == 2, wrong
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk-root", "change"], input="not json", capture_output=True, text=True)
    assert result.returncode == 2 and "JSON" in result.stderr


# ----- real LUKS2 images


def make_image(path: Path, passphrase: str) -> Path:
    path.write_bytes(b"")
    os.truncate(path, 32 * 1024 * 1024)
    subprocess.run([CRYPTSETUP, "luksFormat", "-q", "--type", "luks2", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file=-", str(path)], input=passphrase.encode(), check=True, env=C_ENV)
    return path


def opens(path: Path, passphrase: str) -> bool:
    """As typed at a prompt: the line, without its newline."""
    return subprocess.run([CRYPTSETUP, "open", "--test-passphrase", "--disable-external-tokens", str(path)], input=f"{passphrase}\n".encode(), capture_output=True, env=C_ENV).returncode == 0


def slots(path: Path) -> list[str]:
    dump = subprocess.run([CRYPTSETUP, "luksDump", "--dump-json-metadata", str(path)], capture_output=True, check=True, env=C_ENV)
    return sorted(json.loads(dump.stdout)["keyslots"])


def root_side(op: str, request: dict) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(CLI), "password", "--disk-root", op], input=json.dumps(request), capture_output=True, text=True, env=C_ENV, timeout=600)


@needs_cryptsetup
def test_a_change_adds_the_new_password_and_the_old_one_stops_working(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    result = root_side("change", {"devices": [str(disk)], "current": OLD, "new": NEW})
    assert result.returncode == 0, result.stderr
    assert "Done" in result.stdout
    assert opens(disk, NEW)
    assert not opens(disk, OLD)
    assert len(slots(disk)) == 1


@needs_cryptsetup
def test_a_wrong_current_password_changes_nothing(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    for op in ("check", "change"):
        result = root_side(op, {"devices": [str(disk)], "current": "not the password", "new": NEW})
        assert result.returncode == cli.DISK_WRONG
        assert "not the disk password" in result.stderr
    assert root_side("check", {"devices": [str(disk)], "current": OLD}).returncode == 0
    assert opens(disk, OLD) and not opens(disk, NEW)
    assert slots(disk) == ["0"]


@needs_cryptsetup
def test_a_device_that_is_not_luks_is_refused(tmp_path):
    plain = tmp_path / "plain.img"
    plain.write_bytes(b"")
    os.truncate(plain, 4 * 1024 * 1024)
    result = root_side("check", {"devices": [str(plain)], "current": OLD})
    assert result.returncode == cli.DISK_NOT_ENCRYPTED


@needs_cryptsetup
def test_an_old_password_in_two_slots_goes_from_both(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    key = tmp_path / "key"
    key.write_text(OLD)
    subprocess.run([CRYPTSETUP, "luksAddKey", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", str(key), str(disk), str(key)], env=C_ENV, check=True)
    assert len(slots(disk)) >= 2
    result = root_side("change", {"devices": [str(disk)], "current": OLD, "new": NEW})
    assert result.returncode == 0, result.stderr
    assert not opens(disk, OLD) and opens(disk, NEW)


@needs_cryptsetup
def test_a_new_owner_keeps_only_their_own_password(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    other = tmp_path / "other"
    other.write_text("someone else's")
    keyfile = tmp_path / "old"
    keyfile.write_text(OLD)
    subprocess.run([CRYPTSETUP, "luksAddKey", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", str(keyfile), str(disk), str(other)], env=C_ENV, check=True)
    token = {"type": "herald-test", "keyslots": ["1"]}
    subprocess.run([CRYPTSETUP, "token", "import", "--json-file", "-", str(disk)], input=json.dumps(token).encode(), env=C_ENV, check=True)
    assert slots(disk) == ["0", "1"]
    result = root_side("change", {"devices": [str(disk)], "current": OLD, "new": NEW, "newOwner": True})
    assert result.returncode == 0, result.stderr
    assert opens(disk, NEW)
    assert not opens(disk, OLD)
    assert not opens(disk, "someone else's")
    assert len(slots(disk)) == 1
    dump = subprocess.run([CRYPTSETUP, "luksDump", "--dump-json-metadata", str(disk)], capture_output=True, check=True, env=C_ENV)
    assert json.loads(dump.stdout)["tokens"] == {}


@needs_cryptsetup
def test_every_root_device_changes_or_none_does(tmp_path):
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == 0, result.stderr
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))

    # A second device the password does not open: refused before either changes.
    third, fourth = make_image(tmp_path / "c.img", OLD), make_image(tmp_path / "d.img", "a different one")
    result = root_side("change", {"devices": [str(third), str(fourth)], "current": OLD, "new": NEW})
    assert result.returncode == cli.DISK_WRONG and str(fourth) in result.stderr
    assert opens(third, OLD) and not opens(third, NEW)


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0, reason="root writes to a read-only file")
def test_a_failed_add_takes_the_new_password_back_out(tmp_path):
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    second.chmod(0o444)
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == 1
    assert "nothing was changed" in result.stderr
    assert opens(first, OLD) and not opens(first, NEW)
    assert slots(first) == ["0"]


def fake_tools(folder: Path, disk: Path) -> dict:
    """sudo that runs the command (and asks once, like sudo -v), and lsblk and findmnt that show the image as the root's LUKS device."""
    folder.mkdir()
    tree = {"blockdevices": [{"name": str(disk), "path": str(disk), "type": "loop", "fstype": "crypto_LUKS", "uuid": "luks-t",
                              "children": [{"name": "/dev/mapper/luks-t", "path": "/dev/mapper/luks-t", "type": "crypt", "fstype": "btrfs", "uuid": "fs-t", "mountpoints": ["/sysroot"]}]}]}
    (folder / "lsblk").write_text(f"#!/bin/sh\ncat <<'EOF'\n{json.dumps(tree)}\nEOF\n")
    (folder / "findmnt").write_text("#!/bin/sh\n[ \"$5\" = /sysroot ] && echo fs-t\n")
    (folder / "sudo").write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $1 == -v ]]; then printf '%s' \"${3/\\%p/$USER}\" >/dev/tty; IFS= read -rs answer </dev/tty; echo >/dev/tty; [[ $answer == account-pass ]]; exit; fi\n"
        "[[ $1 == -n ]] && shift\n"
        "exec \"$@\"\n"
    )
    for tool in ("lsblk", "findmnt", "sudo"):
        (folder / tool).chmod(0o755)
    return {**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}", "USER": "tester"}


def converse(argv: list[str], env: dict, answers: list[tuple[str, str]], timeout: float = 600) -> tuple[int, str]:
    """Run argv on a terminal of its own and answer each prompt as it comes. `setsid -c` makes the
    terminal the command's own (getpass and sudo read /dev/tty), without forking the test process."""
    if not shutil.which("setsid"):
        pytest.skip("needs setsid (util-linux)")
    fd, child_end = pty.openpty()
    process = subprocess.Popen(["setsid", "-c", *argv], stdin=child_end, stdout=child_end, stderr=child_end, env=env, close_fds=True)
    os.close(child_end)
    screen, pending, deadline = "", list(answers), time.monotonic() + timeout
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 1)
        if ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            screen += data.decode(errors="replace")
            if pending and screen.rstrip().endswith(pending[0][0]):
                os.write(fd, f"{pending.pop(0)[1]}\n".encode())
    code = process.wait(timeout=max(1.0, deadline - time.monotonic()))
    os.close(fd)
    return code, screen


@needs_cryptsetup
def test_the_command_asks_sudo_then_both_passwords(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [
        ("[sudo] password for tester:", "account-pass"),
        ("Current disk password:", OLD),
        ("New disk password:", NEW),
        ("New disk password again:", NEW),
    ])
    assert code == 0, screen
    assert f"unlocks {disk}" in screen and "Done" in screen
    assert opens(disk, NEW) and not opens(disk, OLD)

    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env)
    assert json.loads(status.stdout)["encrypted"] is True


@needs_cryptsetup
def test_the_command_stops_at_a_wrong_password_or_a_mismatch(tmp_path):
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [("for tester:", "account-pass"), ("Current disk password:", "wrong one!")])
    assert code == cli.DISK_WRONG and "not the disk password" in screen
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [("for tester:", "account-pass"), ("Current disk password:", OLD), ("New disk password:", NEW), ("again:", NEW + "x")])
    assert code == 2 and "not the same" in screen
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [("for tester:", "not it")])
    assert code == cli.DISK_NO_ROOT
    assert opens(disk, OLD) and not opens(disk, NEW)


def test_an_unencrypted_disk_says_so(tmp_path):
    folder = tmp_path / "bin"
    folder.mkdir()
    tree = {"blockdevices": [{"name": "/dev/vda3", "path": "/dev/vda3", "type": "part", "fstype": "btrfs", "uuid": "fs", "mountpoints": ["/sysroot"]}]}
    (folder / "lsblk").write_text(f"#!/bin/sh\necho '{json.dumps(tree)}'\n")
    (folder / "findmnt").write_text("#!/bin/sh\necho fs\n")
    for tool in ("lsblk", "findmnt"):
        (folder / tool).chmod(0o755)
    env = {**os.environ, "PATH": f"{folder}:{os.environ['PATH']}"}
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk"], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert result.returncode == cli.DISK_NOT_ENCRYPTED
    assert "not encrypted" in result.stderr and "Encrypt my data" in result.stderr
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env)
    assert json.loads(status.stdout) == {"encrypted": False, "devices": [], "newOwner": False}


def sudo_works() -> bool:
    return os.geteuid() == 0 or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0


@needs_cryptsetup
@pytest.mark.skipif(not shutil.which("losetup") or not sudo_works(), reason="needs losetup and root (sudo -n)")
def test_on_a_loop_device_the_old_password_no_longer_opens_the_volume(tmp_path):
    """The real thing: a loop device, opened with dm-crypt, through sudo as `herald-os password --disk` uses it."""
    disk = make_image(tmp_path / "disk.img", OLD)
    sudo = [] if os.geteuid() == 0 else ["sudo", "-n"]
    loop = subprocess.run([*sudo, "losetup", "--find", "--show", str(disk)], capture_output=True, text=True)
    if loop.returncode != 0:
        pytest.skip(f"no loop device: {loop.stderr.strip()}")
    device = loop.stdout.strip()
    name = f"herald-test-{os.getpid()}"

    dm = bool(shutil.which("dmsetup")) and subprocess.run([*sudo, "dmsetup", "version"], capture_output=True).returncode == 0

    def activates(passphrase: str) -> bool:
        """Opened with dm-crypt where the kernel has it; else the same check on the block device, as root."""
        argv = ["open", "--disable-external-tokens", device, name] if dm else ["open", "--test-passphrase", "--disable-external-tokens", device]
        result = subprocess.run([*sudo, CRYPTSETUP, *argv], input=f"{passphrase}\n".encode(), capture_output=True, env=C_ENV)
        if result.returncode == 0 and dm:
            subprocess.run([*sudo, CRYPTSETUP, "close", name], check=True)
        return result.returncode == 0

    try:
        assert activates(OLD)
        result = subprocess.run([*sudo, sys.executable, str(CLI), "password", "--disk-root", "change"], input=json.dumps({"devices": [device], "current": OLD, "new": NEW}), capture_output=True, text=True, env=C_ENV, timeout=600)
        assert result.returncode == 0, result.stderr
        assert activates(NEW)
        assert not activates(OLD)
    finally:
        subprocess.run([*sudo, CRYPTSETUP, "close", name], capture_output=True)
        subprocess.run([*sudo, "losetup", "-d", device], capture_output=True)
