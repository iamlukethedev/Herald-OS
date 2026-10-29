"""`herald-os password --disk`: finding the root's LUKS devices, and changing the passphrase on real
LUKS2 images (file-backed, and a loop device where root is at hand). The images are made with a cheap
key derivation; the passphrases the change adds use cryptsetup's own defaults, as on a real disk, so
each change takes several seconds."""

import contextlib
import importlib.machinery
import importlib.util
import json
import os
import pty
import select
import shutil
import signal
import subprocess
import sys
import termios
import threading
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

NO_SUDO_AS_ROOT_EARLY = pytest.mark.skipif(os.geteuid() == 0, reason="as root the root side runs without sudo, where the stand-in steps in")


@pytest.fixture(autouse=True)
def _keep_signal_handlers():
    """disk_root sets its own SIGINT and SIGQUIT handlers; put the originals back so other tests in the same run are not affected."""
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGQUIT)}
    yield
    for sig, handler in saved.items():
        signal.signal(sig, handler)


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
    assert "tell it to them" in cli.reset_disk_note(True) and "without encryption" not in cli.reset_disk_note(True)
    assert "could not tell" in cli.reset_disk_note(None) and "not a secure erase" in cli.reset_disk_note(None)
    partly = cli.reset_disk_note(True, [{"device": "/dev/vdb1", "kind": "journal"}])
    assert "tell it to them" in partly and "Part of it is written without encryption" in partly
    assert "the root filesystem's journal is on /dev/vdb1" in partly


def test_the_parts_without_encryption_in_words():
    assert cli.disk_plain_text([{"device": "/dev/vda3", "kind": "cipher_null"}, {"device": "/dev/vdb1", "kind": "log"},
                                {"device": "/dev/vdb2", "kind": "realtime"}, {"device": "/dev/vdb3", "kind": "journal"}]) == (
        "/dev/vda3 uses cipher_null, which encrypts nothing; the root filesystem's log is on /dev/vdb1; "
        "the root filesystem's realtime data is on /dev/vdb2; the root filesystem's journal is on /dev/vdb3")


@pytest.mark.parametrize("devices, protection, says", [
    (["/dev/vda3"], ("partial", [{"device": "/dev/vdb1", "kind": "journal"}]), ["tell it to them", "the root filesystem's journal is on /dev/vdb1"]),
    (["/dev/vda3"], ("full", []), ["tell it to them"]),
    ([], None, ["This disk is not encrypted"]),
], ids=["partly protected", "encrypted", "plain"])
def test_reset_tells_of_the_disk_as_status_does(monkeypatch, capsys, tmp_path, devices, protection, says):
    """reset decides as --status does: LUKS asks for the password (so setup asks the next owner for theirs),
    and the parts written without encryption are named."""
    helper = tmp_path / "reset-helper"
    helper.write_text("")
    monkeypatch.setattr(cli, "RESET_HELPER", helper)
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli, "disk_devices", lambda: devices)
    monkeypatch.setattr(cli, "disk_protection", lambda found: protection)
    monkeypatch.setattr("builtins.input", lambda prompt: "no")
    assert cli.reset([]) == 1
    said = capsys.readouterr().out
    assert all(words in said for words in says), said
    assert ("without encryption" in said) == (protection is not None and protection[0] == "partial")


def test_the_cli_refuses_wrong_disk_arguments():
    for wrong in (["--disk", "--now"], ["--disk", "--status", "--new-owner"], ["--disk", "--new-owner", "--new-owner"], ["extra"]):
        result = subprocess.run([sys.executable, str(CLI), "password", *wrong], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        assert result.returncode == 2, wrong
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk-root", "change"], input="not json", capture_output=True, text=True)
    assert result.returncode == 2 and "JSON" in result.stderr


def test_a_new_password_that_does_not_open_the_disk_is_taken_back(monkeypatch, capsys):
    """luksAddKey said yes, but the new password opens nothing: the old one must stay, the new one go."""
    calls = []
    monkeypatch.setattr(cli, "cryptsetup", lambda args, key=None, new=None: calls.append((args[0], key)) or subprocess.CompletedProcess(args, 0, b'{"keyslots": {"0": {}}, "tokens": {}}' if args[0] == "luksDump" else b"", b""))
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: 0 if passphrase == OLD else None)
    assert cli.disk_change(["/dev/vda3"], OLD, NEW, False, {"/dev/vda3": 0}) == 1
    # Nothing to take back from a device the new password does not open; the old one is never touched.
    # The key slot numbers are read first, to tell a slot the add wrote from one that was there.
    assert calls == [("luksDump", None), ("luksAddKey", OLD)]
    assert "does not open /dev/vda3" in capsys.readouterr().err


def stand_in_disks(monkeypatch, remove, removes=True):
    """cryptsetup and luks_slot for two devices: adding works on the first and fails on the second, so
    the new password is taken back from the first; `remove(device)` is what luksKillSlot does there
    (a returncode, or raises), and the new password opens the first (slot 1) until a removal works;
    with `removes` False, a removal that says yes leaves it there."""
    opened = {"/dev/vda3": {OLD}, "/dev/vdb1": {OLD}}

    def cryptsetup(args, key=None, new=None):
        device = args[-1]
        if args[0] == "luksAddKey":
            if device == "/dev/vdb1":
                return subprocess.CompletedProcess(args, 1, b"", b"Keyslot area too small.")
            opened[device].add(new)
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if args[0] == "luksKillSlot":
            device, slot = args[1], args[2]
            assert slot == "1" and key == OLD, "only the new password's slot goes, with the current password"
            code = remove(device)
            if code == 0 and removes:
                opened[device].discard(NEW)
            return subprocess.CompletedProcess(args, code, b"", b"Device /dev/vda3 is busy.")
        if args[0] == "luksDump":
            slots = sorted(slot_of[each] for each in opened[device])
            return subprocess.CompletedProcess(args, 0, json.dumps({"keyslots": {str(each): {} for each in slots}, "tokens": {}}).encode(), b"")
        return subprocess.CompletedProcess(args, 0, b"", b"")

    slot_of = {OLD: 0, NEW: 1}
    monkeypatch.setattr(cli, "cryptsetup", cryptsetup)
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: slot_of[passphrase] if passphrase in opened[device] else None)
    monkeypatch.setattr(cli, "luks_opened_slots", lambda device, passphrase: ([slot_of[passphrase]] if passphrase in opened[device] else [], {}))
    return opened


def test_a_rollback_that_works_says_nothing_was_changed(monkeypatch, capsys):
    opened = stand_in_disks(monkeypatch, lambda device: 0)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == 1
    assert opened == {"/dev/vda3": {OLD}, "/dev/vdb1": {OLD}}
    said = capsys.readouterr().err
    # The failed add's own words, not the generic "does not open ... after adding it".
    assert "the new disk password could not be added to /dev/vdb1: Keyslot area too small." in said
    assert "after adding it" not in said and "nothing was changed" in said


@pytest.mark.parametrize("remove", [
    lambda device: 1,
    lambda device: (_ for _ in ()).throw(subprocess.TimeoutExpired(["cryptsetup"], 300)),
], ids=["luksKillSlot fails", "luksKillSlot times out"])
def test_a_rollback_that_fails_says_the_new_password_may_still_open_that_device(monkeypatch, capsys, remove):
    opened = stand_in_disks(monkeypatch, remove)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == cli.DISK_NOT_TAKEN_BACK
    err = capsys.readouterr().err
    assert "nothing was changed" not in err
    assert "could not be taken back out of /dev/vda3" in err and "may open /dev/vda3 too" in err
    assert "sudo cryptsetup luksDump /dev/vda3" in err and "luksKillSlot" in err and "vdb1 too" not in err
    assert OLD in opened["/dev/vda3"] and opened["/dev/vdb1"] == {OLD}


def test_a_removal_that_says_yes_but_leaves_the_password_counts_as_failed(monkeypatch, capsys):
    stand_in_disks(monkeypatch, lambda device: 0, removes=False)
    assert cli.disk_change(["/dev/vda3", "/dev/vdb1"], OLD, NEW, False, {"/dev/vda3": 0, "/dev/vdb1": 0}) == cli.DISK_NOT_TAKEN_BACK
    assert "(it still opens it)" in capsys.readouterr().err


def test_cryptsetup_running_out_of_time_says_which_passwords_may_work(monkeypatch, tmp_path):
    def timeout(args, key=None, new=None):
        if args[0] == "luksAddKey":
            raise subprocess.TimeoutExpired(["cryptsetup", "luksAddKey"], 300)
        if args[0] == "luksDump":
            return subprocess.CompletedProcess(args, 0, b'{"keyslots": {"0": {}}, "tokens": {}}', b"")
        return subprocess.CompletedProcess(args, 0, b"", b"")
    monkeypatch.setattr(cli, "cryptsetup", timeout)
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: 0 if passphrase == OLD else None)
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/sbin/cryptsetup")
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps({"devices": ["/dev/vda3"], "current": OLD, "new": NEW})))
    errors = __import__("io").StringIO()
    monkeypatch.setattr(sys, "stderr", errors)
    assert cli.disk_root(["change"]) == cli.DISK_PARTLY
    said = errors.getvalue()
    assert "did not finish in 300 s (luksAddKey)" in said and "part-way on /dev/vda3" in said
    assert "the current one or the new one (or both) opens each" in said and "was added before" not in said


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


RECOVERY = "fjvh-ktbr-ueng-hbcd-kvlr-ngrc-rtjf-dbvu"


def with_token_slot(tmp_path: Path, disk: Path, secret: str, kind: str) -> Path:
    """Add `secret` in a slot of its own, with a token of `kind` that uses it, as systemd-cryptenroll does."""
    old, key = tmp_path / f"{disk.name}.old", tmp_path / f"{disk.name}.{kind}"
    old.write_text(OLD)
    key.write_text(secret)
    subprocess.run([CRYPTSETUP, "luksAddKey", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", str(old), str(disk), str(key)], env=C_ENV, check=True)
    slot = max(slots(disk), key=int)
    token = {"type": kind, "keyslots": [slot]}
    # Without the systemd token plugins, which would want a real TPM's fields in a systemd-tpm2 token.
    subprocess.run([CRYPTSETUP, "token", "import", "--disable-external-tokens", "--json-file", "-", str(disk)], input=json.dumps(token).encode(), env=C_ENV, check=True)
    return disk


def dump(disk: Path) -> bytes:
    return subprocess.run([CRYPTSETUP, "luksDump", "--dump-json-metadata", str(disk)], capture_output=True, check=True, env=C_ENV).stdout


def test_token_types_are_said_in_plain_words():
    assert cli.token_words(["systemd-recovery"]) == "the recovery key"
    assert cli.token_words(["systemd-tpm2"]) == "the TPM"
    assert cli.token_words(["systemd-fido2"]) == "a security key (FIDO2)"
    assert cli.token_words(["systemd-tpm2", "systemd-tpm2"]) == "the TPM"
    assert cli.token_words(["herald-test"]) == "a herald-test token"
    for kinds in (["systemd-recovery"], ["systemd-tpm2"], ["systemd-fido2"], ["systemd-pkcs11"]):
        message, _ = cli.disk_not_the_password("/dev/vda3", 1, kinds)
        assert "systemd-" not in message, message


def test_a_slot_a_token_uses_is_named_by_its_token():
    metadata = {"keyslots": {"0": {}, "1": {}, "2": {}}, "tokens": {"0": {"type": "systemd-recovery", "keyslots": ["1"]}, "1": {"type": "systemd-tpm2", "keyslots": ["2"]}, "2": {"type": "x", "keyslots": [2]}}}
    assert cli.luks_slot_tokens(metadata, 0) == []
    assert cli.luks_slot_tokens(metadata, 1) == ["systemd-recovery"]
    assert cli.luks_slot_tokens(metadata, 2) == ["systemd-tpm2", "x"]
    assert cli.luks_slot_tokens({}, 0) == []
    for kinds, said, code in [
        (["systemd-recovery"], "that is the recovery key, not the disk password", cli.DISK_RECOVERY_KEY),
        (["systemd-recovery", "systemd-tpm2"], "that is the recovery key", cli.DISK_RECOVERY_KEY),
        (["systemd-tpm2"], "key slot 2 of /dev/vda3, which TPM unlocking uses", cli.DISK_TPM_SLOT),
        (["systemd-fido2"], "which security key (FIDO2) unlocking uses", cli.DISK_FIDO2_SLOT),
        (["clevis"], "which Clevis (a TPM or a network key server) uses to unlock it", cli.DISK_OTHER_SLOT),
        (["systemd-pkcs11", "x"], "which a smart card (PKCS#11) and a x token uses to unlock it", cli.DISK_OTHER_SLOT),
    ]:
        message, exit_code = cli.disk_not_the_password("/dev/vda3", 2, kinds)
        assert said in message and "Nothing was changed" in message and exit_code == code, kinds
    assert len({cli.DISK_RECOVERY_KEY, cli.DISK_TPM_SLOT, cli.DISK_FIDO2_SLOT, cli.DISK_OTHER_SLOT}) == 4


@needs_cryptsetup
@pytest.mark.parametrize("new_owner", [False, True])
def test_the_recovery_key_typed_as_the_current_password_is_refused(tmp_path, new_owner):
    """Taken as the disk password, the recovery key's slot would go in its place: the owner's password
    would still open the disk and the recovery token would point at nothing."""
    first = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), RECOVERY, "systemd-recovery")
    second = with_token_slot(tmp_path, make_image(tmp_path / "b.img", OLD), RECOVERY, "systemd-recovery")
    before = {disk: dump(disk) for disk in (first, second)}
    for op in ("check", "change"):
        result = root_side(op, {"devices": [str(first), str(second)], "current": RECOVERY, "new": NEW, "newOwner": new_owner})
        assert result.returncode == cli.DISK_RECOVERY_KEY, result.stderr
        assert "that is the recovery key, not the disk password" in result.stderr and "Nothing was changed" in result.stderr
        assert "Done" not in result.stdout
    assert {disk: dump(disk) for disk in (first, second)} == before
    assert all(opens(disk, OLD) and opens(disk, RECOVERY) and not opens(disk, NEW) for disk in (first, second))
    # The owner's own password still changes it, and leaves the recovery key and its token as they were.
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == 0, result.stderr
    for disk in (first, second):
        assert opens(disk, NEW) and opens(disk, RECOVERY) and not opens(disk, OLD)
        tokens = json.loads(dump(disk))["tokens"]
        assert [token["type"] for token in tokens.values()] == ["systemd-recovery"] and all(token["keyslots"] for token in tokens.values())


@needs_cryptsetup
def test_a_tpm_slots_secret_is_refused_too(tmp_path):
    disk = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), "a secret the tpm keeps", "systemd-tpm2")
    before = dump(disk)
    result = root_side("change", {"devices": [str(disk)], "current": "a secret the tpm keeps", "new": NEW})
    assert result.returncode == cli.DISK_TPM_SLOT and "which TPM unlocking uses" in result.stderr
    assert dump(disk) == before


@needs_cryptsetup
@pytest.mark.parametrize("kind, code", [("systemd-fido2", 11), ("clevis", 12)])
def test_a_fido2_or_other_token_slot_is_refused_with_its_own_code(tmp_path, kind, code):
    disk = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), "a secret a token keeps", kind)
    before = dump(disk)
    result = root_side("check", {"devices": [str(disk)], "current": "a secret a token keeps"})
    assert result.returncode == code and "that is not the disk password" in result.stderr
    assert dump(disk) == before


@needs_cryptsetup
def test_the_command_stops_at_the_recovery_key_before_asking_for_a_new_password(tmp_path):
    disk = with_token_slot(tmp_path, make_image(tmp_path / "disk.img", OLD), RECOVERY, "systemd-recovery")
    env = fake_tools(tmp_path / "bin", disk)
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*CHANGE[:1], ("Current disk password:", RECOVERY)])
    assert code == cli.DISK_RECOVERY_KEY and "recovery key, not the disk password" in screen
    assert "New disk password" not in screen and "Traceback" not in screen
    assert opens(disk, OLD) and opens(disk, RECOVERY)


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
    monkeypatch.setattr(cli, "cryptsetup", lambda args, key=None, new=None: subprocess.CompletedProcess(args, 1, b"", b"Device is busy.") if args[0] == "luksKillSlot" else real(args, key, new))
    assert cli.disk_change([str(first), str(second)], OLD, NEW, False, {str(first): 0, str(second): 0}) == cli.DISK_NOT_TAKEN_BACK
    err = capsys.readouterr().err
    assert f"may open {first} too" in err and "Device is busy" in err and "nothing was changed" not in err
    assert opens(first, OLD) and opens(first, NEW)
    assert opens(second, OLD) and not opens(second, NEW)


@needs_cryptsetup
def test_a_real_cryptsetup_interrupted_in_every_check_after_the_add_never_gives_an_answer(tmp_path):
    """Once the add has run, each --test-passphrase is sent SIGINT straight away (as Ctrl+C reached it
    before the change ran cryptsetup in a session of its own): real cryptsetup then exits 1, even after
    "Key slot N unlocked". The change stops (exit 6) and says both may open; never "Done" or "nothing was
    changed", and both passwords still open the disk."""
    disk = make_image(tmp_path / "disk.img", OLD)
    folder, added = tmp_path / "bin", tmp_path / "added"
    folder.mkdir()
    (folder / "cryptsetup").write_text(
        "#!/bin/sh\n"
        f'[ "$1" = luksAddKey ] && touch {added}\n'
        # A background job gets /dev/null for stdin, so the password goes in through fd 9.
        f'if [ "$1" = open ] && [ -e {added} ]; then exec 9<&0; {CRYPTSETUP} "$@" <&9 9<&- & pid=$!; exec 9<&-; sleep 0.3; kill -INT "$pid" 2>/dev/null; wait "$pid"; exit $?; fi\n'
        f'exec {CRYPTSETUP} "$@"\n')
    (folder / "cryptsetup").chmod(0o755)
    env = {**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"}
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk-root", "change"], input=json.dumps({"devices": [str(disk)], "current": OLD, "new": NEW}),
                            capture_output=True, text=True, env=env, timeout=600)
    assert result.returncode == cli.DISK_PARTLY, result.stderr
    assert "could not tell whether a password opens" in result.stderr
    for wrong in ("Done", "no longer opens", "nothing was changed", "after adding it"):
        assert wrong not in result.stdout + result.stderr, wrong
    assert opens(disk, OLD) and opens(disk, NEW)


@needs_cryptsetup
@NO_SUDO_AS_ROOT_EARLY
@pytest.mark.parametrize("sudo", ["stand-in", "real"])
def test_ctrl_c_typed_all_through_the_change_never_reaches_cryptsetup(tmp_path, sudo):
    """Ctrl+C typed every 0.2 s from the start of the change to its end, through the terminal. The root
    side ignores it, and cryptsetup, in a session of its own, never gets it: the change finishes on both
    devices. With the real sudo, its own terminal (use_pty) passes Ctrl+C on to the root side's group."""
    if sudo == "real" and (not shutil.which("sudo") or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0):
        pytest.skip("needs sudo without a password, as someone other than root")
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    answers = list(CHANGE)
    if sudo == "real":
        real = shutil.which("sudo")
        (tmp_path / "bin" / "sudo").write_text(f'#!/bin/sh\n[ "$1" = -v ] && exit 0\nexec {real} "$@"\n')
        answers = answers[1:]
    # From the root side's first "Adding … to" on: the change has begun, and Ctrl+C before it stops with nothing changed.
    # Two adds, their checks and the removals take seconds: Ctrl+C every 0.2 s comes many times over.
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, answers,
                            burst_after=f"Adding the new disk password to {first}", min_sent=10)
    # With NOFLSH on the terminal, the last line stays on the screen however often Ctrl+C comes.
    assert code == 0 and "Traceback" not in screen, screen
    assert cli.DISK_CHANGE_DONE in screen, screen
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))


@needs_cryptsetup
@NO_SUDO_AS_ROOT_EARLY
@pytest.mark.parametrize("sudo", ["stand-in", "real"])
def test_ctrl_backslash_typed_all_through_the_change_never_reaches_cryptsetup(tmp_path, sudo):
    """As with Ctrl+C: Ctrl+\\ (SIGQUIT) typed every 0.2 s through the change neither stops either side
    nor reaches cryptsetup; the change finishes on both devices, with no core dump ("Quit")."""
    if sudo == "real" and (not shutil.which("sudo") or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0):
        pytest.skip("needs sudo without a password, as someone other than root")
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    answers = list(CHANGE)
    if sudo == "real":
        real = shutil.which("sudo")
        (tmp_path / "bin" / "sudo").write_text(f'#!/bin/sh\n[ "$1" = -v ] && exit 0\nexec {real} "$@"\n')
        answers = answers[1:]
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, answers,
                            burst_after=f"Adding the new disk password to {first}", burst=b"\x1c", min_sent=10)
    assert code == 0 and "Traceback" not in screen and "Quit" not in screen, screen
    assert cli.DISK_CHANGE_DONE in screen, screen
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))


@needs_cryptsetup
@NO_SUDO_AS_ROOT_EARLY
@pytest.mark.parametrize("burst", [False, True], ids=["once", "every 0.2 s"])
@pytest.mark.parametrize("sudo", ["stand-in", "real"])
def test_ctrl_c_at_the_start_of_the_change_stops_cleanly_or_finishes(tmp_path, sudo, burst):
    """Ctrl+C the moment the command says the change is starting, while sudo and the root side's Python
    start: either a stop with nothing changed (130) or a change that finishes (0). Never a traceback, a
    "Fatal Python error", or a change that "ended before it could say how"."""
    if sudo == "real" and (not shutil.which("sudo") or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0):
        pytest.skip("needs sudo without a password, as someone other than root")
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    env = fake_tools(tmp_path / "bin", first, second)
    answers = list(CHANGE)
    if sudo == "real":
        real = shutil.which("sudo")
        (tmp_path / "bin" / "sudo").write_text(f'#!/bin/sh\n[ "$1" = -v ] && exit 0\nexec {real} "$@"\n')
        answers = answers[1:]
    banner = "Keep the computer on until it is done."
    if burst:
        # A stop ends at least DISK_SETTLE (0.25 s) after the first Ctrl+C, by when the second has come.
        code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, answers, burst_after=banner, min_sent=2)
    else:
        code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*answers, (banner, b"\x03")])
    for wrong in ("Traceback", "Fatal Python error", "KeyboardInterrupt", "ended before it could say how"):
        assert wrong not in screen, (wrong, screen)
    assert code in (0, 130), screen
    if code == 130:
        assert screen.count("stopped. Nothing was changed.") == 1, screen
        assert all(opens(disk, OLD) and not opens(disk, NEW) for disk in (first, second))
    else:
        assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))


KEPT_DRIVER = """
import importlib.machinery, importlib.util, signal, sys, termios, time
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
cli.SSH_OWN_PROCESS = True
presses = []
signal.signal(signal.SIGINT, lambda signum, frame: presses.append(signum))
before = termios.tcgetattr(0)
with cli.disk_terminal_kept():
    kept = termios.tcgetattr(0)[3] & termios.NOFLSH
    print("ready", flush=True)
    deadline = time.monotonic() + 120
    while len(presses) < 5 and time.monotonic() < deadline:
        time.sleep(0.01)
    sys.stderr.write("the last line\\n")
    sys.stderr.flush()
sys.exit(0 if kept and termios.tcgetattr(0) == before else 5)
"""


def test_the_last_line_is_not_lost_to_a_flood_of_ctrl_c():
    """Each Ctrl+C makes the tty throw away output the terminal has not taken yet, unless NOFLSH is set:
    typed as fast as the terminal echoes them, they dropped the last line about one time in four. The
    settings from before come back afterwards."""
    if not shutil.which("setsid"):
        pytest.skip("needs setsid (util-linux)")
    for attempt in range(12):
        fd, child_end = pty.openpty()
        process = subprocess.Popen(["setsid", "-c", sys.executable, "-c", KEPT_DRIVER, str(CLI)],
                                   stdin=child_end, stdout=child_end, stderr=child_end, close_fds=True)
        os.close(child_end)
        screen, flooding, deadline = b"", False, time.monotonic() + 150
        while time.monotonic() < deadline:
            if flooding:
                with contextlib.suppress(OSError):
                    os.write(fd, b"\x03")
            if not select.select([fd], [], [], 0.02 if flooding else 1)[0]:
                continue
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            screen += data
            flooding = flooding or b"ready" in screen
        code = process.wait(timeout=150)
        os.close(fd)
        assert b"the last line" in screen, (attempt, screen[-300:])
        assert code == 0, "NOFLSH was not set, or the settings from before did not come back"


def test_the_terminal_is_left_alone_from_the_background():
    """Outside the terminal's foreground process group a change of its settings would stop the command
    (SIGTTOU), so there it does not touch them."""
    if not shutil.which("setsid"):
        pytest.skip("needs setsid (util-linux)")
    driver = KEPT_DRIVER.split("cli.SSH_OWN_PROCESS")[0] + (
        "import os\n"
        "child = os.fork()\n"
        "if child == 0:\n"
        "    os.setpgid(0, 0)\n"
        "    with cli.disk_terminal_kept():\n"
        "        pass\n"
        "    os._exit(0)\n"
        "sys.exit(os.waitstatus_to_exitcode(os.waitpid(child, 0)[1]))\n")
    fd, child_end = pty.openpty()
    process = subprocess.Popen(["setsid", "-c", sys.executable, "-c", driver, str(CLI)], stdin=child_end, stdout=child_end, stderr=child_end, close_fds=True)
    os.close(child_end)
    try:
        assert process.wait(timeout=120) == 0
    finally:
        process.kill()
        os.close(fd)


BACKGROUND_SHELL = """
import os, signal, sys, time
# A shell on the terminal: the job gets the terminal, is stopped (Ctrl+Z or kill -STOP), and goes on in
# the background (bg) while the shell keeps the terminal.
cli_path, folder, moved = sys.argv[1], sys.argv[2], sys.argv[3]
job = (
    "import importlib.machinery, importlib.util, os, sys, termios, time\\n"
    "loader = importlib.machinery.SourceFileLoader('cli', sys.argv[1])\\n"
    "cli = importlib.util.module_from_spec(importlib.util.spec_from_loader('cli', loader))\\n"
    "loader.exec_module(cli)\\n"
    # Moved to the background just after its last look at the foreground: that look said it was there.
    "if sys.argv[3] == 'late':\\n"
    "    cli.disk_foreground = lambda fd: True\\n"
    "deadline = time.monotonic() + 120\\n"
    "while not os.path.exists(sys.argv[2] + '/given') and time.monotonic() < deadline:\\n"
    "    time.sleep(0.02)\\n"
    "with cli.disk_terminal_kept():\\n"
    "    if termios.tcgetattr(0)[3] & termios.NOFLSH:\\n"
    "        open(sys.argv[2] + '/kept', 'w').close()\\n"
    "    open(sys.argv[2] + '/ready', 'w').close()\\n"
    "    deadline = time.monotonic() + 120\\n"
    "    while not os.path.exists(sys.argv[2] + '/go') and time.monotonic() < deadline:\\n"
    "        time.sleep(0.02)\\n"
)
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
child = os.fork()
if child == 0:
    os.setpgid(0, 0)
    signal.signal(signal.SIGTTOU, signal.SIG_DFL)
    os.execv(sys.executable, [sys.executable, "-c", job, cli_path, folder, moved])
# As a shell does, both set the job's group: the child may have run exec already (EACCES), with its own set.
try:
    os.setpgid(child, child)
except PermissionError:
    pass
os.tcsetpgrp(0, child)
open(folder + "/given", "w").close()
deadline = time.monotonic() + 120
while not os.path.exists(folder + "/ready") and time.monotonic() < deadline:
    time.sleep(0.02)
os.kill(child, signal.SIGSTOP)
os.waitpid(child, os.WUNTRACED)
os.tcsetpgrp(0, os.getpgrp())
os.kill(child, signal.SIGCONT)
open(folder + "/go", "w").close()
while time.monotonic() < deadline:
    pid, status = os.waitpid(child, os.WUNTRACED | os.WNOHANG)
    if pid and os.WIFSTOPPED(status):
        print("stopped by signal", os.WSTOPSIG(status), flush=True)
        os.kill(child, signal.SIGKILL)
        sys.exit(3)
    if pid:
        # It must have run in the foreground at first (NOFLSH set), or this tested nothing.
        sys.exit(os.waitstatus_to_exitcode(status) or (0 if os.path.exists(folder + "/kept") else 5))
    time.sleep(0.02)
sys.exit(4)
"""


@pytest.mark.parametrize("moved", ["seen", "late"], ids=["seen in the background", "moved just after its look"])
def test_a_change_sent_to_the_background_finishes_without_stopping_on_the_terminal(tmp_path, moved):
    """Stopped while it changes the disk, then continued in the background (bg): on the way out it
    leaves the terminal's settings, which it may no longer change, instead of stopping for good with
    "Stopped (tty output)" (SIGTTOU). Moved there just after it looked, it puts them back with SIGTTOU
    ignored, which lets that through rather than stopping it."""
    if not shutil.which("setsid"):
        pytest.skip("needs setsid (util-linux)")
    fd, child_end = pty.openpty()
    process = subprocess.Popen(["setsid", "-c", sys.executable, "-c", BACKGROUND_SHELL, str(CLI), str(tmp_path), moved],
                               stdin=child_end, stdout=child_end, stderr=child_end, close_fds=True)
    os.close(child_end)
    screen = b""
    try:
        while select.select([fd], [], [], 150)[0]:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            screen += data
        assert process.wait(timeout=150) == 0, screen
    finally:
        process.kill()
        os.close(fd)


def test_the_terminal_s_settings_are_left_when_it_is_no_longer_in_the_foreground(monkeypatch):
    """In the foreground at the start (NOFLSH goes on), in the background by the end: the settings from
    before are not put back, as that would stop the command."""
    fd, child_end = pty.openpty()
    monkeypatch.setattr(cli, "DISK_TTY", os.ttyname(child_end))
    monkeypatch.setattr(cli, "DISK_SETTLE", 0)
    answers = iter([True])
    monkeypatch.setattr(cli, "disk_foreground", lambda descriptor: next(answers, False))
    calls = []
    real = cli.termios.tcsetattr
    monkeypatch.setattr(cli.termios, "tcsetattr", lambda descriptor, when, attributes: calls.append(when) or real(descriptor, when, attributes))
    try:
        with cli.disk_terminal_kept():
            pass
    finally:
        os.close(fd)
        os.close(child_end)
    assert calls == [termios.TCSANOW]


def test_a_terminal_whose_foreground_cannot_be_told_is_left_alone(monkeypatch):
    """tcgetpgrp fails on a terminal that is not this process's controlling one (or was closed): taken
    as not in the foreground, so its settings are not touched, and nothing is raised."""
    fd, child_end = pty.openpty()
    monkeypatch.setattr(cli, "DISK_TTY", os.ttyname(child_end))
    calls = []
    monkeypatch.setattr(cli.termios, "tcsetattr", lambda *args: calls.append(args))
    ran = []
    try:
        with cli.disk_terminal_kept():
            ran.append(True)
    finally:
        os.close(fd)
        os.close(child_end)
    assert ran and not calls
    with pytest.raises(OSError):
        os.tcgetpgrp(-1)
    assert cli.disk_foreground(-1) is False


def add_key(tmp_path: Path, disk: Path, secret: str) -> None:
    old, key = tmp_path / f"{disk.name}.current", tmp_path / f"{disk.name}.added"
    old.write_text(OLD)
    key.write_text(secret)
    subprocess.run([CRYPTSETUP, "luksAddKey", "--pbkdf", "pbkdf2", "--pbkdf-force-iterations", "1000", "--key-file", str(old), str(disk), str(key)], env=C_ENV, check=True)


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0, reason="root writes to a read-only file")
def test_a_take_back_also_removes_the_new_password_an_earlier_run_left(tmp_path):
    """An earlier run left the new password on the first device. This one fails on the second, and the
    take back removes it from the first as well: the current password alone opens both again."""
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    add_key(tmp_path, first, NEW)
    second.chmod(0o444)
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == 1, result.stderr
    assert f"was also on {first} from an earlier run; it was taken out of it too" in result.stderr
    assert "the current disk password alone opens the disk again" in result.stderr and "nothing was changed" not in result.stderr
    assert opens(first, OLD) and not opens(first, NEW) and slots(first) == ["0"]
    assert opens(second, OLD) and not opens(second, NEW)


@needs_cryptsetup
@pytest.mark.parametrize("copies, new_owner", [(1, False), (2, False), (2, True)])
def test_a_run_over_a_leftover_new_password_finishes(tmp_path, copies, new_owner):
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    for _ in range(copies):
        add_key(tmp_path, first, NEW)
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW, "newOwner": new_owner})
    assert result.returncode == 0, result.stderr
    assert all(opens(disk, NEW) and not opens(disk, OLD) for disk in (first, second))
    # A plain change leaves the new password's copies; --new-owner keeps one slot only.
    assert len(slots(first)) == (1 if new_owner else copies) and len(slots(second)) == 1


@needs_cryptsetup
def test_a_new_password_that_already_opens_a_token_s_slot_is_refused_before_anything_changes(tmp_path):
    """Otherwise a take back would remove the recovery key's slot as a leftover."""
    first = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), RECOVERY, "systemd-recovery")
    second = make_image(tmp_path / "b.img", OLD)
    before = {disk: dump(disk) for disk in (first, second)}
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": RECOVERY})
    assert result.returncode == cli.DISK_NEW_IS_OTHER_KEY and f"already opens {first}, through key slot 1, which the recovery key uses to unlock it" in result.stderr
    assert {disk: dump(disk) for disk in (first, second)} == before


@needs_cryptsetup
def test_a_new_password_in_a_plain_slot_and_a_token_s_slot_is_refused_and_both_stay(tmp_path):
    """The same secret in plain slot 1 and in the recovery token's slot 2: taking it back would remove
    both and leave the token with no slot, so it is refused before anything changes."""
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    add_key(tmp_path, first, NEW)
    with_token_slot(tmp_path, first, NEW, "systemd-recovery")
    assert slots(first) == ["0", "1", "2"]
    before = {disk: dump(disk) for disk in (first, second)}
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == cli.DISK_NEW_IS_OTHER_KEY and "key slot 2, which the recovery key uses to unlock it" in result.stderr
    assert {disk: dump(disk) for disk in (first, second)} == before
    assert json.loads(dump(first))["tokens"]["0"]["keyslots"] == ["2"]


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0, reason="root writes to a read-only file")
@pytest.mark.parametrize("copies", [2, 3])
def test_two_plain_leftover_slots_of_the_new_password_both_go(tmp_path, copies):
    """The new password in two or three plain slots of one device: a take back removes every one."""
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    for _ in range(copies):
        add_key(tmp_path, first, NEW)
    assert slots(first) == [str(n) for n in range(copies + 1)]
    second.chmod(0o444)
    result = root_side("change", {"devices": [str(first), str(second)], "current": OLD, "new": NEW})
    assert result.returncode == 1, result.stderr
    assert slots(first) == ["0"] and opens(first, OLD) and not opens(first, NEW)


@needs_cryptsetup
@pytest.mark.parametrize("kind, words", [("systemd-recovery", "the recovery key"), ("systemd-tpm2", "the TPM"),
                                         ("systemd-fido2", "a security key (FIDO2)"), ("clevis", "Clevis")])
@pytest.mark.parametrize("op, new_owner", [("check", False), ("change", False), ("change", True)])
def test_the_old_password_also_in_a_token_s_slot_is_refused_and_both_stay(tmp_path, kind, words, op, new_owner):
    """The current password in plain slot 0 and in a token's slot 1: it is the disk password, so not
    9 to 12 ("that is not the disk password"), but 14, whatever the token, and nothing changes."""
    first = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), OLD, kind)
    before = dump(first)
    result = root_side(op, {"devices": [str(first)], "current": OLD, "new": NEW, "newOwner": new_owner})
    assert result.returncode == cli.DISK_SHARED_SECRET == 14, result.stderr
    assert f"the disk password also opens key slot 1 of {first}, which {words}" in result.stderr
    assert "Give that way of unlocking a secret of its own first. Nothing was changed." in result.stderr
    assert "not the disk password" not in result.stderr
    assert dump(first) == before


@needs_cryptsetup
@pytest.mark.parametrize("kind, code", [("systemd-recovery", 9), ("systemd-tpm2", 10)])
def test_a_token_s_secret_alone_still_says_it_is_not_the_disk_password(tmp_path, kind, code):
    """9 and 10 keep their meaning: what was typed opens only the token's slot."""
    first = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), RECOVERY, kind)
    result = root_side("check", {"devices": [str(first)], "current": RECOVERY})
    assert result.returncode == code and "not the disk password" in result.stderr and "also opens" not in result.stderr


@needs_cryptsetup
@pytest.mark.skipif(os.geteuid() == 0, reason="root writes to a read-only file")
def test_a_take_back_never_removes_a_slot_a_token_came_to_use(tmp_path, monkeypatch, capsys):
    """While the change runs, a token comes to use the slot the new password went into on the first
    device; then adding to the second fails. The take back leaves that slot and the token, and says so."""
    monkeypatch.setenv("PATH", C_ENV["PATH"])
    first, second = make_image(tmp_path / "a.img", OLD), make_image(tmp_path / "b.img", OLD)
    second.chmod(0o444)
    real = cli.cryptsetup

    def cryptsetup(args, key=None, new=None):
        if args[0] == "luksAddKey" and args[-1] == str(second):
            token = {"type": "systemd-recovery", "keyslots": [max(slots(first), key=int)]}
            subprocess.run([CRYPTSETUP, "token", "import", "--disable-external-tokens", "--json-file", "-", str(first)], input=json.dumps(token).encode(), env=C_ENV, check=True)
        return real(args, key, new)

    monkeypatch.setattr(cli, "cryptsetup", cryptsetup)
    assert cli.disk_change([str(first), str(second)], OLD, NEW, False, {str(first): 0, str(second): 0}) == cli.DISK_NOT_TAKEN_BACK
    assert "is one the recovery key uses to unlock it" in capsys.readouterr().err
    assert slots(first) == ["0", "1"] and json.loads(dump(first))["tokens"]["0"]["keyslots"] == ["1"]


@needs_cryptsetup
def test_a_real_cryptsetup_interrupted_while_adding_still_finishes_the_change(tmp_path):
    """cryptsetup 2.7, reached by SIGINT during luksAddKey, writes the key slot and then exits 1 without
    a word. The change sees the new password opens the device and finishes."""
    disk = make_image(tmp_path / "disk.img", OLD)
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "cryptsetup").write_text(
        "#!/bin/sh\n"
        # A background job gets /dev/null for stdin, so the current password goes in through fd 9 (the
        # new one comes as /dev/fd/3 or so, which must stay as it is).
        f'if [ "$1" = luksAddKey ]; then exec 9<&0; {CRYPTSETUP} "$@" <&9 9<&- & pid=$!; exec 9<&-; sleep 0.5; kill -INT "$pid"; wait "$pid"; exit $?; fi\n'
        f'exec {CRYPTSETUP} "$@"\n')
    (folder / "cryptsetup").chmod(0o755)
    env = {**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"}
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk-root", "change"], input=json.dumps({"devices": [str(disk)], "current": OLD, "new": NEW}),
                            capture_output=True, text=True, env=env, timeout=600)
    assert result.returncode == 0, result.stderr
    assert opens(disk, NEW) and not opens(disk, OLD)
    if "going on" not in result.stderr:
        pytest.skip("this cryptsetup finished luksAddKey before the interrupt reached it")


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


def converse(argv: list[str], env: dict, answers: list[tuple[str, str | bytes]], timeout: float = 600,
             burst_after: str | None = None, burst: bytes = b"\x03", every: float = 0.2, min_sent: int = 1) -> tuple[int, str]:
    """Run argv on a terminal of its own and answer each prompt as it comes: a str as a typed line, bytes
    as they are (b"\\x03" is Ctrl+C). `setsid -c` makes the terminal the command's own (getpass and sudo
    read /dev/tty), without forking the test process. With burst_after, at least `min_sent` bursts must
    have been typed."""
    if not shutil.which("setsid"):
        pytest.skip("needs setsid (util-linux)")
    fd, child_end = pty.openpty()
    process = subprocess.Popen(["setsid", "-c", *argv], stdin=child_end, stdout=child_end, stderr=child_end, env=env, close_fds=True)
    os.close(child_end)
    # As root the command asks sudo nothing, so there is no sudo prompt to wait for.
    pending = [answer for answer in answers if not (os.geteuid() == 0 and answer[0].startswith("[sudo]"))]
    screen, deadline = "", time.monotonic() + timeout
    bursting, sent, next_burst = False, 0, 0.0
    while time.monotonic() < deadline:
        # With burst_after, `burst` is typed every `every` seconds from when that text shows until the end,
        # on a clock: each one's echo is output too, which must not make the next come sooner.
        if bursting and time.monotonic() >= next_burst:
            with contextlib.suppress(OSError):
                os.write(fd, burst)
                sent += 1
            next_burst = time.monotonic() + every
        ready, _, _ = select.select([fd], [], [], max(0.0, next_burst - time.monotonic()) if bursting else 1)
        if ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            screen += data.decode(errors="replace")
            if burst_after and burst_after in screen:
                bursting = True
            if pending and screen.rstrip().endswith(pending[0][0]):
                answer = pending.pop(0)[1]
                os.write(fd, answer if isinstance(answer, bytes) else f"{answer}\n".encode())
    code = process.wait(timeout=max(1.0, deadline - time.monotonic()))
    # Whatever is still on its way after the exit, up to the end of the terminal's output (EOF or EIO
    # once nothing holds the terminal), however long a loaded machine takes to pass it on.
    while select.select([fd], [], [], 60)[0]:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        screen += data.decode(errors="replace")
    os.close(fd)
    if burst_after:
        assert sent >= min_sent, (f"only {sent} bursts were typed, not {min_sent}", code, screen[-2000:])
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
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [("[sudo] password for tester:", "account-pass"), ("Current disk password:", "wrong one!")])
    assert code == cli.DISK_WRONG and "not the disk password" in screen
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [("[sudo] password for tester:", "account-pass"), ("Current disk password:", OLD), ("New disk password:", NEW), ("again:", NEW + "x")])
    assert code == 2 and "not the same" in screen
    if os.geteuid() != 0:
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


@needs_cryptsetup
@pytest.mark.parametrize("at", ["Current disk password:", "New disk password:", "New disk password again:"])
@pytest.mark.parametrize("language", ["C.UTF-8", "C"])
def test_a_byte_that_is_not_text_is_refused_like_anything_outside_ascii(tmp_path, at, language):
    """getpass cannot decode it; that is the ASCII refusal, not a traceback, at every prompt."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = {**fake_tools(tmp_path / "bin", disk), "LC_ALL": language, "LANG": language}
    answers = CHANGE[:[prompt for prompt, _ in CHANGE].index(at)]
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*answers, (at, b"New-pass\xff2\n")])
    assert code == 2, screen
    assert "Traceback" not in screen and "UnicodeDecodeError" not in screen
    assert "use only letters, digits, spaces and the symbols on the keyboard (ASCII)" in screen and "Nothing was changed." in screen
    assert opens(disk, OLD) and slots(disk) == ["0"]


@needs_cryptsetup
def test_ctrl_c_during_the_current_password_check_says_so_once(tmp_path):
    """Ctrl+C reaches both sides while the root side checks the current password: one message."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    # A cryptsetup that takes its time over the check, and says when it starts.
    (tmp_path / "bin" / "cryptsetup").write_text(f'#!/bin/sh\n[ "$1" = open ] && {{ echo SLOW-CHECK >/dev/tty; sleep 3; }}\nexec {CRYPTSETUP} "$@"\n')
    (tmp_path / "bin" / "cryptsetup").chmod(0o755)
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*CHANGE[:2], ("SLOW-CHECK", b"\x03")])
    assert code == 130 and "Traceback" not in screen
    assert screen.count("Nothing was changed.") == 1, screen
    assert opens(disk, OLD) and slots(disk) == ["0"]


def slow_root_side(tmp_path: Path, disk: Path, op: str, stop_root_after: float | None = None) -> dict:
    """fake_tools, with the root side's `op` (check, or change before it begins) taking its time: its
    cryptsetup says SLOW-CHECK on the terminal and waits. With stop_root_after, the sudo stand-in sends
    SIGINT to the root side alone once its slow check has begun (and that long after), as if only it
    were stopped: on that event rather than a fixed time, which a loaded machine could outrun."""
    env = fake_tools(tmp_path / "bin", disk)
    begun = tmp_path / "check-begun"
    killer = (f'( while [ ! -e {begun} ]; do sleep 0.05; done; sleep {stop_root_after}; pkill -INT -f -- "--disk-root {op}" ) & '
              if stop_root_after else "")
    (tmp_path / "bin" / "sudo").write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $1 == -v ]]; then printf '%s' \"${3/\\%p/$USER}\" >/dev/tty; IFS= read -rs answer </dev/tty; echo >/dev/tty; [[ $answer == account-pass ]]; exit; fi\n"
        "[[ $1 == -n ]] && shift\n"
        f'case "$*" in *"--disk-root {op}"*) export SLOW=1; {killer};; esac\n'
        "exec \"$@\"\n")
    (tmp_path / "bin" / "cryptsetup").write_text(f'#!/bin/sh\n[ -n "$SLOW" ] && [ "$1" = open ] && {{ touch {begun}; echo SLOW-CHECK >/dev/tty; sleep 5; }}\nexec {CRYPTSETUP} "$@"\n')
    for tool in ("sudo", "cryptsetup"):
        (tmp_path / "bin" / tool).chmod(0o755)
    return env


NO_SUDO_AS_ROOT = pytest.mark.skipif(os.geteuid() == 0, reason="as root the root side runs without sudo, where the stand-in steps in")


@needs_cryptsetup
@NO_SUDO_AS_ROOT
@pytest.mark.skipif(not shutil.which("pkill"), reason="needs pkill")
@pytest.mark.parametrize("op", ["check", "change"], ids=["during the check", "just before the change"])
def test_only_the_root_side_stopped_before_the_change_says_so_once(tmp_path, op):
    """The root side alone gets SIGINT, while it checks the current password (op check) or just before
    its change begins (op change): it exits 130 without a word, and the command says it once."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = slow_root_side(tmp_path, disk, op, stop_root_after=0.2)
    answers = CHANGE if op == "change" else CHANGE[:2]
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, list(answers))
    assert code == 130, screen
    assert screen.count("Nothing was changed.") == 1 and "stopped. Nothing was changed." in screen
    assert "Traceback" not in screen and "still changing" not in screen
    assert opens(disk, OLD) and not opens(disk, NEW) and slots(disk) == ["0"]


@needs_cryptsetup
@NO_SUDO_AS_ROOT
def test_ctrl_c_before_the_change_begins_does_not_say_it_is_still_changing(tmp_path):
    """Ctrl+C reaches both sides while the root side, already started for the change, still checks:
    nothing has begun, so "stopped. Nothing was changed." alone, not "still changing" just before it."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = slow_root_side(tmp_path, disk, "change")
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [*CHANGE, ("SLOW-CHECK", b"\x03")])
    assert code == 130 and screen.count("Nothing was changed.") == 1, screen
    assert "still changing" not in screen and "Traceback" not in screen
    assert opens(disk, OLD) and slots(disk) == ["0"]


def test_a_root_side_that_was_killed_is_looked_at_and_the_end_state_said(monkeypatch, capsys):
    state = {"/dev/vda3": {"current": True, "new": True}, "/dev/vdb1": {"current": True, "new": False}}
    argv = {"change": ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; kill -9 $$"], "probe": [sys.executable, "-c", f"import sys; sys.stdin.read(); print({json.dumps(json.dumps(state))})"]}
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: argv[op])
    assert cli.disk_helper("change", {"devices": list(state), "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    err = capsys.readouterr().err
    assert "ended before it could say how (signal 9)" in err
    assert "/dev/vda3: the new disk password and the current one both open it" in err
    assert "/dev/vdb1: the current disk password opens it, the new one does not" in err


@pytest.mark.parametrize("code", [1, 6, -15])
def test_a_failure_of_sudo_after_the_change_was_done_is_not_the_change_s(monkeypatch, capsys, code):
    """The root side says the change is done, then sudo ends with a failure of its own (as with "sudo: :
    Broken pipe" when Ctrl+C lands at that moment): the change is done, so exit 0, and it says why."""
    # A signal the root side does not start with ignored (it starts with SIGINT and SIGQUIT ignored).
    stand_in = f"cat >/dev/null; echo '{cli.DISK_CHANGE_DONE}'; " + ("kill -TERM $$" if code < 0 else f"exit {code}")
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", stand_in] if op == "change" else ["false"])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 0
    assert f"sudo ended with exit {code} after the change was done" in capsys.readouterr().err


def test_a_failure_without_done_is_still_the_change_s(monkeypatch, capsys):
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; exit 1"] if op == "change" else ["false"])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    assert "after the change was done" not in capsys.readouterr().err


def test_when_even_looking_fails_it_says_what_is_sure(monkeypatch, capsys):
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; kill -9 $$"] if op == "change" else ["false"])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "may have ended before anything changed, or part-way" in said and "the current one or the new one (or both) opens each" in said


CTRL_Z_DRIVER = """
import importlib.machinery, importlib.util, json, os, signal, sys, threading
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
stop_after, ctrl_z_after = float(sys.argv[2]), float(sys.argv[3])
# The root side's stand-in stops itself, as a sudo that suspends on Ctrl+Z would, then ends.
stops = int(sys.argv[4]) if len(sys.argv) > 4 else 1
cli.disk_root_argv = lambda op: ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; " + " ".join([f"sleep {stop_after}; kill -STOP $$;"] * stops) + " echo resumed; exit 0"]
threading.Timer(ctrl_z_after, lambda: os.kill(os.getpid(), signal.SIGTSTP)).start()
print("code", cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": "x", "new": "y"}), flush=True)
"""


@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
@pytest.mark.parametrize("stop_after, ctrl_z_after, stops", [(0.8, 0.2, 1), (0.1, 0.4, 1), (0.6, 0.2, 2)],
                         ids=["stops after Ctrl+Z", "stopped before Ctrl+Z", "stops twice"])
def test_after_ctrl_z_a_stopped_root_side_is_continued_and_waited_for(stop_after, ctrl_z_after, stops):
    """Continuing it once, as Ctrl+Z comes, would leave one that stops a moment later stopped for good;
    one that stops again after being continued is continued again."""
    result = subprocess.run([sys.executable, "-c", CTRL_Z_DRIVER, str(CLI), str(stop_after), str(ctrl_z_after), str(stops)], capture_output=True, text=True, timeout=30)
    assert "resumed" in result.stdout and "code 0" in result.stdout, result
    assert result.stderr.count("still changing") == 1


def quiet_cryptsetup(monkeypatch, keyslots: dict[int, str], tokens: dict | None = None, named_by_slot: bool = True,
                     hidden: tuple[str, ...] = (), on_add=None):
    """A cryptsetup that opens a device without saying which key slot opened it (no "Key slot N
    unlocked"), on one device whose slots hold `keyslots`. With named_by_slot False, trying a slot on its
    own (--key-slot) never opens either, so the slot cannot be told at all; `hidden` does that for the
    slots of those passphrases only. `on_add(header)` runs when a key is added."""
    header = {"keyslots": dict(keyslots), "tokens": dict(tokens or {}), "named_by_slot": named_by_slot,
              "hidden": set(hidden), "kill_fails": False}
    tried: list[int] = []

    def run(args, key=None, new=None):
        ok = subprocess.CompletedProcess(args, 0, b"Command successful.\n", b"")
        no = subprocess.CompletedProcess(args, 2, b"", b"No key available with this passphrase.")
        slots = header["keyslots"]
        # As an interrupted check does: it may print that a slot opened, then exits 1.
        interrupted = (header.get("interrupt") and (header.get("added") or header.get("interrupt_from_start"))
                       and (header["interrupt"] == "all" or key == header["interrupt"]))
        if args[0] == "open" and interrupted:
            return subprocess.CompletedProcess(args, 1, b"Key slot 0 unlocked.\nCommand failed with code -1 (wrong or missing parameters).\n", b"")
        if args[0] == "open":
            if "--key-slot" in args:
                slot = int(args[args.index("--key-slot") + 1])
                tried.append(slot)
                return ok if header["named_by_slot"] and key not in header["hidden"] and slots.get(slot) == key else no
            return ok if key in slots.values() else no
        if args[0] == "luksDump":
            if header.get("added") and header.get("dumps_failing", 0) > 0:
                header["dumps_failing"] -= 1
                return subprocess.CompletedProcess(args, 1, b"", b"Device /dev/vda3 is busy.")
            return subprocess.CompletedProcess(args, 0, json.dumps({"keyslots": {str(n): {} for n in slots}, "tokens": header["tokens"]}).encode(), b"")
        if args[0] == "luksAddKey":
            header["added"] = True
            if header.get("add") == "silent failure":
                if header.get("on_failed_add"):
                    header["on_failed_add"](header)
                return subprocess.CompletedProcess(args, 1, b"", b"")
            if header.get("add") == "killed":
                return subprocess.CompletedProcess(args, -9, b"", b"")
            if header.get("add") == "wrote another":
                # A slot appears, but not one the new password opens.
                slots[min(set(range(32)) - set(slots))] = "not the new one"
                return subprocess.CompletedProcess(args, 1, b"", b"")
            slots[min(set(range(32)) - set(slots))] = new
            if on_add:
                on_add(header)
            # As cryptsetup does when Ctrl+C reaches it: the slot is written, then it exits 1 without a word.
            return subprocess.CompletedProcess(args, 1, b"", b"") if header.get("add") == "interrupted" else ok
        if args[0] == "luksKillSlot":
            if header["kill_fails"]:
                return subprocess.CompletedProcess(args, 1, b"", b"Device is busy.")
            slots.pop(int(args[2]), None)
            # As an interrupted luksKillSlot does: the slot is gone, and it exits 1 without a word.
            return subprocess.CompletedProcess(args, 1, b"", b"") if header.get("kill") == "interrupted" else ok
        if args[0] == "token":
            header["tokens"].pop(args[args.index("--token-id") + 1], None)
            return ok
        return ok

    monkeypatch.setattr(cli, "cryptsetup", run)
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/sbin/{name}")
    return header, tried


def root_side_here(monkeypatch, op: str, request: dict) -> int:
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps(request)))
    try:
        return cli.disk_root([op])
    except SystemExit as stop:
        return stop.code


def test_a_slot_cryptsetup_does_not_name_is_found_by_trying_each(monkeypatch):
    header, tried = quiet_cryptsetup(monkeypatch, {0: "someone else's", 1: OLD})
    assert root_side_here(monkeypatch, "check", {"devices": ["/dev/vda3"], "current": OLD}) == 0
    assert 1 in tried


def test_a_slot_found_by_trying_is_still_refused_when_a_token_uses_it(monkeypatch, capsys):
    quiet_cryptsetup(monkeypatch, {0: OLD, 1: RECOVERY}, {"0": {"type": "systemd-recovery", "keyslots": ["1"]}})
    assert root_side_here(monkeypatch, "check", {"devices": ["/dev/vda3"], "current": RECOVERY}) == cli.DISK_RECOVERY_KEY
    assert "recovery key, not the disk password" in capsys.readouterr().err


def test_a_slot_that_cannot_be_told_at_all_is_refused(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD}, named_by_slot=False)
    for op in ("check", "change"):
        assert root_side_here(monkeypatch, op, {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_OTHER_SLOT
        assert "did not say which key slot that password opens on /dev/vda3" in capsys.readouterr().err
    assert header["keyslots"] == {0: OLD}


def test_a_new_owner_s_slot_found_by_trying_is_the_one_kept(monkeypatch):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 1: "someone else's"})
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW, "newOwner": True}) == 0
    assert list(header["keyslots"].values()) == [NEW]


def test_a_new_owner_s_slot_that_cannot_be_told_leaves_the_others_and_says_so(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 1: "someone else's"})
    real = cli.luks_which_slot
    monkeypatch.setattr(cli, "luks_which_slot", lambda device, passphrase: -1 if passphrase == NEW and cli.luks_slot(device, passphrase) is not None else real(device, passphrase))
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW, "newOwner": True}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "could not be told, so its other key slots were left" in said
    # A rerun would ask the same cryptsetup and stop at exit 12; the advice is to remove the slots by hand.
    assert "Running this again would ask the same cryptsetup, which cannot tell these key slots either" in said
    assert "luksKillSlot <device> <slot>" in said and "never one a token uses" in said
    assert "again with the new password as the current one" not in said
    assert sorted(header["keyslots"].values()) == sorted(["someone else's", NEW])


def test_an_unnamed_leftover_slot_of_the_new_password_is_refused(monkeypatch, capsys):
    """The new password already opens the device, but no slot on its own: it cannot be told whose that
    slot is, so it is not taken for a leftover a take back could remove."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 1: NEW}, hidden=(NEW,))
    before = dict(header["keyslots"])
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_NEW_IS_OTHER_KEY
    assert "already opens /dev/vda3, through a key slot that cannot be told apart" in capsys.readouterr().err
    assert header["keyslots"] == before


@pytest.mark.parametrize("op", ["check", "change"])
def test_the_current_password_check_refuses_a_header_it_cannot_read(monkeypatch, capsys, op):
    """The current password opens the device, but the header cannot be read to tell its key slots and
    whose they are: refused before anything changes (exit 1)."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})

    def unreadable(device, passphrase):
        raise RuntimeError(f"cannot read the key slots of {device}: Device is busy.")

    monkeypatch.setattr(cli, "luks_opened_slots", unreadable)
    assert root_side_here(monkeypatch, op, {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    assert "cannot read the key slots of /dev/vda3: Device is busy. Nothing was changed." in capsys.readouterr().err
    assert header["keyslots"] == {0: OLD}


def test_a_leftover_whose_slots_cannot_be_read_is_refused(monkeypatch, capsys):
    """The new password opens the device, but the header cannot be read to tell whose slot that is:
    nothing changes."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 1: NEW})
    real = cli.luks_opened_slots

    def unreadable_for_the_new_one(device, passphrase):
        if passphrase == NEW:
            raise RuntimeError(f"cannot read the key slots of {device}: Device is busy.")
        return real(device, passphrase)

    monkeypatch.setattr(cli, "luks_opened_slots", unreadable_for_the_new_one)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    assert "cannot read the key slots of /dev/vda3: Device is busy. Nothing was changed." in capsys.readouterr().err
    assert header["keyslots"] == {0: OLD, 1: NEW}


def test_without_new_owner_an_untellable_slot_gives_how_to_finish_by_hand(monkeypatch, capsys):
    """After the add, no slot opens on its own any more: the old password's slot cannot be told, so it
    is left (exit 6). Running it again with the new password as the current one would stop at exit 12,
    so that is not what it advises."""
    def no_slot_opens_on_its_own(header):
        header["named_by_slot"] = False
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD}, on_add=no_slot_opens_on_its_own)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "which key slot of /dev/vda3 the old disk password opens could not be told, so it was left" in said
    assert "again with the new password as the current one" not in said
    assert "Running this again would ask the same cryptsetup" in said and "--test-passphrase --key-slot <slot> <device>" in said
    assert sorted(header["keyslots"].values()) == sorted([OLD, NEW])
    # Why: the rerun it no longer advises stops at exit 12.
    assert root_side_here(monkeypatch, "check", {"devices": ["/dev/vda3"], "current": NEW}) == cli.DISK_OTHER_SLOT


def test_without_new_owner_the_old_password_s_untellable_slot_gives_how_to_finish_by_hand(monkeypatch, capsys):
    def old_slot_no_longer_opens_on_its_own(header):
        header["hidden"].add(OLD)
    quiet_cryptsetup(monkeypatch, {0: OLD}, on_add=old_slot_no_longer_opens_on_its_own)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "the old disk password opens could not be told" in said and "Running this again would ask the same cryptsetup" in said
    assert "again with the new password as the current one" not in said


def test_without_new_owner_an_untellable_new_slot_gives_how_to_finish_by_hand(monkeypatch, capsys):
    """The new password's slot cannot be told, and the old one's removal fails: running it again with the
    new password as the current one would stop at exit 12, so the advice is by hand."""
    def removals_fail(header):
        header["kill_fails"] = True
    quiet_cryptsetup(monkeypatch, {0: OLD}, hidden=(NEW,), on_add=removals_fail)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "could not be removed: Device is busy." in said and "Running this again would ask the same cryptsetup" in said
    assert "again with the new password as the current one" not in said


def test_a_tellable_failure_still_advises_running_it_again(monkeypatch, capsys):
    def removals_fail(header):
        header["kill_fails"] = True
    quiet_cryptsetup(monkeypatch, {0: OLD}, on_add=removals_fail)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err
    assert "again with the new password as the current one" in said and "Running this again would ask" not in said


def test_an_add_that_says_it_failed_but_wrote_the_key_goes_on(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "interrupted"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 0
    said = capsys.readouterr().err
    assert "cryptsetup said the new disk password could not be added to /dev/vda3" in said and "as it does when Ctrl+C reaches it" in said
    assert "but it wrote key slot 1, which the new password opens" in said
    assert "going on" in said and "nothing was changed" not in said
    assert list(header["keyslots"].values()) == [NEW]


def test_a_silent_failed_add_says_ctrl_c_may_be_why(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "silent failure"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "could not be added to /dev/vda3: cryptsetup exited 1, without a message, as it does when Ctrl+C reaches it" in said
    assert header["keyslots"] == {0: OLD}


@pytest.mark.parametrize("token", [None, {"type": "systemd-recovery", "keyslots": ["3"]}], ids=["plain slot", "recovery key's slot"])
def test_a_failed_add_never_takes_a_slot_that_was_there_for_the_new_one(monkeypatch, capsys, token):
    """The add fails and writes nothing, but slot 3, there before, opens with the new password by the
    time it is looked at. It was not written by the add, so it is not taken for it: the change takes back
    and the old password's slot 0 stays."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 3: "someone else's"}, {"0": token} if token else {})
    header["add"] = "silent failure"
    header["on_failed_add"] = lambda header: header["keyslots"].__setitem__(3, NEW)
    # The new password now opens a slot that was there before: it will not do, as at the start (exit 13).
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_NEW_IS_OTHER_KEY
    said = capsys.readouterr().err
    assert "could not be added to /dev/vda3" in said and "going on" not in said
    assert "it now opens key slot 3 of /dev/vda3, which was there before: choose another one" in said
    assert header["keyslots"] == {0: OLD, 3: NEW}


def test_a_failed_add_whose_slot_is_seen_only_after_a_failed_read_is_taken_back(monkeypatch, capsys):
    """The add writes slot 1 and exits 1, and the header cannot be read just after it, so the look for
    new slots sees none. Slot 1 then opens with the new password, but it was not in the header from
    before: this add's, taken back, never "there before" (exit 13)."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "interrupted"
    header["dumps_failing"] = 1
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "could not be added to /dev/vda3" in said and "which was there before" not in said and "going on" not in said
    assert header["keyslots"] == {0: OLD}


def test_a_failed_add_whose_slot_cannot_be_told_is_never_called_there_before(monkeypatch, capsys):
    """As above, but which slot the new password opens cannot be told (-1): that is not a slot the header
    from before listed, so it is taken for this add's and taken back, where the take back says it cannot
    tell the slot (exit 8), never "there before" (exit 13)."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD}, hidden=(NEW,))
    header["add"] = "interrupted"
    header["dumps_failing"] = 1
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_NOT_TAKEN_BACK
    said = capsys.readouterr().err
    assert "which was there before" not in said and "which key slot it opens cannot be told" in said


def test_a_failed_add_that_wrote_a_slot_the_new_password_does_not_open_is_not_taken(monkeypatch, capsys):
    """A slot appeared, but the new password does not open it on its own (--key-slot): not taken for the
    add, so nothing goes on to remove the old password."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "wrote another"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "going on" not in said and "could not be added to /dev/vda3" in said
    assert header["keyslots"][0] == OLD


def test_an_unreadable_header_before_the_add_means_no_add(monkeypatch, capsys):
    """Without the slot numbers from before, a slot the add wrote could not be told from one that was
    there (the recovery key's, say): no luksAddKey at all, and nothing changes."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 3: NEW}, {"0": {"type": "systemd-recovery", "keyslots": ["3"]}})
    header["keyslots"][3] = "someone else's"
    real = cli.cryptsetup
    calls = []
    monkeypatch.setattr(cli, "cryptsetup", lambda args, key=None, new=None: calls.append(args[0]) or real(args, key, new))
    monkeypatch.setattr(cli, "luks_slot_numbers", lambda device: None)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "the key slots of /dev/vda3 could not be read before adding the new disk password" in said and "nothing was changed" in said
    assert "luksAddKey" not in calls and header["keyslots"] == {0: OLD, 3: "someone else's"}


def test_an_add_stopped_by_a_signal_says_so_and_not_ctrl_c(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "killed"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "could not be added to /dev/vda3: cryptsetup was stopped by signal 9" in said and "Ctrl+C" not in said


@pytest.mark.parametrize("op", ["check", "change"])
def test_an_unclear_check_of_the_current_password_changes_nothing(monkeypatch, capsys, op):
    """cryptsetup gives no answer for the current password: refused with exit 1 and "Nothing was
    changed", never taken for "not the disk password" or for an answer."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["interrupt"], header["interrupt_from_start"] = OLD, True
    assert root_side_here(monkeypatch, op, {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "could not tell whether a password opens /dev/vda3" in said and "Nothing was changed." in said
    assert "not the disk password" not in said and header["keyslots"] == {0: OLD}


def test_an_unclear_answer_in_the_scan_for_a_leftover_says_nothing_was_changed(monkeypatch, capsys):
    """The scan for an earlier run's leftover gets no answer for the new password: nothing has been
    written, so "Nothing was changed", not "maybe part-way"."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["interrupt"], header["interrupt_from_start"] = NEW, True
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "Nothing was changed." in said and "part-way" not in said and header["keyslots"] == {0: OLD}


def test_a_timeout_before_the_add_says_nothing_was_changed(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    real = cli.cryptsetup

    def slow_for_the_new_one(args, key=None, new=None):
        if args[0] == "open" and key == NEW:
            raise subprocess.TimeoutExpired(["cryptsetup", "open"], 300)
        return real(args, key, new)

    monkeypatch.setattr(cli, "cryptsetup", slow_for_the_new_one)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    said = capsys.readouterr().err
    assert "did not finish in 300 s (open) and was stopped. Nothing was changed." in said and "part-way" not in said


def test_a_new_owner_s_kill_that_says_it_failed_but_removed_the_slot_finishes(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 2: "someone else's"})
    header["kill"] = "interrupted"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW, "newOwner": True}) == 0
    assert "could not be removed" not in capsys.readouterr().err
    assert list(header["keyslots"].values()) == [NEW]


def test_a_new_slot_a_token_uses_is_not_taken_for_the_add(monkeypatch, capsys):
    """The failed add wrote slot 1, which the new password opens, but a token uses it: not taken, and the
    take back leaves it and says so (exit 8)."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["add"] = "interrupted"
    header["tokens"]["0"] = {"type": "systemd-tpm2", "keyslots": ["1"]}
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_NOT_TAKEN_BACK
    said = capsys.readouterr().err
    assert "going on" not in said and "the TPM uses to unlock it" in said
    assert header["keyslots"] == {0: OLD, 1: NEW}


@pytest.mark.parametrize("interrupt", [OLD, "all"], ids=["the old password's checks", "every check"])
def test_an_interrupted_check_after_the_add_is_never_taken_as_an_answer(monkeypatch, capsys, interrupt):
    """Every check after the add ends as an interrupted cryptsetup does ("Key slot 0 unlocked", then exit
    1): never "Done ... the old one no longer opens it", never "does not open ... after adding it", never
    "nothing was changed". The change stops there (exit 6), and both passwords are left."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["interrupt"] = interrupt
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    said = capsys.readouterr().err + capsys.readouterr().out
    assert "could not tell whether a password opens" in said and "the current one or the new one (or both) opens each" in said
    for wrong in ("Done", "no longer opens", "after adding it", "nothing was changed"):
        assert wrong not in said, wrong
    assert sorted(header["keyslots"].values()) == sorted([OLD, NEW])


def test_a_kill_that_says_it_failed_but_removed_the_slot_finishes(monkeypatch, capsys):
    """luksKillSlot reached by Ctrl+C removes the slot and exits 1: the slot is gone from the header, so the
    change is done (exit 0), not \"key slot 0 could not be removed\"."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["kill"] = "interrupted"
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 0
    captured = capsys.readouterr()
    assert "could not be removed" not in captured.err and "Done" in captured.out
    assert list(header["keyslots"].values()) == [NEW]


def test_a_kill_that_failed_and_left_the_slot_still_says_so(monkeypatch, capsys):
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    header["kill_fails"] = True
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    assert "key slot 0 of /dev/vda3 could not be removed: Device is busy." in capsys.readouterr().err


def test_the_old_password_is_never_removed_from_a_slot_a_token_came_to_use(monkeypatch, capsys):
    """The check found the old password in two plain slots; a token then comes to use one of them
    while the new password goes in. That slot stays, and the change says so (exit 6)."""
    def token_on_slot_2(header):
        header["tokens"]["0"] = {"type": "systemd-recovery", "keyslots": ["2"]}
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 2: OLD}, on_add=token_on_slot_2)
    assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == cli.DISK_PARTLY
    err = capsys.readouterr().err
    assert "also opens key slot 2 of /dev/vda3, which the recovery key uses to unlock it, so that slot was left" in err
    assert header["keyslots"] == {1: NEW, 2: OLD} and header["tokens"]["0"]["keyslots"] == ["2"]


@pytest.mark.parametrize("code", [0, 1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 127, 130])
def test_every_end_the_root_side_says_itself_is_passed_on_without_looking(monkeypatch, tmp_path, code):
    """A code in DISK_ENDS (the refusals 9 to 13 among them) is the root side's own word; only another
    end, a killed root side, is looked at afterwards."""
    looked = tmp_path / "looked"
    argv = {"change": ["sh", "-c", f"cat >/dev/null; exit {code}"], "probe": ["sh", "-c", f"touch {looked}; echo '{{}}'"]}
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: argv[op])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == code
    assert not looked.exists()


def test_the_refusals_are_all_ends_the_root_side_says_itself():
    assert {cli.DISK_RECOVERY_KEY, cli.DISK_TPM_SLOT, cli.DISK_FIDO2_SLOT, cli.DISK_OTHER_SLOT, cli.DISK_NEW_IS_OTHER_KEY, cli.DISK_SHARED_SECRET} <= cli.DISK_ENDS
    assert {9, 10, 11, 12, 13, 14} <= cli.DISK_ENDS


EARLY_STOP_DRIVER = """
import importlib.machinery, importlib.util, os, signal, sys, threading
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
# The root side checks for a moment, then begins (it says so), then is done.
cli.disk_root_argv = lambda op: ["sh", "-c", "cat >/dev/null; sleep 0.8; echo 'Adding the new disk password to /dev/vda3…'; sleep 0.5; echo Done; exit 0"]
# Ctrl+C reaching this side alone, before the root side has begun.
threading.Timer(0.2, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
print("code", cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": "x", "new": "y"}), flush=True)
"""


def test_a_stop_before_the_change_begins_is_told_once_it_has_begun():
    """A Ctrl+C that reaches the command alone before the root side begins says nothing yet; once the root
    side says it is adding the new password, the command says that it waits, once, and the change ends."""
    result = subprocess.run([sys.executable, "-c", EARLY_STOP_DRIVER, str(CLI)], capture_output=True, text=True, timeout=30)
    assert "code 0" in result.stdout and "Done" in result.stdout, result
    assert result.stderr.count("still changing") == 1, result.stderr


DRAIN_DRIVER = """
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
# The root side ends at once; something it left behind still writes to its output a moment later.
cli.disk_root_argv = lambda op: ["sh", "-c", "cat >/dev/null; (sleep 0.6; echo late-line) & exit 0"]
print("code", cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": "x", "new": "y"}), flush=True)
"""


def test_the_root_side_s_output_is_passed_on_to_the_end():
    result = subprocess.run([sys.executable, "-c", DRAIN_DRIVER, str(CLI)], capture_output=True, text=True, timeout=30)
    assert "late-line" in result.stdout and "code 0" in result.stdout, result


def test_draining_stops_when_the_pipe_stays_open(tmp_path):
    """Something that keeps the pipe open without writing does not hold the command for good."""
    read, write = os.pipe()
    started = time.monotonic()
    cli.disk_drain(os.fdopen(read, "rb"), None, wait=0.3)
    os.close(write)
    assert time.monotonic() - started < 2


def test_an_unclear_look_is_not_taken_for_does_not_open(monkeypatch):
    """The look after a killed root side: cryptsetup gives no answer for one password, which is "could not
    be checked", never False ("does not open")."""
    def slot(device, passphrase):
        if passphrase == NEW:
            raise cli.LuksUnsure("cryptsetup could not tell whether a password opens /dev/vda3 (cryptsetup exited 1)")
        return 0
    monkeypatch.setattr(cli, "luks_slot", slot)
    monkeypatch.setattr(cli, "disk_busy", lambda devices: set())
    state = cli.disk_probe(["/dev/vda3"], OLD, NEW)
    assert state == {"/dev/vda3": {"current": True, "new": None}}
    assert cli.disk_end_lines(state) == ["/dev/vda3: it could not be checked; try the new disk password first, then the current one"]


def test_the_root_side_s_look_has_a_time_limit_and_ignores_ctrl_z(monkeypatch):
    """The look may be stopped (SIGTERM, or Ctrl+C reaching its cryptsetup), never left stopped by Ctrl+Z,
    and it sets its own time limit."""
    seen, alarms = [], []
    monkeypatch.setattr(cli, "luks_slot", lambda device, passphrase: seen.append(signal.getsignal(signal.SIGTSTP)) or 0)
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/sbin/{name}")
    monkeypatch.setattr(cli.signal, "alarm", alarms.append)
    monkeypatch.setattr(cli, "disk_busy", lambda devices: set())
    before = signal.getsignal(signal.SIGTSTP)
    try:
        assert root_side_here(monkeypatch, "probe", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 0
    finally:
        signal.signal(signal.SIGTSTP, before)
    assert seen and all(handler == signal.SIG_IGN for handler in seen)
    assert alarms == [cli.DISK_LOOK_TIMEOUT] and cli.DISK_LOOK_TIMEOUT <= 120


def test_the_root_side_takes_ctrl_c_as_a_stop_only_for_the_check_and_the_change(monkeypatch):
    """It is started with SIGINT and SIGQUIT ignored; check and change turn them into a stop (exit 130
    before the change), the probe leaves them ignored."""
    got = {}
    monkeypatch.setattr(cli, "disk_root_op", lambda args: got.setdefault(args[0], (signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGQUIT))) and 0)
    before = {each: signal.getsignal(each) for each in (signal.SIGINT, signal.SIGQUIT)}
    try:
        for op in ("check", "change", "probe"):
            for each in before:
                signal.signal(each, signal.SIG_IGN)
            cli.disk_root([op])
    finally:
        for each, handler in before.items():
            signal.signal(each, handler)
    assert got["check"] == got["change"] == (cli.disk_stop, cli.disk_stop)
    assert got["probe"] == (signal.SIG_IGN, signal.SIG_IGN)


def test_a_noted_ctrl_c_stops_after_the_next_cryptsetup_and_before_the_hold(monkeypatch):
    """Noted where it lands, then a stop at the next cryptsetup call or when the change would begin, and
    nothing once the change holds its signals."""
    monkeypatch.setitem(cli.DISK_STOPPED, "yes", False)
    monkeypatch.setattr(cli, "cryptsetup_run", lambda *a: subprocess.CompletedProcess(a, 0, b"", b""))
    cli.cryptsetup(["isLuks", "/dev/vda3"])
    cli.disk_stop(signal.SIGINT, None)
    with pytest.raises(KeyboardInterrupt):
        cli.cryptsetup(["isLuks", "/dev/vda3"])
    before = signal.getsignal(signal.SIGINT)
    with pytest.raises(KeyboardInterrupt):
        with cli.disk_signals_held():
            pytest.fail("the change began after a Ctrl+C")
    assert signal.getsignal(signal.SIGINT) == before and not cli.CRYPTSETUP_OWN_SESSION["on"]
    monkeypatch.setitem(cli.CRYPTSETUP_OWN_SESSION, "on", True)
    cli.cryptsetup(["luksDump", "/dev/vda3"])


STARTED_WITH = """
import importlib.machinery, importlib.util, signal, sys
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
show = "import signal, sys; sys.stdin.read(); print('ignored', signal.getsignal(signal.SIGINT) == signal.SIG_IGN, signal.getsignal(signal.SIGQUIT) == signal.SIG_IGN, flush=True)"
cli.disk_root_argv = lambda op: [sys.executable, "-c", show]
cli.disk_helper(sys.argv[2], {"devices": ["/dev/vda3"], "current": "x", "new": "y"})
print("after", signal.getsignal(signal.SIGINT) == signal.default_int_handler, flush=True)
"""


@pytest.mark.parametrize("op", ["check", "change"])
def test_the_root_side_starts_with_ctrl_c_ignored(op):
    """So a Ctrl+C while sudo and Python start cannot reach it half-started: no traceback, no "Fatal Python
    error", no death that would read as a change ended without saying."""
    result = subprocess.run([sys.executable, "-c", STARTED_WITH, str(CLI), op], capture_output=True, text=True, timeout=30)
    assert "ignored True True" in result.stdout, result
    if op == "check":
        assert "after True" in result.stdout, "the person's side keeps its own handler"


@pytest.mark.parametrize("death", ["kill -TERM $$", "kill -HUP $$", "kill -9 $$", "exit 134"])
def test_a_root_side_that_dies_before_it_starts_changing_changed_nothing(monkeypatch, capsys, death):
    """Before it says it is adding the new password, nothing is written: a death by a signal there is a
    stop (130, which the command answers with "stopped. Nothing was changed."), never a look for a change
    that ended part-way."""
    looked = []
    argv = {"change": ["sh", "-c", f"cat >/dev/null; {death}"], "probe": ["sh", "-c", "echo looked"]}
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: looked.append(op) or argv[op])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 130
    assert "probe" not in looked and "ended before it could say how" not in capsys.readouterr().err


def test_a_root_side_that_ends_oddly_before_it_starts_changing_says_nothing_was_changed(monkeypatch, capsys):
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", "cat >/dev/null; exit 42"])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 1
    assert "ended (exit 42) before it changed anything. Nothing was changed." in capsys.readouterr().err


AFTER_DONE_DRIVER = """
import importlib.machinery, importlib.util, os, signal, sys, threading
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
cli.disk_root_argv = lambda op: ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; echo '" + cli.DISK_CHANGE_DONE + "'; sleep 0.8; exit 0"]
threading.Timer(0.4, lambda: os.kill(os.getpid(), signal.SIGINT)).start()
print("code", cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": "x", "new": "y"}), flush=True)
"""


def test_a_ctrl_c_after_done_does_not_say_it_is_still_changing():
    result = subprocess.run([sys.executable, "-c", AFTER_DONE_DRIVER, str(CLI)], capture_output=True, text=True, timeout=30)
    assert "code 0" in result.stdout and "Done" in result.stdout, result
    assert "still changing" not in result.stderr


def test_a_ctrl_c_just_before_the_change_starts_is_a_stop_with_one_message(monkeypatch, capsys):
    """Between the last answer and disk_helper_change holding Ctrl+C: the command stops with exit 130 and
    says "stopped. Nothing was changed." once, without a traceback."""
    monkeypatch.setattr(cli, "disk_devices", lambda: ["/dev/vda3"])
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    answers = iter([OLD, NEW, NEW])
    monkeypatch.setattr(cli, "disk_ask", lambda prompt: next(answers))

    def helper(op, request):
        if op == "change":
            raise KeyboardInterrupt
        return 0

    monkeypatch.setattr(cli, "disk_helper", helper)
    monkeypatch.setattr(cli, "SSH_OWN_PROCESS", True)
    with pytest.raises(SystemExit) as stop:
        cli.disk_password([])
    assert stop.value.code == 130
    said = capsys.readouterr().err
    assert said.count("stopped. Nothing was changed.") == 1 and "Traceback" not in said
    # Run as its own process, one more Ctrl+C before it exits does nothing.
    assert signal.getsignal(signal.SIGINT) == signal.getsignal(signal.SIGQUIT) == signal.SIG_IGN


@pytest.mark.parametrize("code", [-2, -15])
def test_a_check_that_ends_by_a_signal_is_a_stop(monkeypatch, capsys, code):
    """A root side whose check dies by a signal (as when Ctrl+C lands while it starts) only looked: a
    stop with nothing changed, said once, and no change asked for."""
    monkeypatch.setattr(cli, "disk_devices", lambda: ["/dev/vda3"])
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli, "disk_ask", lambda prompt: OLD)
    asked = []
    monkeypatch.setattr(cli, "disk_helper", lambda op, request: asked.append(op) or code)
    with pytest.raises(SystemExit) as stop:
        cli.disk_password([])
    assert stop.value.code == 130 and asked == ["check"]
    assert capsys.readouterr().err.count("stopped. Nothing was changed.") == 1


def test_a_look_that_runs_out_of_time_is_killed_and_said(monkeypatch, tmp_path, capsys):
    """The look after an odd end has a time limit; past it the root side is ended rather than waited for,
    and the command says the state could not be checked."""
    pid_file = tmp_path / "pid"
    look = f"import os, sys, time; open({str(pid_file)!r}, 'w').write(str(os.getpid())); sys.stdin.read(); time.sleep(30)"
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: [sys.executable, "-c", look])
    monkeypatch.setattr(cli, "DISK_LOOK_TIMEOUT", 0.5)
    monkeypatch.setattr(cli, "DISK_LOOK_GRACE", 0)
    started = time.monotonic()
    assert cli.disk_report_end({"devices": ["/dev/vda3"], "current": OLD, "new": NEW}, -9) == cli.DISK_PARTLY
    assert time.monotonic() - started < 10
    assert "that could not be checked" in capsys.readouterr().err
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_ctrl_c_stops_the_look_and_the_root_side_with_it(monkeypatch, tmp_path, capsys):
    """The look is not held: Ctrl+C stops it at once, ends the root side, and says what is still sure."""
    pid_file = tmp_path / "pid"
    look = f"import os, sys, time; open({str(pid_file)!r}, 'w').write(str(os.getpid())); sys.stdin.read(); time.sleep(30)"
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: [sys.executable, "-c", look])
    timer = threading.Timer(0.5, lambda: os.kill(os.getpid(), signal.SIGINT))
    started = time.monotonic()
    timer.start()
    try:
        assert cli.disk_report_end({"devices": ["/dev/vda3"], "current": OLD, "new": NEW}, -9) == cli.DISK_PARTLY
    finally:
        timer.cancel()
    assert time.monotonic() - started < 10
    said = capsys.readouterr().err
    assert "may first wait up to 30 s for a cryptsetup still at work" in said
    assert "Ctrl+C stops looking" in said and "stopped looking" in said and "the current one or the new one (or both) opens each" in said
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


SLOW_LOOK = """
import os, signal, sys, time
folder = sys.argv[1]
with open(folder + "/look", "w") as out:
    out.write(" ".join([str(os.getpid())] + ["default" if signal.getsignal(each) == signal.SIG_DFL else "not default" for each in (signal.SIGTERM, signal.SIGHUP)]))
sys.stdin.read()
if sys.argv[2] == "stops":
    os.kill(os.getpid(), signal.SIGSTOP)
time.sleep(30)
"""


def look_gone(pid: int) -> bool:
    return not Path(f"/proc/{pid}").exists() if Path("/proc").is_dir() else True


@pytest.mark.parametrize("sudo", ["none", "real"])
@pytest.mark.parametrize("how", ["runs", "stops"], ids=["a slow look", "a stopped look"])
def test_ctrl_c_ends_the_look_and_its_root_side_at_once(monkeypatch, tmp_path, capsys, how, sudo):
    """After the change this side ignores SIGTERM and SIGHUP; the look's root side must not keep that, or
    SIGTERM (which sudo passes on) cannot end it and only SIGKILL does, 5 s later. One that is stopped is
    continued after SIGTERM, so it ends at once too."""
    if sudo == "real" and (os.geteuid() == 0 or not shutil.which("sudo") or subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode != 0):
        pytest.skip("needs sudo without a password, as someone other than root")
    if sudo == "real" and how == "stops":
        # sudo that runs its command without a pseudo-terminal of its own (no use_pty) stops itself and
        # its caller's process group when that command stops, as a shell job does: here, the test run.
        pytest.skip("a stopped command under the real sudo stops the test run itself")
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: [*(["sudo", "-n"] if sudo == "real" else []), sys.executable, "-c", SLOW_LOOK, str(tmp_path), how])
    before = {each: signal.getsignal(each) for each in (signal.SIGTERM, signal.SIGHUP)}
    for each in before:
        signal.signal(each, signal.SIG_IGN)
    timer = threading.Timer(1.0, lambda: os.kill(os.getpid(), signal.SIGINT))
    try:
        pressed = time.monotonic() + 1.0
        timer.start()
        assert cli.disk_report_end({"devices": ["/dev/vda3"], "current": OLD, "new": NEW}, -9) == cli.DISK_PARTLY
        ended = time.monotonic()
    finally:
        timer.cancel()
        for each, handler in before.items():
            signal.signal(each, handler)
    assert "stopped looking" in capsys.readouterr().err
    pid, *dispositions = (tmp_path / "look").read_text().split()
    assert dispositions == ["default", "default"], "the look's root side started with SIGTERM or SIGHUP ignored"
    assert look_gone(int(pid)), "the look's root side outlived the command"
    # Ctrl+C is seen within half a second, and SIGTERM ends the look at once; SIGKILL comes only after 5 s.
    assert ended - pressed < 1.5, f"ending the look took {ended - pressed:.1f} s"


@pytest.mark.parametrize("op", ["check", "change", "probe"])
def test_every_root_side_starts_with_sigterm_and_sighup_at_default(monkeypatch, op):
    """However this side holds them, each root side it starts can be ended by SIGTERM and SIGHUP, and
    starts with Ctrl+C and Ctrl+\\ ignored; this side's own handling stays as it was."""
    show = ("import signal; print(*['default' if signal.getsignal(each) == signal.SIG_DFL else 'ignored' if signal.getsignal(each) == signal.SIG_IGN "
            "else 'other' for each in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT)])")
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: [sys.executable, "-c", show])
    held = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT)
    before = {each: signal.getsignal(each) for each in held}
    for each in held:
        signal.signal(each, signal.SIG_IGN)
    try:
        process = cli.disk_root_start(op, stdout=subprocess.PIPE, text=True)
        out, _ = process.communicate("", timeout=30)
        after = [signal.getsignal(each) for each in held]
    finally:
        for each, handler in before.items():
            signal.signal(each, handler)
    assert out.split() == ["default", "default", "ignored", "ignored"]
    assert after == [signal.SIG_IGN] * 4


LOOK_LIMIT_DRIVER = """
import importlib.machinery, importlib.util, io, json, sys
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
cli.DISK_LOOK_TIMEOUT = 1
if sys.argv[2:]:
    cli.DISK_PROC = cli.Path(sys.argv[2])
sys.stdin = io.StringIO(json.dumps({"devices": ["/dev/vda3"], "current": "x", "new": "y"}))
sys.exit(cli.disk_root(["probe"]))
"""


@pytest.mark.parametrize("proc", [None, "no-proc"], ids=["this system's /proc", "no /proc (macOS)"])
def test_the_root_side_s_look_ends_itself_at_its_time_limit(tmp_path, proc):
    """Even with the person's side gone, the root side's look does not run on: it ends at its own limit
    (SIGALRM), here while its cryptsetup hangs; also where there is no /proc to look for a busy device in."""
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "cryptsetup").write_text("#!/bin/sh\nexec sleep 60\n")
    (folder / "cryptsetup").chmod(0o755)
    process = subprocess.Popen([sys.executable, "-c", LOOK_LIMIT_DRIVER, str(CLI), *([str(tmp_path / proc)] if proc else [])],
                               env={**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        process.wait(timeout=30)
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        _, stderr = process.communicate()
    assert process.returncode == -signal.SIGALRM, stderr


def test_nothing_is_found_busy_where_proc_cannot_be_listed(monkeypatch, tmp_path):
    """Where there is no /proc (macOS), no cryptsetup can be found at work: nothing is busy, and the look
    goes ahead."""
    monkeypatch.setattr(cli, "DISK_PROC", tmp_path / "no-proc")
    assert cli.disk_busy(["/dev/vda3"]) == set()
    quiet_cryptsetup(monkeypatch, {0: OLD})
    assert cli.disk_probe(["/dev/vda3"], OLD, NEW) == {"/dev/vda3": {"current": True, "new": False}}


def test_the_change_runs_with_noflsh_and_the_settings_come_back_after_a_pause(monkeypatch):
    """`password --disk` runs the change with NOFLSH on the terminal, and puts the settings from before
    back only a moment (DISK_SETTLE) after it has ended, so the last line can reach the screen first."""
    fd, child_end = pty.openpty()
    monkeypatch.setattr(cli, "DISK_TTY", os.ttyname(child_end))
    monkeypatch.setattr(cli, "disk_foreground", lambda descriptor: True)
    monkeypatch.setattr(cli, "disk_devices", lambda: ["/dev/vda3"])
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    answers = iter([OLD, NEW, NEW])
    monkeypatch.setattr(cli, "disk_ask", lambda prompt: next(answers))
    seen = {}

    def helper(op, request):
        if op == "change":
            seen["noflsh"] = bool(termios.tcgetattr(child_end)[3] & termios.NOFLSH)
            seen["ended"] = time.monotonic()
        return 0

    monkeypatch.setattr(cli, "disk_helper", helper)
    restored = []
    real = cli.termios.tcsetattr
    monkeypatch.setattr(cli.termios, "tcsetattr", lambda descriptor, when, attributes: (
        restored.append(time.monotonic()) if when == termios.TCSAFLUSH else None) or real(descriptor, when, attributes))
    before = termios.tcgetattr(child_end)
    try:
        assert cli.disk_password([]) == 0
        after = termios.tcgetattr(child_end)
    finally:
        os.close(fd)
        os.close(child_end)
    assert seen["noflsh"], "the change ran without NOFLSH"
    assert after == before and len(restored) == 1
    assert cli.DISK_SETTLE >= 0.2 and restored[0] - seen["ended"] >= cli.DISK_SETTLE * 0.9


GONE_READER_DRIVER = """
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("cli", sys.argv[1])
cli = importlib.util.module_from_spec(importlib.util.spec_from_loader("cli", loader))
loader.exec_module(cli)
for line in ("Adding the new disk password to /dev/vda3…", "The new disk password opens the disk. Removing the old one…", cli.DISK_CHANGE_DONE):
    cli.disk_say(line)
sys.exit(6)
"""


def test_the_root_side_ends_quietly_with_its_own_code_when_its_reader_is_gone():
    """The person's side was killed (SIGKILL), so the root side writes to a pipe nobody reads: no
    "Exception ignored … BrokenPipeError" at exit, and its own exit code, not Python's 120."""
    read, write = os.pipe()
    os.close(read)
    try:
        result = subprocess.run([sys.executable, "-c", GONE_READER_DRIVER, str(CLI)], stdout=write, stderr=subprocess.PIPE, text=True, timeout=60)
    finally:
        os.close(write)
    assert result.returncode == 6 and result.stderr == "", result.stderr


def test_a_ctrl_c_while_the_root_side_starts_is_counted(monkeypatch, capsys):
    """This side keeps its handlers while it starts the root side (the shell it starts ignores Ctrl+C for
    the root side instead), so a Ctrl+C at that moment is one the change says it waits for, not lost."""
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: ["sh", "-c", "cat >/dev/null; echo 'Adding the new disk password to /dev/vda3…'; "
                                                                        f"sleep 0.3; echo '{cli.DISK_CHANGE_DONE}'"])
    real = cli.subprocess.Popen

    def popen(argv, **kwargs):
        assert argv[:len(cli.DISK_ROOT_SHELL)] == cli.DISK_ROOT_SHELL
        os.kill(os.getpid(), signal.SIGINT)
        return real(argv, **kwargs)

    monkeypatch.setattr(cli.subprocess, "Popen", popen)
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 0
    assert capsys.readouterr().err.count("still changing") == 1


def test_a_ctrl_c_just_as_the_root_side_holds_its_signals_is_a_stop(monkeypatch):
    """One that comes at the very moment the change switches to holding Ctrl+C (still pending then) is a
    stop, as one a moment before is, not dropped."""
    monkeypatch.setitem(cli.DISK_STOPPED, "yes", False)
    signal.signal(signal.SIGINT, cli.disk_stop)
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT})
    os.kill(os.getpid(), signal.SIGINT)
    with pytest.raises(KeyboardInterrupt):
        with cli.disk_signals_held():
            pytest.fail("the change began after a Ctrl+C")
    assert signal.getsignal(signal.SIGINT) == cli.disk_stop and not cli.CRYPTSETUP_OWN_SESSION["on"]


def left_add(tmp_path: Path, seconds: float) -> subprocess.Popen:
    """A luksAddKey a killed root side left running on /dev/vda3: a process named cryptsetup, for a while."""
    name = tmp_path / "cryptsetup"
    if not name.exists():
        name.symlink_to(sys.executable)
    left = subprocess.Popen([str(name), "-c", f"import time; time.sleep({seconds})", "luksAddKey", "/dev/vda3"])
    # Until it has run exec, /proc shows it as this process: wait for it to be seen at work, however
    # long a loaded machine takes, rather than look too soon.
    deadline = time.monotonic() + 60
    while not cli.disk_busy(["/dev/vda3"]) and left.poll() is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert cli.disk_busy(["/dev/vda3"]), "the stand-in cryptsetup never showed in /proc"
    return left


@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
def test_the_look_waits_for_a_cryptsetup_left_working_on_the_disk(monkeypatch, tmp_path):
    """A root side killed during luksAddKey leaves it running in a session of its own: the look waits for
    it to end before it asks what opens the device, or it could say the new password does not."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD, 1: NEW})
    real = cli.cryptsetup
    left = left_add(tmp_path, 1.0)
    first = []
    monkeypatch.setattr(cli, "cryptsetup", lambda *args: first.append(left.poll()) or real(*args))
    try:
        state = cli.disk_probe(["/dev/vda3"], OLD, NEW)
    finally:
        left.kill()
        left.wait()
    assert first and first[0] is not None, "it looked while cryptsetup still worked on the device"
    assert state == {"/dev/vda3": {"current": True, "new": True}}


def kill_root_side_during_add(disk: Path, killed: list) -> None:
    """SIGKILL the root side as soon as its luksAddKey on `disk` runs: that cryptsetup's parent."""
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline and not killed:
        for entry in Path("/proc").iterdir():
            try:
                argv = (entry / "cmdline").read_bytes().split(b"\0")
                if entry.name.isdigit() and os.path.basename(argv[0]) == b"cryptsetup" and b"luksAddKey" in argv and os.fsencode(disk) in argv:
                    parent = int((entry / "stat").read_text().rsplit(")", 1)[1].split()[1])
                    os.kill(parent, signal.SIGKILL)
                    killed.append(parent)
                    return
            except (OSError, IndexError, ValueError):
                continue
        time.sleep(0.01)


@needs_cryptsetup
@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
def test_a_root_side_killed_during_its_add_is_looked_at_once_the_add_ends(tmp_path):
    """The root side is killed while its luksAddKey runs, which goes on in a session of its own. The look
    waits for it, so what it says is what opens the disk once the add has ended: both passwords, or only
    the current one where the add was killed before it had the current password to read."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    killed: list[int] = []
    killer = threading.Thread(target=kill_root_side_during_add, args=(disk, killed), daemon=True)
    killer.start()
    code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, list(CHANGE))
    killer.join(timeout=5)
    assert killed, "the add ended before it could be caught"
    assert code == cli.DISK_PARTLY and "ended before it could say how (signal 9)" in screen, screen
    assert opens(disk, OLD) and "still changing" not in screen, screen
    said = "the new disk password and the current one both open it" if opens(disk, NEW) else "the current disk password opens it, the new one does not"
    assert said in screen, screen


@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
@pytest.mark.parametrize("seconds, code", [(1.0, 0), (30, 1)], ids=["it ends", "it does not end"])
def test_a_change_waits_for_a_cryptsetup_left_working_on_the_disk(monkeypatch, tmp_path, capsys, seconds, code):
    """As the look does: a change waits for a cryptsetup still at work on the device (left by a change that
    was killed), then goes on; one that does not end in time leaves the disk as it is."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    monkeypatch.setattr(cli, "DISK_LOOK_WAIT", 5)
    left = left_add(tmp_path, seconds)
    try:
        got = root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW})
    finally:
        left.kill()
        left.wait()
    out = capsys.readouterr()
    assert got == code, out
    assert "Waiting for a cryptsetup still at work on /dev/vda3" in out.out
    if code:
        assert "still at work on /dev/vda3; wait for it to end, then try again. Nothing was changed." in out.err
        assert header["keyslots"] == {0: OLD} and not header.get("added")
    else:
        assert list(header["keyslots"].values()) == [NEW]


@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
def test_ctrl_c_stops_a_change_s_wait_for_a_cryptsetup_at_work(monkeypatch, tmp_path):
    """The wait comes before the change begins, so a Ctrl+C there is a stop with nothing changed (130),
    at once rather than when the wait ends."""
    header, _ = quiet_cryptsetup(monkeypatch, {0: OLD})
    monkeypatch.setitem(cli.DISK_STOPPED, "yes", False)
    monkeypatch.setattr(cli, "DISK_LOOK_WAIT", 30)
    left = left_add(tmp_path, 30)
    timer = threading.Timer(0.5, lambda: cli.disk_stop(signal.SIGINT, None))
    started = time.monotonic()
    timer.start()
    try:
        assert root_side_here(monkeypatch, "change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == 130
    finally:
        timer.cancel()
        left.kill()
        left.wait()
    assert time.monotonic() - started < 10 and header["keyslots"] == {0: OLD}


@pytest.mark.skipif(sys.platform != "linux", reason="reads /proc")
def test_a_device_cryptsetup_still_works_on_after_the_wait_is_said_to_be_changing(monkeypatch, tmp_path):
    quiet_cryptsetup(monkeypatch, {0: OLD})
    monkeypatch.setattr(cli, "DISK_LOOK_WAIT", 0.3)
    left = left_add(tmp_path, 30)
    try:
        state = cli.disk_probe(["/dev/vda3", "/dev/vdb1"], OLD, NEW)
    finally:
        left.kill()
        left.wait()
    assert state["/dev/vda3"]["busy"] and "busy" not in state["/dev/vdb1"]
    assert cli.disk_end_lines(state)[0].startswith("/dev/vda3: cryptsetup was still changing it, so what opens it may change")


STARTING_DRIVER = """
import importlib.abc, os, runpy, signal, sys
# Ctrl+C while Python loads the command: as it imports base64, from its first lines.
class Stop(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name == "base64":
            os.kill(os.getpid(), signal.SIGINT)
        return None
sys.meta_path.insert(0, Stop())
cli = sys.argv[1]
sys.argv = ["herald-os", "password", "--disk"]
runpy.run_path(cli, run_name="__main__")
"""


def test_ctrl_c_while_the_command_starts_ends_quietly():
    """No KeyboardInterrupt traceback for a Ctrl+C before `password --disk` handles one itself."""
    result = subprocess.run([sys.executable, "-c", STARTING_DRIVER, str(CLI)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 130 and "Traceback" not in result.stderr, result
    assert "stopped. Nothing was changed." in result.stderr


def test_a_command_started_with_ctrl_c_ignored_keeps_it_ignored_while_it_starts(tmp_path):
    """Started with SIGINT ignored, it does not take one as a stop while it loads: it carries on."""
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "lsblk").write_text("#!/bin/sh\nexit 1\n")
    (folder / "lsblk").chmod(0o755)
    driver = STARTING_DRIVER.replace('sys.argv = ["herald-os", "password", "--disk"]',
                                     'sys.argv = ["herald-os", "password", "--disk", "--status"]\nsignal.signal(signal.SIGINT, signal.SIG_IGN)')
    result = subprocess.run([sys.executable, "-c", driver, str(CLI)], capture_output=True, text=True, timeout=60,
                            env={**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"})
    assert result.returncode == 0 and json.loads(result.stdout)["encrypted"] is None, result


def test_ctrl_c_while_it_looks_for_the_disks_ends_quietly(tmp_path):
    """Ctrl+C while it lists the disks, before it asks anything: a stop, said plainly."""
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "lsblk").write_text("#!/bin/sh\nkill -INT $PPID\nsleep 5\n")
    (folder / "lsblk").chmod(0o755)
    result = subprocess.run([sys.executable, str(CLI), "password", "--disk"], capture_output=True, text=True, timeout=60,
                            env={**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"})
    assert result.returncode == 130 and "Traceback" not in result.stderr, result
    assert result.stderr.count("stopped. Nothing was changed.") == 1


FLOOD = "i=0; while [ $i -lt 400 ]; do kill -INT $PPID 2>/dev/null || exit 0; i=$((i+1)); done"


@needs_cryptsetup
def test_a_flood_of_ctrl_c_at_the_sudo_prompt_is_a_stop(tmp_path):
    """Many Ctrl+C at once while sudo asks: one stop (130), said once, never an end by SIGINT (-2) from a
    second one that lands while the first is being said."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    (tmp_path / "bin" / "sudo").write_text(f"#!/bin/sh\n[ \"$1\" = -v ] && {{ {FLOOD}; exit 1; }}\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n")
    if os.geteuid() == 0:
        pytest.skip("as root it asks sudo nothing")
    for attempt in range(5):
        code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, [])
        assert code == 130 and "Traceback" not in screen, (attempt, code, screen)
        assert screen.count("stopped. Nothing was changed.") == 1, (attempt, screen)


def test_a_flood_of_ctrl_c_while_it_looks_for_the_disks_is_a_stop(tmp_path):
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "lsblk").write_text(f"#!/bin/sh\n{FLOOD}\nsleep 5\n")
    (folder / "lsblk").chmod(0o755)
    for attempt in range(5):
        result = subprocess.run([sys.executable, str(CLI), "password", "--disk"], capture_output=True, text=True, timeout=60,
                                env={**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"})
        assert result.returncode == 130 and "Traceback" not in result.stderr, (attempt, result)
        assert result.stderr.count("stopped. Nothing was changed.") == 1, (attempt, result.stderr)


EXIT_DRIVER = """
import atexit, os, runpy, signal, sys
# What SIGINT and SIGQUIT are as Python begins to shut down (atexit comes before it resets handlers).
atexit.register(lambda: os.write(2, ("at exit: " + " ".join("ignored" if signal.getsignal(each) == signal.SIG_IGN else "not ignored"
                                                            for each in (signal.SIGINT, signal.SIGQUIT)) + "\\n").encode()))
cli = sys.argv[1]
sys.argv = ["herald-os", *sys.argv[2:]]
runpy.run_path(cli, run_name="__main__")
"""


@pytest.mark.parametrize("lsblk, args, code", [
    ("kill -INT $PPID\nsleep 5", ["password", "--disk"], 130),
    ("echo '{\"blockdevices\": []}'", ["password", "--disk"], cli.DISK_NOT_ENCRYPTED),
    ("echo '{\"blockdevices\": []}'", ["password", "--disk", "--status"], 0),
], ids=["a stop", "an error", "status"])
def test_password_disk_ignores_ctrl_c_and_ctrl_backslash_on_every_way_out(tmp_path, lsblk, args, code):
    """Python sets SIGINT back to its default as it shuts down, where one more Ctrl+C of a flood would
    end the command by SIGINT (-2) instead of its exit code: every way out ignores both first."""
    folder = tmp_path / "bin"
    folder.mkdir()
    (folder / "lsblk").write_text(f"#!/bin/sh\n{lsblk}\n")
    (folder / "findmnt").write_text("#!/bin/sh\nexit 1\n")
    for tool in ("lsblk", "findmnt"):
        (folder / tool).chmod(0o755)
    result = subprocess.run([sys.executable, "-c", EXIT_DRIVER, str(CLI), *args], capture_output=True, text=True, timeout=60,
                            env={**C_ENV, "PATH": f"{folder}:{C_ENV['PATH']}"})
    assert result.returncode == code, result
    assert "at exit: ignored ignored" in result.stderr, result.stderr


@needs_cryptsetup
def test_a_tight_flood_of_ctrl_c_at_the_current_password_prompt_is_a_stop(tmp_path):
    """Ctrl+C every 5 ms from the current password's prompt on: one stop (130), said once, every time;
    never an end by SIGINT (-2) from one that lands as the command shuts down."""
    if os.geteuid() == 0:
        pytest.skip("as root it asks sudo nothing")
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    for attempt in range(10):
        code, screen = converse([sys.executable, str(CLI), "password", "--disk"], env, list(CHANGE[:1]),
                                burst_after="Current disk password:", every=0.005, min_sent=1)
        assert code == 130 and "Traceback" not in screen, (attempt, code, screen[-500:])
        assert screen.count("stopped. Nothing was changed.") == 1, (attempt, screen[-500:])


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
    assert json.loads(status.stdout) == {"encrypted": False, "devices": [], "protection": None, "plainParts": [], "newOwner": False, "error": None}


def test_a_header_that_uses_cipher_null_encrypts_nothing():
    assert cli.luks_null_cipher({"segments": {"0": {"type": "crypt", "encryption": "cipher_null-ecb"}}})
    assert not cli.luks_null_cipher({"segments": {"0": {"type": "crypt", "encryption": "aes-xts-plain64"}}})
    assert not cli.luks_null_cipher({"segments": {"0": {"encryption": "cipher_null-ecb"}, "1": {"encryption": "aes-xts-plain64"}}})
    assert not cli.luks_null_cipher({})


ROOT_ON_LUKS = [{"name": "/dev/vda", "path": "/dev/vda", "type": "disk", "children": [
    {"name": "/dev/vda3", "path": "/dev/vda3", "type": "part", "fstype": "crypto_LUKS", "uuid": "luks-a", "children": [
        {"name": "/dev/mapper/root", "path": "/dev/mapper/root", "type": "crypt", "fstype": "ext4", "uuid": "fs", "mountpoints": ["/"]}]}]},
    {"name": "/dev/vdb", "path": "/dev/vdb", "type": "disk", "children": [
        {"name": "/dev/vdb1", "path": "/dev/vdb1", "type": "part", "fstype": "jbd", "uuid": "j", "mountpoints": [None]},
        {"name": "/dev/vdb2", "path": "/dev/vdb2", "type": "part", "fstype": "LVM2_member", "children": [
            {"name": "/dev/mapper/vg-journal", "path": "/dev/mapper/vg-journal", "type": "lvm", "fstype": "jbd", "mountpoints": [None]}]}]},
    {"name": "/dev/vdc", "path": "/dev/vdc", "type": "disk", "children": [
        {"name": "/dev/vdc1", "path": "/dev/vdc1", "type": "part", "fstype": "crypto_LUKS", "uuid": "luks-c", "children": [
            {"name": "/dev/mapper/log", "path": "/dev/mapper/log", "type": "crypt", "fstype": "xfs_external_log", "mountpoints": [None]}]}]}]
BY_NAME = {"/dev/mapper/root": "/dev/dm-0", "/dev/mapper/log": "/dev/dm-1", "/dev/mapper/vg-journal": "/dev/dm-2"}


def resolved_tree() -> list:
    """ROOT_ON_LUKS with each mapping's path as the kernel names it (/dev/dm-N), as realpath gives."""
    def walk(node):
        return {**node, "path": BY_NAME.get(node["path"], node["path"]), "children": [walk(child) for child in node.get("children", [])]}
    return [walk(disk) for disk in ROOT_ON_LUKS]


@pytest.mark.parametrize("mount, journals, plain", [
    ({"source": "/dev/mapper/root", "fstype": "xfs", "options": "rw,logdev=/dev/vdb1,noquota"}, [], [("/dev/vdb1", "log")]),
    ({"source": "/dev/mapper/root", "fstype": "xfs", "options": "rw,rtdev=/dev/vdb1"}, [], [("/dev/vdb1", "realtime")]),
    ({"source": "/dev/mapper/root", "fstype": "xfs", "options": "rw,logdev=/dev/mapper/log"}, [], []),
    ({"source": "/dev/mapper/root", "fstype": "xfs", "options": "rw,relatime"}, [], []),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["vdb1"], [("/dev/vdb1", "journal")]),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["dm-0-8", "vdb1"], []),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["dm-1"], []),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["dm-2"], [("/dev/dm-2", "journal")]),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["sdz1"], []),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, ["vdb2-8", "dm-1-8", "vdb1"], [("/dev/vdb1", "journal")]),
    ({"source": "/dev/mapper/root", "fstype": "ext4", "options": "rw"}, [], []),
    ({"source": "/dev/mapper/root", "fstype": "btrfs", "options": "rw"}, ["vdb1"], []),
], ids=["xfs log on a plain disk", "xfs realtime on a plain disk", "xfs log on LUKS", "xfs log inside", "ext4 journal on a plain disk",
        "ext4 journal inside", "ext4 journal on LUKS", "ext4 journal on plain LVM", "ext4 journal lsblk does not know",
        "ext4 journal beside others' own journals",
        "ext4 without a journal", "btrfs"])
def test_the_parts_of_the_root_outside_luks(mount, journals, plain):
    """The journal or log of the root filesystem on a device outside LUKS: written in the clear."""
    assert cli.disk_plain_parts(mount, resolved_tree(), journals, lambda device: BY_NAME.get(device, device)) == [
        {"device": device, "kind": kind} for device, kind in plain]


def status_here(monkeypatch, tmp_path, mount: dict | None, journals: list[str], cipher_null: bool | None = None) -> tuple[str, list[dict]]:
    folder = tmp_path / "jbd2"
    folder.mkdir(parents=True)
    for entry in journals:
        (folder / entry).mkdir()
    monkeypatch.setattr(cli, "DISK_JBD2", folder)
    monkeypatch.setattr(cli, "disk_root_mount", lambda: mount)
    monkeypatch.setattr(cli, "lsblk_tree", resolved_tree)
    monkeypatch.setattr(cli, "luks_cipher_null", lambda device: cipher_null)
    return cli.disk_protection(["/dev/vda3"])


def test_a_root_whose_journal_or_log_is_on_a_plain_disk_is_partly_protected(monkeypatch, tmp_path):
    root = {"source": "/dev/dm-0", "fstype": "ext4", "options": "rw"}
    assert status_here(monkeypatch, tmp_path / "a", root, ["vdb1"]) == ("partial", [{"device": "/dev/vdb1", "kind": "journal"}])
    assert status_here(monkeypatch, tmp_path / "b", {**root, "fstype": "xfs", "options": "rw,logdev=/dev/vdb1"}, []) == (
        "partial", [{"device": "/dev/vdb1", "kind": "log"}])
    assert status_here(monkeypatch, tmp_path / "c", root, ["dm-0-8", "vdb1"]) == ("full", [])
    assert status_here(monkeypatch, tmp_path / "d", root, [], cipher_null=True) == ("partial", [{"device": "/dev/vda3", "kind": "cipher_null"}])
    assert status_here(monkeypatch, tmp_path / "e", root, [], cipher_null=False) == ("full", [])


def test_a_root_whose_mount_cannot_be_read_counts_as_fully_protected(monkeypatch, tmp_path):
    """findmnt failed, so its journal or log cannot be looked at: no warning, rather than a guess; a
    cipher_null header still shows."""
    assert status_here(monkeypatch, tmp_path / "a", None, ["vdb1"]) == ("full", [])
    assert status_here(monkeypatch, tmp_path / "b", None, ["vdb1"], cipher_null=True) == ("partial", [{"device": "/dev/vda3", "kind": "cipher_null"}])


def test_a_root_lsblk_cannot_list_counts_as_fully_protected(monkeypatch, tmp_path):
    status_here(monkeypatch, tmp_path, {"source": "/dev/dm-0", "fstype": "ext4", "options": "rw"}, ["vdb1"])

    def unknown():
        raise cli.DiskUnknown("lsblk could not list the disks")

    monkeypatch.setattr(cli, "lsblk_tree", unknown)
    assert cli.disk_protection(["/dev/vda3"]) == ("full", [])


def make_luks1_image(path: Path, passphrase: str, cipher: str = "aes") -> Path:
    """A LUKS1 image; with another cipher written into its header's 32-byte cipher name (offset 8), which
    luksDump reads as it is, as luksFormat with cipher_null needs a loop device."""
    path.write_bytes(b"")
    os.truncate(path, 16 * 1024 * 1024)
    subprocess.run([CRYPTSETUP, "luksFormat", "-q", "--type", "luks1", "--pbkdf-force-iterations", "1000", "--key-file=-", str(path)],
                   input=passphrase.encode(), check=True, env=C_ENV)
    if cipher != "aes":
        with open(path, "r+b") as image:
            image.seek(8)
            image.write(cipher.encode().ljust(32, b"\0"))
    return path


def test_a_luks1_header_that_uses_cipher_null_encrypts_nothing():
    assert cli.luks1_null_cipher("LUKS header information\n\nVersion:       \t1\nCipher name:   \tcipher_null\nCipher mode:   \tecb\n") is True
    assert cli.luks1_null_cipher("Version:       \t1\nCipher name:   \taes\n") is False
    assert cli.luks1_null_cipher("Version:       \t2\nCipher name:   \tcipher_null\n") is None
    assert cli.luks1_null_cipher("") is None


@needs_cryptsetup
def test_a_luks1_device_that_uses_cipher_null_is_found(tmp_path):
    """LUKS1 has no JSON header: its cipher comes from luksDump's text."""
    assert cli.luks_cipher_null(str(make_luks1_image(tmp_path / "aes.img", OLD))) is False
    assert cli.luks_cipher_null(str(make_luks1_image(tmp_path / "null.img", OLD, "cipher_null"))) is True
    assert cli.luks_cipher_null(str(make_image(tmp_path / "luks2.img", OLD))) is False


@needs_cryptsetup
def test_status_of_a_root_on_real_and_cipher_null_luks_names_only_the_cipher_null_one(tmp_path):
    """A root over two LUKS devices, one LUKS2 that encrypts and one LUKS1 with cipher_null: encrypted (the
    computer asks for the password), partly protected, and only the cipher_null one named."""
    real, null = make_image(tmp_path / "real.img", OLD), make_luks1_image(tmp_path / "null.img", OLD, "cipher_null")
    env = fake_tools(tmp_path / "bin", real, null)
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env, timeout=60)
    assert json.loads(status.stdout) == {"encrypted": True, "devices": [str(real), str(null)], "protection": "partial",
                                         "plainParts": [{"device": str(null), "kind": "cipher_null"}], "newOwner": False, "error": None}, status


def test_status_of_an_ext4_root_on_luks_with_its_journal_on_a_plain_disk(monkeypatch, tmp_path, capsys):
    """The root is on LUKS, so the computer asks for its password: encrypted, but partly protected, with
    the journal on its plain device named."""
    folder = tmp_path / "jbd2"
    (folder / "vdb1").mkdir(parents=True)
    monkeypatch.setattr(cli, "DISK_JBD2", folder)
    monkeypatch.setattr(cli, "lsblk_tree", resolved_tree)
    monkeypatch.setattr(cli, "disk_root_uuid", lambda: "fs")
    monkeypatch.setattr(cli, "disk_root_mount", lambda: {"source": "/dev/dm-0", "fstype": "ext4", "options": "rw,relatime"})
    monkeypatch.setattr(cli, "luks_cipher_null", lambda device: None)
    monkeypatch.setattr(cli, "NEW_OWNER_MARK", tmp_path / "new-owner")
    assert cli.disk_password(["--status"]) == 0
    assert json.loads(capsys.readouterr().out) == {"encrypted": True, "devices": ["/dev/vda3"], "protection": "partial",
                                                   "plainParts": [{"device": "/dev/vdb1", "kind": "journal"}], "newOwner": False, "error": None}


HOME_MOUNTS = [{"target": "/", "source": "/dev/dm-0", "fstype": "ext4", "uuid": "fs", "options": "rw,relatime"}]


def findmnt_listing(stand_ins: Path, mounts: list[dict]) -> None:
    """A findmnt that lists these mounts, with their options only when asked for OPTIONS, as it does."""
    bare = [{key: value for key, value in mount.items() if key != "options"} for mount in mounts]
    (stand_ins / "findmnt").write_text(f"#!/bin/sh\ncase \"$*\" in *OPTIONS*) echo '{json.dumps({'filesystems': mounts})}';; "
                                   f"*) echo '{json.dumps({'filesystems': bare})}';; esac\n")
    (stand_ins / "findmnt").chmod(0o755)


def test_a_keyring_on_a_filesystem_that_writes_part_of_itself_in_the_clear_is_not_on_an_encrypted_disk():
    """keyring_mounts_encrypted with a plain(mount, disks) that says the filesystem is only partly
    protected: False, as a keyring there needs a password of its own; unchanged without one, or where
    it could not be told anyway."""
    tree = resolved_tree()
    assert cli.keyring_mounts_encrypted("/home/ana/.local/share/keyrings", HOME_MOUNTS, tree) is True
    assert cli.keyring_mounts_encrypted("/home/ana/.local/share/keyrings", HOME_MOUNTS, tree, plain=lambda mount, disks: False) is True
    seen = []
    assert cli.keyring_mounts_encrypted("/home/ana/.local/share/keyrings", HOME_MOUNTS, tree,
                                        plain=lambda mount, disks: seen.append((mount["target"], sorted(disks))) or True) is False
    assert seen == [("/", ["/dev/dm-0"])]
    assert cli.keyring_mounts_encrypted("/tmp/x", [{"target": "/tmp", "source": "tmpfs", "fstype": "tmpfs"}], tree, plain=lambda mount, disks: True) is None


@pytest.mark.parametrize("journals, cipher_null, options, encrypted", [
    (["dm-0-8"], False, "rw", True),
    (["vdb1"], False, "rw", False),
    (["dm-0-8"], True, "rw", False),
    ([], False, "rw,logdev=/dev/vdb1", True),
], ids=["encrypted throughout", "its journal on a plain disk", "cipher_null", "a log option ext4 does not have"])
def test_the_keyring_s_disk_counts_partial_protection_as_not_encrypted(monkeypatch, tmp_path, journals, cipher_null, options, encrypted):
    """keyring_encrypted on this machine, as --status's protection would call it: a home on LUKS whose
    journal is on a plain disk, or whose LUKS uses cipher_null, does not protect the keyring."""
    folder = tmp_path / "jbd2"
    folder.mkdir()
    for entry in journals:
        (folder / entry).mkdir()
    stand_ins = tmp_path / "bin"
    stand_ins.mkdir()
    findmnt_listing(stand_ins, [{**HOME_MOUNTS[0], "options": options}])
    monkeypatch.setenv("PATH", f"{stand_ins}:{os.environ['PATH']}")
    monkeypatch.setattr(cli, "DISK_JBD2", folder)
    monkeypatch.setattr(cli, "lsblk_tree", resolved_tree)
    asked = []
    monkeypatch.setattr(cli, "luks_cipher_null", lambda device: asked.append(device) or cipher_null)
    assert cli.keyring_encrypted(Path("/home/ana/.local/share/keyrings")) is encrypted
    assert "/dev/vda3" in asked


def test_the_keyring_s_xfs_disk_with_its_log_on_a_plain_disk_is_not_encrypted(monkeypatch, tmp_path):
    stand_ins = tmp_path / "bin"
    stand_ins.mkdir()
    findmnt_listing(stand_ins, [{**HOME_MOUNTS[0], "fstype": "xfs", "options": "rw,logdev=/dev/vdb1"}])
    monkeypatch.setenv("PATH", f"{stand_ins}:{os.environ['PATH']}")
    monkeypatch.setattr(cli, "DISK_JBD2", tmp_path / "none")
    monkeypatch.setattr(cli, "lsblk_tree", resolved_tree)
    monkeypatch.setattr(cli, "luks_cipher_null", lambda device: False)
    assert cli.keyring_encrypted(Path("/home/ana/.local/share/keyrings")) is False


@needs_cryptsetup
def test_status_stays_encrypted_and_full_when_findmnt_fails(tmp_path):
    """findmnt fails, so the root's journal or log cannot be looked at: still encrypted, as LUKS asks for
    the password, and no warning rather than a guess."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    (tmp_path / "bin" / "findmnt").write_text("#!/bin/sh\n[ \"$1\" = -J ] && { echo 'findmnt: cannot read' >&2; exit 1; }\n[ \"$5\" = /sysroot ] && echo fs-t\n")
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env, timeout=60)
    assert json.loads(status.stdout) == {"encrypted": True, "devices": [str(disk)], "protection": "full", "plainParts": [], "newOwner": False,
                                         "error": None}, status


@needs_cryptsetup
def test_status_reads_cipher_null_from_the_header(tmp_path):
    """--status of a root on LUKS that encrypts nothing (cipher_null): still encrypted (LUKS asks for its
    password at start-up, which setup lets a new owner change), but partly protected, with the device
    named. Its header is read as the person, where that works (here an image; a cryptsetup stand-in gives
    the cipher_null header, as luksFormat with cipher_null needs a loop device)."""
    disk = make_image(tmp_path / "disk.img", OLD)
    env = fake_tools(tmp_path / "bin", disk)
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env, timeout=60)
    assert json.loads(status.stdout) == {"encrypted": True, "devices": [str(disk)], "protection": "full", "plainParts": [], "newOwner": False,
                                         "error": None}, status
    header = {"keyslots": {"0": {}}, "segments": {"0": {"type": "crypt", "encryption": "cipher_null-ecb"}}}
    (tmp_path / "bin" / "cryptsetup").write_text(f"#!/bin/sh\necho '{json.dumps(header)}'\n")
    (tmp_path / "bin" / "cryptsetup").chmod(0o755)
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env, timeout=60)
    assert json.loads(status.stdout) == {"encrypted": True, "devices": [str(disk)], "protection": "partial",
                                         "plainParts": [{"device": str(disk), "kind": "cipher_null"}], "newOwner": False, "error": None}


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
    # The util-linux note only where lsblk's own words say the column is unknown.
    assert ("util-linux 2.37 or later is needed" in result.stderr) == ("unknown column" in lsblk)
    status = subprocess.run([sys.executable, str(CLI), "password", "--disk", "--status"], capture_output=True, text=True, env=env)
    state = json.loads(status.stdout)
    assert status.returncode == 0 and state["encrypted"] is None and state["devices"] == [] and "lsblk" in state["error"]


@pytest.mark.parametrize("flags", [["--disk", "--status"], ["--disk"], ["--disk", "--new-owner"]])
def test_without_lsblk_at_all_it_says_so_without_a_traceback(tmp_path, flags):
    """No lsblk on PATH (nor findmnt or sudo): a plain refusal, and --status still answers in JSON."""
    empty = tmp_path / "empty"
    empty.mkdir()
    result = subprocess.run([sys.executable, str(CLI), "password", *flags], capture_output=True, text=True,
                            env={"PATH": str(empty), "HOME": str(tmp_path)}, stdin=subprocess.DEVNULL)
    assert "Traceback" not in result.stderr and "FileNotFoundError" not in result.stderr
    if "--status" in flags:
        assert result.returncode == 0
        state = json.loads(result.stdout)
        assert state["encrypted"] is None and state["error"] == "lsblk is not installed (it comes with util-linux)"
    else:
        assert result.returncode == cli.DISK_UNKNOWN
        assert "lsblk is not installed" in result.stderr and "Nothing was changed" in result.stderr


def test_the_util_linux_note_is_only_for_an_old_lsblk():
    assert cli.lsblk_version_hint("lsblk: unknown column: MOUNTPOINTS\n") == " (util-linux 2.37 or later is needed)"
    assert cli.lsblk_version_hint("lsblk: Unknown column: MOUNTPOINTS") != ""
    for other in ("", "lsblk: failed to access sysfs directory: /sys/dev/block: No such file or directory", "Segmentation fault"):
        assert cli.lsblk_version_hint(other) == ""


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
