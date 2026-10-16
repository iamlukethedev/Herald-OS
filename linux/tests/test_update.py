"""herald-os-update on the Herald OS image: bootc, or rpm-ostree once packages are layered, and Flatpaks that fail one by one."""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
UPDATE = ROOT / "linux" / "bin" / "herald-os-update"

# What a deployment adds to the image, as `rpm-ostree status --json` reports it. The requested-* keys
# come from the origin as names; what rpm-ostree derived comes from GVariant tuples:
# [nevra, name, epoch, version, release, arch], a replacement being a pair of them, the new one first.
FIREFOX = ["firefox-131.0-1.fc44.x86_64", "firefox", "0", "131.0", "1.fc44", "x86_64"]
MESA = ["mesa-dri-drivers-25.0-2.fc44.x86_64", "mesa-dri-drivers", "0", "25.0", "2.fc44", "x86_64"]
MESA_OLD = ["mesa-dri-drivers-25.0-1.fc44.x86_64", "mesa-dri-drivers", "0", "25.0", "1.fc44", "x86_64"]
KERNEL = ["kernel-6.17.1-300.fc44.x86_64", "kernel", "0", "6.17.1", "300.fc44", "x86_64"]
KERNEL_OLD = ["kernel-6.16.9-300.fc44.x86_64", "kernel", "0", "6.16.9", "300.fc44", "x86_64"]
CHANGES = {
    "requested-packages": (["htop", "vim-enhanced"], "layered: htop, vim-enhanced"),
    "requested-local-packages": (["mytool-1.0-1.x86_64"], "local: mytool-1.0-1.x86_64"),
    "requested-local-fileoverride-packages": (["myfix-2.0-1.x86_64"], "local: myfix-2.0-1.x86_64"),
    "requested-modules": (["nodejs:22/default"], "modules: nodejs:22/default"),
    "requested-modules-enabled": (["nodejs:22"], "modules: nodejs:22"),
    "requested-base-removals": (["firefox", "firefox-langpacks"], "removed: firefox, firefox-langpacks"),
    "requested-base-local-replacements": (["mesa-dri-drivers-25.0-2.fc44.x86_64"], "replaced: mesa-dri-drivers-25.0-2.fc44.x86_64"),
    "requested-base-remote-replacements": (
        [["repo=updates-testing", ["kernel", "kernel-core"]]],
        "replaced: kernel from repo=updates-testing, kernel-core from repo=updates-testing",
    ),
    "packages": (["htop"], "layered: htop"),
    "base-removals": ([FIREFOX], "removed: firefox-131.0-1.fc44.x86_64"),
    "base-local-replacements": ([[MESA, MESA_OLD]], "replaced: mesa-dri-drivers-25.0-2.fc44.x86_64"),
    "base-remote-replacements": ({"repo=updates-testing": [[KERNEL, KERNEL_OLD]]}, "replaced: kernel-6.17.1-300.fc44.x86_64 from repo=updates-testing"),
    "regenerate-initramfs": (True, "initramfs: regenerated"),
    "initramfs-etc": (["/etc/crypttab"], "initramfs: /etc/crypttab"),
}
# Every key rpm-ostree reports, empty, as it reports them for the image as built.
CLEAN = {key: {} if key == "base-remote-replacements" else False if key == "regenerate-initramfs" else [] for key in CHANGES}
GOOD, BROKEN = "app/org.example.Good/x86_64/stable", "app/org.example.Broken/x86_64/stable"
SYSTEM_APP = "app/org.example.System/x86_64/stable"

STUBS = {
    "herald-os": 'echo "$@" >>"$HOME/herald-os.log"',
    # With ~/no-sudo, sudo needs a password: `sudo -n` fails, and plain sudo (in a terminal) gets one.
    "sudo": """echo "sudo $*" >>"$HOME/calls.log"
if [ "$1" = -n ]; then
  shift
  if [ -e "$HOME/no-sudo" ]; then
    echo "sudo: a password is required" >&2
    exit 1
  fi
else
  echo "asked for a password: $*" >>"$HOME/sudo.log"
fi
exec "$@\"""",
    # Like bootc, refuses when the booted or the staged deployment has local changes.
    "bootc": """echo "bootc $*" >>"$HOME/calls.log"
if [ -s "$HOME/layered" ]; then
  echo "error: Upgrading: Deployment contains local rpm-ostree modifications; cannot upgrade via bootc" >&2
  exit 1
fi
[ "$2" = --check ] && echo "Update available"
exit 0""",
    "rpm-ostree": """[ "$1" = status ] && exec cat "$HOME/status.json"
echo "rpm-ostree $*" >>"$HOME/calls.log"
exit "$(cat "$HOME/rpm-ostree-exit" 2>/dev/null || echo 0)\"""",
    # The user installation's refs are in ~/refs, the system one's in ~/system-refs. Updating a whole
    # installation fails when one of its refs is in ~/broken-refs, and so does updating that ref alone.
    "flatpak": """echo "flatpak $*" >>"$HOME/calls.log"
refs="$HOME/refs"
case " $* " in *" --system "*) refs="$HOME/system-refs" ;; esac
case "$1" in
  list) cat "$refs" 2>/dev/null ;;
  remote-ls) ;;
  update)
    if [ -e "$HOME/remote-down" ]; then
      echo "error: Unable to load summary from remote flathub: Could not resolve hostname" >&2
      exit 1
    fi
    for arg in "$@"; do last="$arg"; done
    if [ "$last" = --user ] || [ "$last" = --system ]; then
      if [ -s "$HOME/broken-refs" ] && grep -qxFf "$HOME/broken-refs" "$refs" 2>/dev/null; then
        echo "Error: Failed to update some refs" >&2
        exit 1
      fi
      echo "Updated everything $last" >>"$HOME/updated.log"
      exit 0
    fi
    if grep -qx "$last" "$HOME/broken-refs" 2>/dev/null; then
      echo "Looking for updates..." >&2
      echo "error: Failed to install $last: No space left on device" >&2
      exit 1
    fi
    echo "Updated $last" >>"$HOME/updated.log"
    ;;
esac""",
}


@pytest.fixture
def machine(tmp_path):
    """The Herald OS image with every command herald-os-update runs stood in for."""
    stubs, home, repo = tmp_path / "stubs", tmp_path / "home", tmp_path / "checkout"
    # ~/Herald-OS is the checkout when HERALD_OS_REPO does not count (as root without the testing
    # flag); without it the updater would fall back to this repository's own migrations.
    for folder in (stubs, home, repo / "linux" / "migrations", home / "Herald-OS" / "linux" / "migrations"):
        folder.mkdir(parents=True)
    for name, body in STUBS.items():
        (stubs / name).write_text(f"#!/bin/sh\n{body}\n")
        (stubs / name).chmod(0o755)
    (tmp_path / "ostree-booted").write_text("")
    (tmp_path / "app.asar").write_text("")
    (home / "refs").write_text(f"{GOOD}\n{BROKEN}\n")
    env = {
        "HOME": str(home),
        "HERALD_OS_REPO": str(repo),
        "HERALD_OS_OSTREE_BOOTED": str(tmp_path / "ostree-booted"),
        "HERALD_OS_IMAGE_SHELL": str(tmp_path / "app.asar"),
        "HERALD_OS_TESTING": "1",
        "PATH": os.pathsep.join([str(stubs), "/usr/bin", "/bin"]),
    }
    deploy(home)
    return home, env


def deploy(home: Path, booted: dict | None = None, staged: dict | None = None, rollback: dict | None = None, staged_osname: str = "fedora") -> None:
    """The deployments: the booted one, and if given one staged for the next boot and a rollback one."""
    deployments = [{"id": "fedora-booted", "osname": "fedora", "booted": True, "staged": False, **CLEAN, **(booted or {})}]
    if staged is not None:
        deployments.insert(0, {"id": "fedora-staged", "osname": staged_osname, "booted": False, "staged": True, **CLEAN, **staged})
    if rollback is not None:
        deployments.append({"id": "fedora-rollback", "osname": "fedora", "booted": False, "staged": False, **CLEAN, **rollback})
    (home / "status.json").write_text(json.dumps({"deployments": deployments}))
    pending = staged if staged is not None and staged_osname == "fedora" else {}
    (home / "layered").write_text("1" if any((booted or {}).values()) or any(pending.values()) else "")


def run(env, *args, prefix=()):
    return subprocess.run([*prefix, "bash", str(UPDATE), "--no-hermes", *args], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)


def calls(home: Path) -> list[str]:
    log = home / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def ran(home: Path, command: str) -> bool:
    return any(call.startswith(command) for call in calls(home))


def summary(stdout: str) -> dict[str, str]:
    """The summary at the end: each step and what became of it."""
    lines = stdout.split("==> summary\n", 1)[1].splitlines()
    return dict(re.match(r"  (\S+)\s+(.*)", line).groups() for line in lines if re.match(r"  \S", line))


def test_the_image_as_built_upgrades_with_bootc(machine):
    home, env = machine
    done = run(env)
    assert done.returncode == 0, done.stderr
    assert "bootc upgrade" in calls(home)
    assert not ran(home, "rpm-ostree")
    assert summary(done.stdout)["system"] == "ok (bootc upgrade)"


@pytest.mark.parametrize("key", CHANGES)
def test_layered_overridden_or_local_packages_upgrade_with_rpm_ostree(machine, key):
    home, env = machine
    packages, described = CHANGES[key]
    deploy(home, booted={key: packages})
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "rpm-ostree upgrade" in calls(home)
    assert not ran(home, "bootc")
    assert f"packages of its own on top of the image ({described})" in done.stdout
    assert summary(done.stdout)["system"] == f"ok (rpm-ostree upgrade; {described})"


def test_what_was_requested_is_named_rather_than_what_rpm_ostree_made_of_it(machine):
    home, env = machine
    deploy(home, booted={"requested-base-removals": ["firefox"], "base-removals": [FIREFOX]})
    assert "packages of its own on top of the image (removed: firefox)" in run(env).stdout


def test_a_staged_deployment_with_layers_upgrades_with_rpm_ostree(machine):
    """After rpm-ostree install without a restart: bootc would upgrade the clean booted one and drop htop."""
    home, env = machine
    deploy(home, booted={}, staged={"requested-packages": ["htop"]})
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "rpm-ostree upgrade" in calls(home)
    assert not ran(home, "bootc")
    assert summary(done.stdout)["system"] == "ok (rpm-ostree upgrade; layered: htop (staged for the next restart))"


def test_the_staged_deployment_counts_rather_than_the_booted_one(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]}, staged={"requested-packages": ["htop", "vim-enhanced"]})
    done = run(env)
    assert "packages of its own on top of the image (layered: htop, vim-enhanced (staged for the next restart))" in done.stdout


def test_a_clean_staged_deployment_over_a_layered_booted_one_still_needs_rpm_ostree(machine):
    """bootc refuses when the booted deployment has changes too, even if the staged one drops them."""
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]}, staged={})
    done = run(env)
    assert "rpm-ostree upgrade" in calls(home)
    assert not ran(home, "bootc")
    assert "layered: htop (in the running system only; the next restart drops them)" in done.stdout


def test_a_pending_deployment_without_a_staged_field_counts(machine):
    """rpm-ostree status calls the first deployment of the booted OS pending when it is not the booted
    one, and rpm-ostree upgrade builds on it, whether or not it says staged."""
    home, env = machine
    pending = {"id": "fedora-pending", "osname": "fedora", "booted": False, **CLEAN, "requested-packages": ["htop"]}
    booted = {"id": "fedora-booted", "osname": "fedora", "booted": True, **CLEAN}
    (home / "status.json").write_text(json.dumps({"deployments": [pending, booted]}))
    (home / "layered").write_text("1")
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "rpm-ostree upgrade" in calls(home)
    assert not ran(home, "bootc")
    assert summary(done.stdout)["system"] == "ok (rpm-ostree upgrade; layered: htop (pending for the next restart))"


def test_a_pending_deployment_of_another_os_first_in_the_list_does_not_count(machine):
    home, env = machine
    other = {"id": "other-pending", "osname": "other", "booted": False, **CLEAN, "requested-packages": ["htop"]}
    booted = {"id": "fedora-booted", "osname": "fedora", "booted": True, **CLEAN}
    (home / "status.json").write_text(json.dumps({"deployments": [other, booted]}))
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)
    assert not ran(home, "rpm-ostree")


def test_two_kinds_of_change_are_joined_with_a_semicolon(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"], "requested-base-removals": ["firefox"]})
    assert "packages of its own on top of the image (layered: htop; removed: firefox)" in run(env).stdout


@pytest.mark.parametrize("changes", [
    {"initramfs-etc": ["/etc/crypttab"]},
    {"initramfs-etc": ["/etc/crypttab", "/etc/vconsole.conf"]},
    {"regenerate-initramfs": True},
    {"regenerate-initramfs": True, "initramfs-etc": ["/etc/crypttab"]},
], ids=["one-etc-file", "two-etc-files", "regenerate", "both"])
def test_an_initramfs_of_the_machine_s_own_counts(machine, changes):
    home, env = machine
    deploy(home, booted=changes)
    done = run(env)
    assert "rpm-ostree upgrade" in calls(home) and not ran(home, "bootc")
    assert "initramfs: " in summary(done.stdout)["system"]


def test_an_initramfs_as_built_does_not_count(machine):
    home, env = machine
    deploy(home, booted={"regenerate-initramfs": False, "initramfs-etc": []})
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home) and not ran(home, "rpm-ostree")


def test_a_rollback_deployment_does_not_count(machine):
    home, env = machine
    deploy(home, rollback={"requested-packages": ["htop"]})
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)
    assert not ran(home, "rpm-ostree")


def test_a_deployment_staged_for_another_os_does_not_count(machine):
    home, env = machine
    deploy(home, staged={"requested-packages": ["htop"]}, staged_osname="other")
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)
    assert not ran(home, "rpm-ostree")


def test_unreadable_rpm_ostree_status_falls_back_to_bootc(machine):
    home, env = machine
    (home / "status.json").write_text("not json")
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)


def test_the_check_asks_rpm_ostree_when_packages_are_layered(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    done = run(env, "--check")
    assert done.returncode == 0
    assert "rpm-ostree upgrade --check" in calls(home)
    assert not ran(home, "bootc")
    assert done.stdout.strip() == "1 package"


def test_a_failed_system_upgrade_fails_the_update(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    (home / "rpm-ostree-exit").write_text("1")
    done = run(env)
    assert done.returncode == 1
    assert summary(done.stdout)["system"] == "FAILED (rpm-ostree upgrade; layered: htop, exit 1)"
    assert "failed: system" in done.stderr
    assert summary(done.stdout)["flatpaks"] == "ok"


def test_a_broken_flatpak_is_named_and_does_not_fail_the_update(machine):
    home, env = machine
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    done = run(env)
    assert done.returncode == 0, done.stderr
    problem = f"{BROKEN}: Failed to install {BROKEN}: No space left on device"
    assert f"WARNING: flatpaks: {problem}" in done.stderr
    assert summary(done.stdout)["flatpaks"] == f"did not all update: {problem}"
    assert f"Updated {GOOD}" in (home / "updated.log").read_text()
    assert summary(done.stdout)["system"] == "ok (bootc upgrade)"
    assert "after-update problems=flatpaks" in (home / "herald-os.log").read_text()


def test_flatpaks_that_cannot_be_listed_report_the_whole_update_error(machine):
    home, env = machine
    (home / "remote-down").write_text("")
    (home / "refs").write_text("")
    done = run(env)
    assert done.returncode == 0
    assert summary(done.stdout)["flatpaks"] == "did not all update: Unable to load summary from remote flathub: Could not resolve hostname"


def test_system_flatpaks_update_as_root_and_are_reported_per_ref(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n{BROKEN}\n")
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    (home / "refs").write_text(f"{GOOD}\n")
    done = run(env)
    assert done.returncode == 0, done.stderr
    assert "flatpak update -y --noninteractive --system" in calls(home)
    assert f"flatpak update -y --noninteractive --system {SYSTEM_APP}" in calls(home)
    steps = summary(done.stdout)
    assert steps["flatpaks"] == "ok"
    assert steps["system-flatpaks"] == f"did not all update: {BROKEN}: Failed to install {BROKEN}: No space left on device"
    assert f"WARNING: system-flatpaks: {BROKEN}: Failed to install {BROKEN}: No space left on device" in done.stderr
    assert f"Updated {SYSTEM_APP}" in (home / "updated.log").read_text()
    assert "after-update problems=system-flatpaks" in (home / "herald-os.log").read_text()


def test_the_system_flatpak_pass_runs_through_sudo_n_and_the_user_pass_does_not(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    run(env)
    sudo = [call for call in calls(home) if call.startswith("sudo ")]
    assert "sudo -n true" in sudo
    assert "sudo -n flatpak update -y --noninteractive --system" in sudo
    assert "sudo -n bootc upgrade" in sudo
    assert not [call for call in sudo if "--user" in call]
    assert "flatpak update -y --noninteractive --user" in calls(home)


def test_each_flatpak_pass_reports_only_its_own_problems(machine):
    home, env = machine
    system_broken = "app/org.example.SystemBroken/x86_64/stable"
    (home / "refs").write_text(f"{GOOD}\n{BROKEN}\n")
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n{system_broken}\n")
    (home / "broken-refs").write_text(f"{BROKEN}\n{system_broken}\n")
    steps = summary(run(env).stdout)
    assert steps["flatpaks"] == f"did not all update: {BROKEN}: Failed to install {BROKEN}: No space left on device"
    assert steps["system-flatpaks"] == f"did not all update: {system_broken}: Failed to install {system_broken}: No space left on device"


def test_a_failed_user_pass_leaves_the_system_pass_ok(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    steps = summary(run(env).stdout)
    assert steps["flatpaks"].startswith("did not all update")
    assert steps["system-flatpaks"] == "ok"
    assert problems(home) == "flatpaks"


def test_the_last_error_line_is_the_one_reported(machine, tmp_path):
    home, env = machine
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    stub = tmp_path / "stubs" / "flatpak"
    stub.write_text(stub.read_text().replace('echo "error: Failed to install $last', 'echo "error: an earlier error" >&2\n      echo "error: Failed to install $last'))
    done = run(env)
    assert "an earlier error" not in done.stdout
    assert summary(done.stdout)["flatpaks"] == f"did not all update: {BROKEN}: Failed to install {BROKEN}: No space left on device"


def test_the_check_neither_updates_nor_lists_flatpaks(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    run(env, "--check")
    assert not [call for call in calls(home) if call.startswith(("flatpak update", "flatpak list", "sudo -n flatpak"))]


SKIPPED = "skipped (needs root: run sudo herald-os update)"


def system_flatpak_updates(home: Path) -> list[str]:
    return [call for call in calls(home) if call.startswith("flatpak update") and "--system" in call]


def problems(home: Path) -> str:
    return re.findall(r"after-update problems=(.*)", (home / "herald-os.log").read_text())[-1]


def test_from_the_menu_without_root_system_flatpaks_are_skipped_not_a_problem(machine, tmp_path):
    """On another ostree system the system step needs no root, so only the Flatpaks are left."""
    home, env = machine
    env["HERALD_OS_IMAGE_SHELL"] = str(tmp_path / "no-such-shell")
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert not system_flatpak_updates(home)
    assert summary(done.stdout)["system-flatpaks"] == SKIPPED
    assert summary(done.stdout)["flatpaks"] == "ok"
    assert summary(done.stdout)["system"] == "ok (ostree)"
    assert problems(home) == "none"
    assert "notify Herald OS updated its own parts" in (home / "herald-os.log").read_text()


def test_from_the_menu_without_root_the_image_is_skipped_not_failed(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert not ran(home, "bootc") and not ran(home, "rpm-ostree")
    assert not system_flatpak_updates(home)
    assert "==> system: skipped (bootc upgrade needs root: run sudo herald-os update)" in done.stdout
    assert "==> system flatpaks: skipped (needs root: run sudo herald-os update)" in done.stdout
    assert "skipped: system system-flatpaks (run sudo herald-os update to update them)" in done.stdout
    steps = summary(done.stdout)
    assert steps["system"] == "skipped (bootc upgrade needs root: run sudo herald-os update)"
    assert steps["system-flatpaks"] == SKIPPED
    assert steps["flatpaks"] == "ok"
    assert problems(home) == "none"
    assert "failed:" not in done.stderr
    assert "notify Herald OS updated its own parts The system needs root: run sudo herald-os update in a terminal." in (home / "herald-os.log").read_text()


def test_from_the_menu_without_root_layered_packages_say_which_tool_needs_it(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    (home / "no-sudo").write_text("")
    done = run(env)
    assert done.returncode == 0
    assert not ran(home, "rpm-ostree upgrade")
    assert summary(done.stdout)["system"] == "skipped (rpm-ostree upgrade; layered: htop needs root: run sudo herald-os update)"


def test_skipped_steps_do_not_hide_real_failures(machine):
    """Without root the system is skipped, but a user Flatpak that fails is still a problem."""
    home, env = machine
    (home / "no-sudo").write_text("")
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    done = run(env)
    assert done.returncode == 0
    assert summary(done.stdout)["system"].startswith("skipped")
    assert summary(done.stdout)["flatpaks"].startswith("did not all update")
    assert problems(home) == "flatpaks"
    assert "notify Update finished with problems flatpaks" in (home / "herald-os.log").read_text()


def test_a_system_upgrade_that_runs_and_fails_still_fails_the_update(machine):
    """With root available a failing bootc is a real failure, not a skip."""
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "layered").write_text("1")
    done = run(env)
    assert done.returncode == 1
    assert summary(done.stdout)["system"] == "FAILED (bootc upgrade, exit 1)"
    assert summary(done.stdout)["system-flatpaks"] == "ok"
    assert problems(home) == "system"


@pytest.mark.skipif(shutil.which("script") is None, reason="needs script (util-linux) for a terminal")
def test_in_a_terminal_sudo_asks_for_the_password_and_everything_updates(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    command = f"bash {UPDATE} --no-hermes"
    done = subprocess.run(["script", "-qec", command, "/dev/null"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    output = done.stdout.replace("\r\n", "\n")
    assert done.returncode == 0, output
    assert "bootc upgrade" in calls(home)
    assert system_flatpak_updates(home)
    asked = (home / "sudo.log").read_text()
    assert "asked for a password: bootc upgrade" in asked
    assert "asked for a password: flatpak update -y --noninteractive --system" in asked
    assert "sudo flatpak update -y --noninteractive --system" in calls(home)
    steps = summary(output)
    assert steps["system"] == "ok (bootc upgrade)"
    assert steps["system-flatpaks"] == "ok"
    assert problems(home) == "none"


def test_without_system_flatpaks_there_is_no_system_flatpak_step(machine):
    home, env = machine
    done = run(env)
    assert "system-flatpaks" not in summary(done.stdout)
    assert not [call for call in calls(home) if call.startswith("flatpak update") and "--system" in call]


def can_be_root() -> bool:
    return shutil.which("unshare") is not None and subprocess.run(["unshare", "-r", "true"], capture_output=True).returncode == 0


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
def test_as_root_the_test_paths_count_only_with_the_testing_flag(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    flagged = run(env, prefix=("unshare", "-r"))
    assert "==> system (image)" in flagged.stdout
    unflagged = run({key: value for key, value in env.items() if key != "HERALD_OS_TESTING"}, prefix=("unshare", "-r"))
    assert "==> system (image)" not in unflagged.stdout


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
@pytest.mark.parametrize("flag", ["0", "yes", "true", " 1", "1 ", "01"])
def test_as_root_only_testing_flag_1_counts(machine, flag):
    home, env = machine
    done = run({**env, "HERALD_OS_TESTING": flag}, prefix=("unshare", "-r"))
    assert "==> system (image)" not in done.stdout
    assert not ran(home, "bootc") and not ran(home, "rpm-ostree")


def with_migration(env: dict) -> Path:
    """A migration in the HERALD_OS_REPO checkout that leaves a mark when it runs."""
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "mark.sh").write_text('touch "$HOME/migration-ran"\n')
    return Path(env["HOME"]) / "migration-ran"


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
def test_as_root_a_checkout_from_the_environment_runs_no_migrations(machine):
    home, env = machine
    mark = with_migration(env)
    run({key: value for key, value in env.items() if key != "HERALD_OS_TESTING"}, prefix=("unshare", "-r"))
    assert not mark.exists()
    run(env, prefix=("unshare", "-r"))
    assert mark.exists()


def test_as_the_user_the_checkout_from_the_environment_counts(machine):
    home, env = machine
    mark = with_migration(env)
    run({key: value for key, value in env.items() if key != "HERALD_OS_TESTING"})
    assert mark.exists()


def with_build(home: Path) -> Path:
    """A build script in ~/Herald-OS (the checkout as root) that leaves a mark when it runs."""
    build = home / "Herald-OS" / "linux" / "dev" / "build.sh"
    build.parent.mkdir(parents=True)
    build.write_text('touch "$HOME/build-ran"\n')
    build.chmod(0o755)
    return home / "build-ran"


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
def test_as_root_a_forced_rebuild_from_the_environment_does_not_count(machine):
    home, env = machine
    mark = with_build(home)
    unflagged = {key: value for key, value in env.items() if key not in ("HERALD_OS_TESTING", "HERALD_OS_REPO")}
    run({**unflagged, "HERALD_OS_FORCE_REBUILD": "1"}, prefix=("unshare", "-r"))
    assert not mark.exists()


def test_as_the_user_a_forced_rebuild_counts(machine):
    home, env = machine
    mark = with_build(home)
    unflagged = {key: value for key, value in env.items() if key not in ("HERALD_OS_TESTING", "HERALD_OS_REPO")}
    run({**unflagged, "HERALD_OS_FORCE_REBUILD": "1"})
    assert mark.exists()
