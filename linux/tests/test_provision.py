"""linux/provision.sh refuses to run outside the development VM: it carries on only in a virtual
machine with the cloud-init seed attached (labelled cidata, in any case), or when given --dev-vm,
and otherwise exits before it writes anything. The script runs from a temporary payload folder with stand-ins for
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


def provision(tmp_path: Path, *args: str, vm: bool, seed: bool, labels: tuple[str, ...] | None = None,
              uid: int = 0, account: str | None = "hermes", env: dict | None = None) -> tuple[subprocess.CompletedProcess, list[str]]:
    """Runs provision.sh; `labels` are the filesystem labels blkid reports (cidata when `seed`, plus
    the root disk's)."""
    payload = tmp_path / "payload"
    payload.mkdir(exist_ok=True)
    shutil.copy(PROVISION, payload / "provision.sh")
    calls = tmp_path / "calls"
    calls.write_text("")
    bin_dir = tmp_path / "bin"
    labels = ("fedora", *(labels if labels is not None else ("cidata",) if seed else ()))
    executable(bin_dir / "systemd-detect-virt", f'echo "systemd-detect-virt $*" >>"$CALLS"; [ "$*" = "--quiet --vm" ] && exit {0 if vm else 1}; exit 2')
    executable(bin_dir / "blkid", f'echo "blkid $*" >>"$CALLS"; [ "$*" = "-s LABEL -o value" ] && {{ printf "%s\\n" {" ".join(labels)}; exit 0; }}; exit 2')
    executable(bin_dir / "id", f'echo "id $*" >>"$CALLS"; [ "$*" = -u ] && echo {uid}')
    # getent's answer when the account is missing: nothing, and exit 2.
    executable(bin_dir / "getent", f'echo "getent $*" >>"$CALLS"; [ "$*" = "passwd {account}" ] || exit 2; echo "$2:x:1000:1000::/home/$2:/bin/bash"')
    executable(bin_dir / "mkdir", 'echo "mkdir $*" >>"$CALLS"')
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
    return [call for call in calls if not call.startswith(("systemd-detect-virt ", "blkid ", "id "))]


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


def test_the_explanation_gives_the_command_to_run_it_again_with_the_path_quoted(tmp_path):
    result, _ = provision(tmp_path, vm=False, seed=False)
    assert f'sudo bash "{tmp_path / "payload" / "provision.sh"}" --dev-vm' in result.stderr


def test_the_header_says_how_to_re_run_it_with_and_without_the_seed():
    header = PROVISION.read_text().split("set -euo pipefail", 1)[0]
    reruns = re.findall(r"^#\s+sudo bash (\S+provision\.sh)(.*?)\s+#", header, re.M)
    assert [(path, flag.strip()) for path, flag in reruns] == [
        ("/usr/local/share/herald-os-linux/provision.sh", ""),
        ("/usr/local/share/herald-os-linux/provision.sh", "--dev-vm"),
    ]


def test_in_a_vm_with_the_seed_attached_it_provisions(tmp_path):
    result, calls = provision(tmp_path, vm=True, seed=True)
    assert "mkdir -p /var/lib/herald-os" in calls
    assert "packages.sh --dev" in calls
    assert "Nothing has been changed" not in result.stderr


@pytest.mark.parametrize("label", ["cidata", "CIDATA", "CiData"])
def test_the_seed_label_is_matched_in_any_case(tmp_path, label):
    result, calls = provision(tmp_path, vm=True, seed=True, labels=(label,))
    assert "packages.sh --dev" in calls
    assert "Nothing has been changed" not in result.stderr


@pytest.mark.parametrize("label", ["cidata2", "my-cidata", "cidat"])
def test_only_the_whole_seed_label_counts(tmp_path, label):
    result, calls = provision(tmp_path, vm=True, seed=True, labels=(label,))
    assert result.returncode == 1
    assert changes(calls) == []
    assert "Nothing has been changed" in result.stderr


def test_dev_vm_provisions_without_looking(tmp_path):
    result, calls = provision(tmp_path, "--dev-vm", vm=False, seed=False)
    assert "packages.sh --dev" in calls
    assert not any(call.startswith(("systemd-detect-virt ", "blkid ")) for call in calls)
    assert "Nothing has been changed" not in result.stderr


@pytest.mark.parametrize("user, env", [("hermes", None), ("someone", {"HERMES_USER": "someone"})])
def test_a_missing_account_is_explained_before_anything_is_written(tmp_path, user, env):
    result, calls = provision(tmp_path, vm=True, seed=True, account=None, env=env)
    assert result.returncode == 1
    assert f"there is no account named '{user}'" in result.stderr
    assert "Nothing has been changed" in result.stderr
    assert changes(calls) == [f"getent passwd {user}"]


def test_the_account_named_by_hermes_user_is_the_one_looked_up(tmp_path):
    result, calls = provision(tmp_path, vm=True, seed=True, account="someone", env={"HERMES_USER": "someone"})
    assert "getent passwd someone" in calls
    assert "packages.sh --dev" in calls


@pytest.mark.parametrize("args", [(), ("--dev-vm",)], ids=["looking", "--dev-vm"])
def test_without_root_it_stops_first_and_says_so(tmp_path, args):
    result, calls = provision(tmp_path, *args, vm=True, seed=True, uid=1000)
    assert result.returncode == 1
    assert result.stderr == "provision.sh: run it as root, with sudo. Nothing has been changed.\n"
    assert calls == ["id -u"]


@pytest.mark.parametrize("arg", ["--dev", "--dev-vm=1", "now"])
def test_an_unknown_argument_is_refused_before_anything_is_written(tmp_path, arg):
    result, calls = provision(tmp_path, "--dev-vm", arg, vm=True, seed=True)
    assert result.returncode == 2
    assert f"unknown argument '{arg}'" in result.stderr
    assert calls == []


def test_the_first_boot_passes_dev_vm():
    runcmd = re.findall(r"^  - \[bash, (\S+provision\.sh)(.*)\]$", MAKE_SEED.read_text(), re.M)
    assert runcmd == [("/usr/local/share/herald-os-linux/provision.sh", ", --dev-vm")]
