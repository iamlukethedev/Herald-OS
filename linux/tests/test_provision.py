"""linux/provision.sh refuses to run outside the development VM: it carries on only in a virtual
machine with the cloud-init seed attached, or when given --dev-vm, and otherwise exits before it
writes anything. The script runs from a temporary payload folder with stand-ins for
systemd-detect-virt, blkid and everything that would change the machine; the stand-in packages.sh
writes down that it was reached and stops the run there."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROVISION = ROOT / "linux" / "provision.sh"
MAKE_SEED = ROOT / "linux" / "vm" / "make-seed.sh"


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


def provision(tmp_path: Path, *args: str, vm: bool, seed: bool, env: dict | None = None) -> tuple[subprocess.CompletedProcess, list[str]]:
    payload = tmp_path / "payload"
    payload.mkdir(exist_ok=True)
    shutil.copy(PROVISION, payload / "provision.sh")
    calls = tmp_path / "calls"
    calls.write_text("")
    bin_dir = tmp_path / "bin"
    executable(bin_dir / "systemd-detect-virt", f'echo "systemd-detect-virt $*" >>"$CALLS"; [ "$*" = "--quiet --vm" ] && exit {0 if vm else 1}; exit 2')
    executable(bin_dir / "blkid", f'echo "blkid $*" >>"$CALLS"; [ "$*" = "-L cidata" ] && {{ {"echo /dev/sr0; exit 0" if seed else "exit 2"}; }}; exit 2')
    for name in ("mkdir", "getent"):
        executable(bin_dir / name, f'echo "{name} $*" >>"$CALLS"')
    executable(bin_dir / "tee", 'echo "tee $*" >>"$CALLS"; exec cat')
    executable(payload / "image" / "packages.sh", 'echo "packages.sh $*" >>"$CALLS"; exit 1')
    result = subprocess.run(
        ["bash", str(payload / "provision.sh"), *args],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "CALLS": str(calls), **(env or {})},
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    return result, calls.read_text().splitlines()


def changes(calls: list[str]) -> list[str]:
    return [call for call in calls if not call.startswith(("systemd-detect-virt ", "blkid "))]


@pytest.mark.parametrize("vm, seed", [(False, False), (False, True), (True, False)], ids=["bare metal", "seed but no vm", "vm without the seed"])
def test_outside_the_development_vm_it_explains_and_changes_nothing(tmp_path, vm, seed):
    result, calls = provision(tmp_path, vm=vm, seed=seed)
    assert result.returncode == 1
    assert changes(calls) == []
    for promise in ("SELinux to permissive", "log hermes in automatically", "firewall zone", "sshd and seatd",
                    "initramfs", "kernel arguments", "Nothing has been changed", "--dev-vm"):
        assert promise in result.stderr
    assert "Provisioning FAILED" not in result.stdout + result.stderr


def test_the_explanation_names_the_account_it_would_log_in(tmp_path):
    result, calls = provision(tmp_path, vm=False, seed=False, env={"HERMES_USER": "someone"})
    assert result.returncode == 1
    assert "log someone in automatically" in result.stderr
    assert changes(calls) == []


def test_the_explanation_gives_the_command_to_run_it_again(tmp_path):
    result, _ = provision(tmp_path, vm=False, seed=False)
    assert f"sudo bash {tmp_path / 'payload' / 'provision.sh'} --dev-vm" in result.stderr


def test_in_a_vm_with_the_seed_attached_it_provisions(tmp_path):
    result, calls = provision(tmp_path, vm=True, seed=True)
    assert "mkdir -p /var/lib/herald-os" in calls
    assert "packages.sh --dev" in calls
    assert "Nothing has been changed" not in result.stderr


def test_dev_vm_provisions_without_looking(tmp_path):
    result, calls = provision(tmp_path, "--dev-vm", vm=False, seed=False)
    assert "packages.sh --dev" in calls
    assert not any(call.startswith(("systemd-detect-virt ", "blkid ")) for call in calls)
    assert "Nothing has been changed" not in result.stderr


@pytest.mark.parametrize("arg", ["--dev", "--dev-vm=1", "now"])
def test_an_unknown_argument_is_refused_before_anything_is_written(tmp_path, arg):
    result, calls = provision(tmp_path, "--dev-vm", arg, vm=True, seed=True)
    assert result.returncode == 2
    assert f"unknown argument '{arg}'" in result.stderr
    assert calls == []


def test_the_first_boot_passes_dev_vm():
    runcmd = re.findall(r"^  - \[bash, (\S+provision\.sh)(.*)\]$", MAKE_SEED.read_text(), re.M)
    assert runcmd == [("/usr/local/share/herald-os-linux/provision.sh", ", --dev-vm")]
