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
    assert "could not tell" in cli.reset_disk_note(None) and "not a secure erase" in cli.reset_disk_note(None)


def test_the_cli_refuses_wrong_disk_arguments():
    for wrong in (["--disk", "--now"], ["--disk", "--status", "--new-owner"], ["--disk", "--new-owner", "--new-owner"], ["extra"]):
        result = subprocess.run([sys.executable, str(CLI), "password", *wrong], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        assert result.returncode == 2, wrong
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk-root", "change"], input="not json", capture_output=True, text=True)
    assert result.returncode == 2 and "JSON" in result.stderr


def test_a_new_password_that_does_not_open_the_disk_is_taken_back(monkeypatch, capsys):
    """luksAddKey said yes, but the new password opens nothing: the old one must stay, the new one go."""
    calls = []
    monkeypatch.setattr(cli, "cryptsetup", lambda args, key=None, new=None: calls.append((args[0], key)) or subprocess.CompletedProcess(args, 0, b"", b""))
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: 0 if passphrase == OLD else None)
    assert cli.disk_change(["/dev/vda3"], OLD, NEW, False, {"/dev/vda3": 0}) == 1
    assert calls == [("luksAddKey", OLD), ("luksRemoveKey", NEW)]
    assert "does not open /dev/vda3" in capsys.readouterr().err


def stand_in_disks(monkeypatch, remove, removes=True):
    """cryptsetup and luks_slot for two devices: adding works on the first and fails on the second, so
    the new password is taken back from the first; `remove(device)` is what luksRemoveKey does there
    (a returncode, or raises), and the new password opens the first until a removal works; with
    `removes` False, a removal that says yes leaves it there."""
    opened = {"/dev/vda3": {OLD}, "/dev/vdb1": {OLD}}

    def cryptsetup(args, key=None, new=None):
        device = args[-1]
        if args[0] == "luksAddKey":
            if device == "/dev/vdb1":
                return subprocess.CompletedProcess(args, 1, b"", b"Keyslot area too small.")
            opened[device].add(new)
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if args[0] == "luksRemoveKey":
            code = remove(device)
            if code == 0 and removes:
                opened[device].discard(key)
            return subprocess.CompletedProcess(args, code, b"", b"Device /dev/vda3 is busy.")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.setattr(cli, "cryptsetup", cryptsetup)
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: (0 if passphrase == OLD else 1) if passphrase in opened[device] else None)
    return opened


def test_a_rollback_that_works_says_nothing_was_changed(monkeypatch, capsys):
    opened = stand_in_disks(monkeypatch, lambda device: 0)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == 1
    assert opened == {"/dev/vda3": {OLD}, "/dev/vdb1": {OLD}}
    assert "nothing was changed" in capsys.readouterr().err


@pytest.mark.parametrize("remove", [
    lambda device: 1,
    lambda device: (_ for _ in ()).throw(subprocess.TimeoutExpired(["cryptsetup"], 300)),
], ids=["luksRemoveKey fails", "luksRemoveKey times out"])
def test_a_rollback_that_fails_says_the_new_password_may_still_open_that_device(monkeypatch, capsys, remove):
    opened = stand_in_disks(monkeypatch, remove)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == cli.DISK_NOT_TAKEN_BACK
    err = capsys.readouterr().err
    assert "nothing was changed" not in err
    assert "could not be taken back out of /dev/vda3" in err and "may open /dev/vda3 too" in err
    assert "sudo cryptsetup luksRemoveKey /dev/vda3" in err and "vdb1 too" not in err
    assert OLD in opened["/dev/vda3"] and opened["/dev/vdb1"] == {OLD}


def test_a_removal_that_says_yes_but_leaves_the_password_counts_as_failed(monkeypatch, capsys):
    stand_in_disks(monkeypatch, lambda device: 0, removes=False)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == cli.DISK_NOT_TAKEN_BACK
    assert "(it still opens it)" in capsys.readouterr().err


def test_cryptsetup_running_out_of_time_says_which_passwords_may_work(monkeypatch, tmp_path):
    def timeout(args, key=None, new=None):
        if args[0] == "luksAddKey":
            raise subprocess.TimeoutExpired(["cryptsetup", "luksAddKey"], 300)
        return subprocess.CompletedProcess(args, 0, b"", b"")
    monkeypatch.setattr(cli, "cryptsetup", timeout)
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: 0 if passphrase == OLD else None)
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/sbin/cryptsetup")
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"devices": ["/dev/vda3"], "current": OLD, "new": NEW})))
    errors = __import__("io").StringIO()
    monkeypatch.setattr(sys, "stderr", errors)
    assert cli.disk_root(["change"]) == cli.DISK_PARTLY
    assert "did not finish in 300 s (luksAddKey)" in errors.getvalue() and "at least one of the two opens the disk" in errors.getvalue()


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


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0, reason="root writes to a read-only file")
def test_a_rollback_that_fails_on_a_real_disk_leaves_both_passwords_there_and_says_so(tmp_path, monkeypatch, capsys):
    """The second image refuses the new password, and taking it back out of the first fails: the first
    then opens with both, the second with the old one, and the message says exactly that."""
    monkeypatch.setenv("PATH", C_ENV["PATH"])
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    second.chmod(0o444)
    real = cli.cryptsetup
    monkeypatch.setattr(cli, "cryptsetup", lambda args, key=None, new=None: subprocess.CompletedProcess(args, 1, b"", b"Device is busy.") if args[0] == "luksRemoveKey" else real(args, key, new))
    assert cli.disk_change([str(first), str(second)], OLD, NEW, False, {str(first): 0, str(second): 0}) == cli.DISK_NOT_TAKEN_BACK
    err = capsys.readouterr().err
    assert f"may open {first} too" in err and "Device is busy" in err and "nothing was changed" not in err
    assert opens(first, OLD) and opens(first, NEW)
    assert opens(second, OLD) and not opens(second, NEW)


def fake_tools(folder: Path, disk: Path, *more: Path) -> dict:
    """sudo that runs the command (and asks once, like sudo -v), and lsblk and findmnt that show the images
    as the root's LUKS devices (one btrfs over all of them, mounted from the first)."""
    folder.mkdir()
    tree = {"blockdevices": [{"name": str(image), "path": str(image), "type": "loop", "fstype": "crypto_LUKS", "uuid": f"luks-{n}",
                              "children": [{"name": f"/dev/mapper/luks-{n}", "path": f"/dev/mapper/luks-{n}", "type": "crypt", "fstype": "btrfs", "uuid": "fs-t",
                                            "mountpoints": ["/sysroot"] if n == 0 else [None]}]} for n, image in enumerate((disk, *more))]}
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


def converse(argv: list[str], env: dict, answers: list[tuple[str, str | bytes]], timeout: float = 600) -> tuple[int, str]:
    """Run argv on a terminal of its own and answer each prompt as it comes: a str as a typed line, bytes
    as they are (b"\\x03" is Ctrl+C). `setsid -c` makes the terminal the command's own (getpass and sudo
    read /dev/tty), without forking the test process."""
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
                answer = pending.pop(0)[1]
                os.write(fd, answer if isinstance(answer, bytes) else f"{answer}\n".encode())
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


CHANGE = [("[sudo] password for tester:", "account-pass"), ("Current disk password:", OLD), ("New disk password:", NEW), ("New disk password again:", NEW)]


@needs_cryptsetup
@pytest.mark.parametrize("when", ["adding to the first device", "adding to the second device", "removing the old one"])
def test_ctrl_c_during_the_change_waits_for_it_to_finish(tmp_path, when):
    """Ctrl+C reaches the whole terminal's process group. The command waits for the root side, which
    finishes the change on every device; no traceback, and nothing left half-done."""
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    trigger = {"adding to the first device": f"Adding the new disk password to {first}…",
               "adding to the second device": f"Adding the new disk password to {second}…",
               "removing the old one": "Removing the old one…"}[when]
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*CHANGE, (trigger, b"\x03")])
    assert "Traceback" not in screen and "KeyboardInterrupt" not in screen
    assert "still changing" in screen and "Done" in screen, screen
    assert code == 0
    for disk in (first, second):
        assert opens(disk, NEW) and not opens(disk, OLD), disk


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0 or not shutil.which("sudo") or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0,
                    reason="needs sudo without a password, as someone other than root")
def test_ctrl_c_during_the_change_through_the_real_sudo(tmp_path):
    """As on the image: sudo runs the root side on a terminal of its own (use_pty) and passes Ctrl+C on."""
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    # Only sudo -v is answered here (it may want a password even where sudo -n runs commands); the root
    # side runs under the real sudo.
    real = shutil.which("sudo")
    (tmp_path / "bin" / "sudo").write_text(f'#!/bin/sh\n[ "$1" = -v ] && exit 0\nexec {real} "$@"\n')
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [
        ("Current disk password:", OLD), ("New disk password:", NEW), ("New disk password again:", NEW), (f"Adding the new disk password to {second}…", b"\x03")])
    assert code == 0 and "Traceback" not in screen and "Done" in screen, screen
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))


@needs_cryptsetup
def test_ctrl_c_and_more_during_the_change_still_wait(tmp_path):
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [
        *CHANGE, (f"Adding the new disk password to {first}…", b"\x03\x1c\x03"), (f"Adding the new disk password to {second}…", b"\x03")])
    assert code == 0 and "Traceback" not in screen and screen.count("still changing") == 1
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))


@needs_cryptsetup
@pytest.mark.parametrize("at", ["Current disk password:", "New disk password:", "New disk password again:"])
def test_ctrl_c_before_the_change_stops_and_changes_nothing(tmp_path, at):
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    answers = CHANGE[:[prompt for prompt, _ in CHANGE].index(at)]
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*answers, (at, b"\x03")])
    assert code == 130 and "stopped. Nothing was changed." in screen and "Traceback" not in screen
    assert opens(disk, OLD) and not opens(disk, NEW) and slots(disk) == ["0"]


def test_a_root_side_that_was_killed_is_looked_at_and_the_end_state_said(monkeypatch, capsys):
    state = {"/dev/vda3": {"current": True, "new": True}, "/dev/vdb1": {"current": True, "new": False}}
    argv = {"change": ["sh", "-c", "kill -9 $$"], "probe": [sys.executable, "-c", f"import sys; sys.stdin.read(); print({json.dumps(json.dumps(state))})"]}
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: argv[op])
    assert cli.disk_helper("change", {"devices": list(state), "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    err = capsys.readouterr().err
    assert "ended before it could say how (signal 9)" in err
    assert "/dev/vda3: the new disk password and the current one both open it" in err
    assert "/dev/vdb1: the current disk password opens it, the new one does not" in err


def test_when_even_looking_fails_it_says_what_is_sure(monkeypatch, capsys):
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", "kill -9 $$"] if op == "change" else ["false"])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    assert "at least one of the two opens each device" in capsys.readouterr().err


def test_the_end_state_in_words():
    assert cli.disk_end_lines({"/dev/a": {"current": False, "new": True}, "/dev/b": {"current": False, "new": False}, "bad": None}) == [
        "/dev/a: the new disk password opens it, the current one no longer does", "/dev/b: neither password opens it"]


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
    assert json.loads(status.stdout) == {"encrypted": False, "devices": [], "newOwner": False, "error": None}


@pytest.mark.parametrize("lsblk", [
    "echo 'lsblk: unknown column: MOUNTPOINTS' >&2; exit 1",
    "echo 'not json'",
    "echo '{\"blockdevices\": \"none\"}'",
], ids=["fails", "prints something else", "lists no devices"])
@pytest.mark.parametrize("flags", [["--disk"], ["--disk", "--new-owner"]])
def test_without_lsblk_it_refuses_rather_than_guess_from_crypttab(tmp_path, lsblk, flags):
    """/etc/crypttab names data and USB disks as well as the root's; --new-owner would remove their other keys."""
    folder = tmp_path / "bin"
    folder.mkdir()
    calls = tmp_path / "sudo-calls"
    (folder / "lsblk").write_text(f"#!/bin/sh\n{lsblk}\n")
    (folder / "findmnt").write_text("#!/bin/sh\necho fs\n")
    (folder / "sudo").write_text(f"#!/bin/sh\necho \"$*\" >>{calls}\nexit 0\n")
    for tool in ("lsblk", "findmnt", "sudo"):
        (folder / tool).chmod(0o755)
    env = {**os.environ, "PATH": f"{folder}:{os.environ['PATH']}"}
    result = subprocess.run([sys.executable, str(CLI), "password", *flags], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert result.returncode == cli.DISK_UNKNOWN
    assert "lsblk" in result.stderr and "Nothing was changed" in result.stderr and "another disk" in result.stderr
    assert not calls.exists(), "nothing ran as root"
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env)
    state = json.loads(status.stdout)
    assert status.returncode == 0 and state["encrypted"] is None and state["devices"] == [] and "lsblk" in state["error"]


def test_the_cli_never_reads_crypttab():
    assert "/etc/crypttab\")" not in CLI.read_text() and "crypttab_sources" not in CLI.read_text()


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
