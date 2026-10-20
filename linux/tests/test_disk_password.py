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
    # Nothing to take back from a device the new password does not open; the old one is never touched.
    assert calls == [("luksAddKey", OLD)]
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
@pytest.mark.parametrize("new_owner", [False, True])
def test_the_old_password_also_in_a_token_s_slot_is_refused_and_both_stay(tmp_path, new_owner):
    """The current password in plain slot 0 and in the recovery token's slot 1: a change would remove both."""
    first = with_token_slot(tmp_path, make_image(tmp_path / "a.img", OLD), OLD, "systemd-recovery")
    before = dump(first)
    result = root_side("change", {"devices": [str(first)], "current": OLD, "new": NEW, "newOwner": new_owner})
    assert result.returncode == cli.DISK_RECOVERY_KEY, result.stderr
    assert "also opens key slot 1" in result.stderr and "Nothing was changed" in result.stderr
    assert dump(first) == before


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
    # As root the command asks sudo nothing, so there is no sudo prompt to wait for.
    pending = [answer for answer in answers if not (os.geteuid() == 0 and answer[0].startswith("[sudo]"))]
    screen, deadline = "", time.monotonic() + timeout
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
    SIGINT to the root side alone that long after starting it, as if only it were stopped."""
    env = fake_tools(tmp_path / "bin", disk)
    killer = f'( sleep {stop_root_after}; pkill -INT -f -- "--disk-root {op}" ) & ' if stop_root_after else ""
    (tmp_path / "bin" / "sudo").write_text(
        "#!/usr/bin/env bash\n"
        "if [[ $1 == -v ]]; then printf '%s' \"${3/\\%p/$USER}\" >/dev/tty; IFS= read -rs answer </dev/tty; echo >/dev/tty; [[ $answer == account-pass ]]; exit; fi\n"
        "[[ $1 == -n ]] && shift\n"
        f'case "$*" in *"--disk-root {op}"*) export SLOW=1; {killer};; esac\n'
        "exec \"$@\"\n")
    (tmp_path / "bin" / "cryptsetup").write_text(f'#!/bin/sh\n[ -n "$SLOW" ] && [ "$1" = open ] && {{ echo SLOW-CHECK >/dev/tty; sleep 3; }}\nexec {CRYPTSETUP} "$@"\n')
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
    env = slow_root_side(tmp_path, disk, op, stop_root_after=1)
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
    header = {"keyslots": dict(keyslots), "tokens": dict(tokens or {})}
    tried: list[int] = []

    def run(args, key=None, new=None):
        ok = subprocess.CompletedProcess(args, 0, b"Command successful.\n", b"")
        no = subprocess.CompletedProcess(args, 2, b"", b"No key available with this passphrase.")
        slots = header["keyslots"]
        if args[0] == "open":
            if "--key-slot" in args:
                slot = int(args[args.index("--key-slot") + 1])
                tried.append(slot)
                return ok if named_by_slot and key not in hidden and slots.get(slot) == key else no
            return ok if key in slots.values() else no
        if args[0] == "luksDump":
            return subprocess.CompletedProcess(args, 0, json.dumps({"keyslots": {str(n): {} for n in slots}, "tokens": header["tokens"]}).encode(), b"")
        if args[0] == "luksAddKey":
            slots[min(set(range(32)) - set(slots))] = new
            if on_add:
                on_add(header)
            return ok
        if args[0] == "luksRemoveKey":
            slot = next((n for n, value in sorted(slots.items()) if value == key), None)
            if slot is None:
                return no
            del slots[slot]
            return ok
        if args[0] == "luksKillSlot":
            slots.pop(int(args[2]), None)
            return ok
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
    assert "A rerun cannot tell the new password's key slot either" in said and "luksKillSlot <device> <slot>" in said
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


@pytest.mark.parametrize("code", [0, 1, 2, 3, 4, 6, 8, 9, 10, 11, 12, 13, 127, 130])
def test_every_end_the_root_side_says_itself_is_passed_on_without_looking(monkeypatch, tmp_path, code):
    """A code in DISK_ENDS (the refusals 9 to 13 among them) is the root side's own word; only another
    end, a killed root side, is looked at afterwards."""
    looked = tmp_path / "looked"
    argv = {"change": ["sh", "-c", f"cat >/dev/null; exit {code}"], "probe": ["sh", "-c", f"touch {looked}; echo '{{}}'"]}
    monkeypatch.setattr(cli, "disk_root_argv", lambda op: argv[op])
    assert cli.disk_helper("change", {"devices": ["/dev/vda3"], "current": OLD, "new": NEW}) == code
    assert not looked.exists()


def test_the_refusals_are_all_ends_the_root_side_says_itself():
    assert {cli.DISK_RECOVERY_KEY, cli.DISK_TPM_SLOT, cli.DISK_FIDO2_SLOT, cli.DISK_OTHER_SLOT, cli.DISK_NEW_IS_OTHER_KEY} <= cli.DISK_ENDS
    assert {9, 10, 11, 12, 13} <= cli.DISK_ENDS


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
