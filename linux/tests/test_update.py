"""herald-os-update on the Herald OS image: bootc, or rpm-ostree once packages are layered, and Flatpaks that fail one by one."""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
UPDATE = ROOT / "linux" / "bin" / "herald-os-update"
# The bash that runs the updater: macOS has bash 3.2, which can be built and named here elsewhere.
BASH = os.environ.get("HERALD_OS_TEST_BASH", "bash")

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
    # `hermes-command --managed` prints ~/hermes-command as it is (blank lines, no last newline and all).
    "herald-os": """echo "$@" >>"$TEST_HOME/herald-os.log"
if [ "$1" = hermes-command ] && [ -e "$TEST_HOME/hermes-command" ]; then
  cat "$TEST_HOME/hermes-command"
fi""",
    # With ~/no-sudo the account needs a password: `sudo -n` fails until plain sudo (in a terminal)
    # has asked once, which sudo then remembers; with ~/wrong-password the asking fails. Root is never
    # asked. `-u NAME -H` runs as the person NAME (an account if listed in ~/accounts or with a home
    # in ~/people/NAME), whose own sudo needs a password with ~/person-needs-password. As a person,
    # `test -r` fails for the paths listed in ~/unreadable. With ~/use-pty (Fedora's Defaults use_pty)
    # every `sudo -u` runs in a new pseudo-terminal, where the person's remembered password does not
    # count: their `sudo -n` fails even right after they typed it.
    "sudo": """echo "sudo $*" >>"$TEST_HOME/calls.log"
n=; v=; who=
while :; do
  case "$1" in
    -n) n=1; shift ;;
    -v) v=1; shift ;;
    -H) shift ;;
    -u) who="$2"; shift 2 ;;
    *) break ;;
  esac
done
if [ -n "$who" ] && ! grep -qx "$who" "$TEST_HOME/accounts" 2>/dev/null && [ ! -d "$TEST_HOME/people/$who" ]; then
  echo "sudo: unknown user $who" >&2
  exit 1
fi
needs=; remembered=; pty=
if [ -n "${STUB_PERSON:-}" ]; then
  needs="$TEST_HOME/person-needs-password"; remembered="$TEST_HOME/person-remembered"
  [ -e "$TEST_HOME/use-pty" ] && pty=1
elif [ "$(id -u)" != 0 ]; then
  needs="$TEST_HOME/no-sudo"; remembered="$TEST_HOME/sudo-remembered"
fi
if [ -n "$needs" ] && [ -e "$needs" ] && { [ -n "$pty" ] || [ ! -e "$remembered" ]; }; then
  if [ -n "$n" ]; then
    echo "sudo: a password is required" >&2
    exit 1
  fi
  echo "asked for a password: $*" >>"$TEST_HOME/sudo.log"
  if [ -e "$TEST_HOME/wrong-password" ]; then
    echo "sudo: 1 incorrect password attempt" >&2
    exit 1
  fi
  touch "$remembered"
fi
[ -n "$v" ] && exit 0
if [ -n "$who" ]; then
  HOME="$TEST_HOME/people/$who"
  STUB_PERSON="$who"
  export HOME STUB_PERSON
  if [ "$1" = test ] && [ "$2" = -r ] && grep -qxF "$3" "$TEST_HOME/unreadable" 2>/dev/null; then
    exit 1
  fi
fi
SUDO_USER=tester exec "$@\"""",
    # Like bootc, refuses when the booted or the staged deployment has local changes.
    "bootc": """echo "bootc $*" >>"$TEST_HOME/calls.log"
if [ -s "$TEST_HOME/layered" ]; then
  echo "error: Upgrading: Deployment contains local rpm-ostree modifications; cannot upgrade via bootc" >&2
  exit 1
fi
if [ "$2" = --check ]; then
  if [ -e "$TEST_HOME/bootc-up-to-date" ]; then
    echo "No changes in: ostree-unverified-registry:ghcr.io/iamlukethedev/herald-os:stable"
  else
    echo "Update available for: ostree-unverified-registry:ghcr.io/iamlukethedev/herald-os:stable"
  fi
fi
exit 0""",
    # `upgrade --check` exits with ~/check-exit for the user (polkit) and ~/check-exit-root through
    # sudo: 0 for an update, 77 for none, anything else when it cannot tell.
    "rpm-ostree": """[ "$1" = status ] && exec cat "$TEST_HOME/status.json"
echo "rpm-ostree $*" >>"$TEST_HOME/calls.log"
if [ "$2" = --check ]; then
  [ -t 0 ] && echo "rpm-ostree check read a terminal" >>"$TEST_HOME/calls.log"
  [ -n "$SUDO_USER" ] && exit "$(cat "$TEST_HOME/check-exit-root" 2>/dev/null || echo 0)"
  exit "$(cat "$TEST_HOME/check-exit" 2>/dev/null || echo 0)"
fi
exit "$(cat "$TEST_HOME/rpm-ostree-exit" 2>/dev/null || echo 0)\"""",
    # Passes the command through, or with ~/timeout-expires gives up on it as timeout does (124).
    "timeout": """echo "timeout $*" >>"$TEST_HOME/calls.log"
# With text in it, only commands that contain the text run out of time.
if [ -e "$TEST_HOME/timeout-expires" ] && { [ ! -s "$TEST_HOME/timeout-expires" ] || echo "$*" | grep -qF "$(cat "$TEST_HOME/timeout-expires")"; }; then
  exit 124
fi
shift
exec "$@\"""",
    # The user installation's refs are in ~/refs, the system one's in ~/system-refs. Updating a whole
    # installation fails when one of its refs is in ~/broken-refs, and so does updating that ref alone.
    "flatpak": """echo "flatpak $*" >>"$TEST_HOME/calls.log"
refs="$TEST_HOME/refs"
case " $* " in *" --system "*) refs="$TEST_HOME/system-refs" ;; esac
case "$1" in
  list) cat "$refs" 2>/dev/null ;;
  remote-ls) ;;
  update)
    if [ -e "$TEST_HOME/remote-down" ]; then
      echo "error: Unable to load summary from remote flathub: Could not resolve hostname" >&2
      exit 1
    fi
    for arg in "$@"; do last="$arg"; done
    if [ "$last" = --user ] || [ "$last" = --system ]; then
      if [ -s "$TEST_HOME/broken-refs" ] && grep -qxFf "$TEST_HOME/broken-refs" "$refs" 2>/dev/null; then
        echo "Error: Failed to update some refs" >&2
        exit 1
      fi
      echo "Updated everything $last" >>"$TEST_HOME/updated.log"
      exit 0
    fi
    if grep -qx "$last" "$TEST_HOME/broken-refs" 2>/dev/null; then
      echo "Looking for updates..." >&2
      echo "error: Failed to install $last: No space left on device" >&2
      exit 1
    fi
    echo "Updated $last" >>"$TEST_HOME/updated.log"
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
        "TEST_HOME": str(home),
        "HERALD_OS_REPO": str(repo),
        "HERALD_OS_OSTREE_BOOTED": str(tmp_path / "ostree-booted"),
        "HERALD_OS_IMAGE_SHELL": str(tmp_path / "app.asar"),
        "HERALD_OS_TESTING": "1",
        "HERALD_OS_MIGRATIONS_DONE": str(tmp_path / "migrations-done"),
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


def run(env, *args, prefix=(), script=UPDATE, hermes=False):
    return subprocess.run([*prefix, BASH, str(script), *([] if hermes else ["--no-hermes"]), *args], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)


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


def check(home: Path, env: dict) -> tuple[str, dict, str]:
    """`--check`: what it prints, what it records, and the count it reports to the menu bar."""
    done = run(env, "--check")
    assert done.returncode == 0, done.stderr
    state = json.loads((home / ".local" / "state" / "herald-os" / "update-available.json").read_text())
    reported = re.findall(r"^update-available (.*)$", (home / "herald-os.log").read_text(), re.M)[-1]
    return done.stdout.strip(), state, reported


def sudo_calls(home: Path) -> list[str]:
    return [call for call in calls(home) if call.startswith("sudo ")]


@pytest.mark.parametrize("layered", [True, False], ids=["layered", "as-built"])
def test_the_check_asks_rpm_ostree_without_sudo_first(machine, layered):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]} if layered else {})
    out, state, reported = check(home, env)
    assert out == "1 package" and state["packages"] == 1 and state["packagesUnknown"] is False
    assert reported == "1 1 package"
    assert "rpm-ostree upgrade --check" in calls(home)
    assert not sudo_calls(home)


def test_the_check_without_sudo_finds_the_image_up_to_date(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    (home / "check-exit").write_text("77")
    out, state, reported = check(home, env)
    assert out == "up to date" and state["pending"] == 0 and state["packagesUnknown"] is False
    assert not sudo_calls(home)


def test_the_check_falls_back_to_sudo_n_rpm_ostree_when_polkit_says_no(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    (home / "check-exit").write_text("1")
    out, state, _ = check(home, env)
    assert out == "1 package" and state["packagesUnknown"] is False
    assert "sudo -n rpm-ostree upgrade --check" in sudo_calls(home)
    assert not ran(home, "bootc")


@pytest.mark.parametrize("up_to_date", [False, True], ids=["update", "no-update"])
def test_the_check_on_the_image_as_built_falls_back_to_sudo_n_bootc(machine, up_to_date):
    home, env = machine
    (home / "check-exit").write_text("1")
    if up_to_date:
        (home / "bootc-up-to-date").write_text("")
    out, state, _ = check(home, env)
    assert out == ("up to date" if up_to_date else "1 package")
    assert state["packagesUnknown"] is False
    assert "sudo -n bootc upgrade --check" in sudo_calls(home)


@pytest.mark.parametrize("layered", [True, False], ids=["layered", "as-built"])
def test_a_check_that_cannot_tell_reports_unknown_and_shows_no_dot(machine, layered):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]} if layered else {})
    (home / "check-exit").write_text("1")
    (home / "no-sudo").write_text("")
    out, state, reported = check(home, env)
    assert out == "system updates not checked"
    assert state["pending"] == 0 and state["packages"] == 0 and state["packagesUnknown"] is True
    assert reported == "0 system updates not checked"


def test_an_unknown_system_check_does_not_hide_other_updates(machine):
    home, env = machine
    (home / "check-exit").write_text("1")
    (home / "no-sudo").write_text("")
    flatpak = Path(env["PATH"].split(os.pathsep)[0]) / "flatpak"
    flatpak.write_text(flatpak.read_text().replace("  remote-ls) ;;", "  remote-ls) echo org.example.Good ;;"))
    out, state, reported = check(home, env)
    assert out == "1 app, system updates not checked"
    assert state["pending"] == 1 and state["packagesUnknown"] is True
    assert reported == "1 1 app, system updates not checked"


def test_skipped_steps_are_listed_even_when_another_step_fails(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    build = Path(env["HERALD_OS_REPO"]) / "linux" / "dev" / "build.sh"
    build.parent.mkdir(parents=True)
    build.write_text("exit 1\n")
    build.chmod(0o755)
    done = run({**env, "HERALD_OS_FORCE_REBUILD": "1"})
    assert done.returncode == 1
    assert "skipped: system system-flatpaks (run sudo herald-os update to update them)" in done.stdout
    assert "failed: build" in done.stderr
    assert problems(home) == "build"


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


@pytest.mark.skipif(sys.platform != "linux" or shutil.which("script") is None, reason="needs script from util-linux for a terminal")
def test_in_a_terminal_sudo_asks_for_the_password_and_everything_updates(machine):
    home, env = machine
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    command = f"{BASH} {UPDATE} --no-hermes"
    done = subprocess.run(["script", "-qec", command, "/dev/null"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    output = done.stdout.replace("\r\n", "\n")
    assert done.returncode == 0, output
    assert "bootc upgrade" in calls(home)
    assert system_flatpak_updates(home)
    assert len((home / "sudo.log").read_text().splitlines()) == 1
    assert "sudo bootc upgrade" in calls(home)
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
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "mark.sh").write_text('# Runs as: root\ntouch "$HOME/migration-ran"\n')
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


TERMINAL = pytest.mark.skipif(sys.platform != "linux" or shutil.which("script") is None, reason="needs script from util-linux for a terminal")


def in_a_terminal(env: dict, *args: str, stays_open: bool = False) -> str:
    command = " ".join([BASH, str(UPDATE), "--no-hermes", *args])
    if stays_open:
        # script hangs up its terminal when the update ends, which a terminal window does not; a
        # hangup ignored here stays ignored in everything the update starts.
        command = f"trap '' HUP; {command}"
    done = subprocess.run(["script", "-qec", command, "/dev/null"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    return done.stdout.replace("\r\n", "\n")


@pytest.mark.parametrize("layered", [True, False], ids=["layered", "as-built"])
def test_every_update_check_runs_under_timeout_120(machine, layered):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]} if layered else {})
    (home / "check-exit").write_text("1")
    check(home, env)
    fallback = "timeout 120 sudo -n rpm-ostree upgrade --check" if layered else "timeout 120 sudo -n bootc upgrade --check"
    assert "timeout 120 rpm-ostree upgrade --check" in calls(home)
    assert fallback in calls(home)


def test_a_check_that_runs_out_of_time_is_unknown_without_a_second_try(machine):
    home, env = machine
    (home / "timeout-expires").write_text("")
    out, state, reported = check(home, env)
    assert out == "system updates not checked" and state["packagesUnknown"] is True
    assert reported == "0 system updates not checked"
    assert [call for call in calls(home) if call.startswith("timeout")] == ["timeout 120 rpm-ostree upgrade --check"]
    assert not sudo_calls(home)


@pytest.mark.parametrize("layered", [True, False], ids=["layered", "as-built"])
def test_a_sudo_check_that_runs_out_of_time_is_unknown(machine, layered):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]} if layered else {})
    (home / "check-exit").write_text("1")
    (home / "timeout-expires").write_text("sudo")
    out, state, _ = check(home, env)
    assert out == "system updates not checked" and state["packagesUnknown"] is True


@TERMINAL
def test_the_check_never_reads_the_terminal(machine):
    home, env = machine
    deploy(home, booted={"requested-packages": ["htop"]})
    (home / "check-exit").write_text("1")
    in_a_terminal(env, "--check")
    assert "rpm-ostree upgrade --check" in calls(home)
    assert "rpm-ostree check read a terminal" not in calls(home)


@pytest.mark.skipif(shutil.which("rpm-ostree") is not None, reason="this machine has rpm-ostree of its own")
@pytest.mark.parametrize("up_to_date", [False, True], ids=["update", "no-update"])
def test_without_rpm_ostree_the_check_asks_bootc(machine, tmp_path, up_to_date):
    home, env = machine
    (tmp_path / "stubs" / "rpm-ostree").unlink()
    if up_to_date:
        (home / "bootc-up-to-date").write_text("")
    out, state, _ = check(home, env)
    assert out == ("up to date" if up_to_date else "1 package")
    assert "timeout 120 sudo -n bootc upgrade --check" in calls(home)


def migration(env: dict, name: str, kind: str | None, folder: Path | None = None, mark: str | None = None) -> str:
    """A migration of a kind ("root", "user", "user, with sudo" or none), in the checkout or `folder`,
    that counts its runs in $HOME/runs-MARK, $HOME being whoever it ran as."""
    header = f"# Runs as: {kind}\n" if kind else ""
    folder = folder or Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    (folder / f"{name}.sh").write_text(f'#!/bin/sh\n{header}echo run >>"$HOME/runs-{mark or name}"\n')
    return name


def installed(tmp_path: Path) -> tuple[Path, Path]:
    """A copy of the updater installed as a package would, with its migrations beside it."""
    folder = tmp_path / "install"
    (folder / "bin").mkdir(parents=True)
    (folder / "migrations").mkdir()
    shutil.copy(UPDATE, folder / "bin" / "herald-os-update")
    return folder / "bin" / "herald-os-update", folder / "migrations"


def runs(home: Path, name: str) -> int:
    path = home / f"runs-{name}"
    return len(path.read_text().splitlines()) if path.exists() else 0


def user_marker(home: Path, name: str) -> Path:
    return home / ".local" / "state" / "herald-os" / "migrations" / f"{name}.sh"


def three_kinds(env: dict) -> None:
    migration(env, "a-root", "root")
    migration(env, "b-user", "user")
    migration(env, "c-mixed", "user, with sudo")


def test_from_the_menu_user_migrations_run_as_the_user_and_the_rest_wait(machine, tmp_path):
    home, env = machine
    three_kinds(env)
    migration(env, "d-untagged", None)
    (home / "no-sudo").write_text("")
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert runs(home, "b-user") == 1 and runs(home, "d-untagged") == 1
    assert runs(home, "a-root") == 0 and runs(home, "c-mixed") == 0
    assert user_marker(home, "b-user").exists() and not (tmp_path / "migrations-done").exists()
    assert done.stdout.count("==> migrations: skipped (needs root: run sudo herald-os update)") == 1
    assert summary(done.stdout)["migrations"] == "skipped a-root.sh c-mixed.sh (needs root: run sudo herald-os update)"
    assert "a password is required" not in done.stderr
    assert problems(home) == "none"
    run(env)
    assert runs(home, "b-user") == 1


def test_with_sudo_every_kind_runs_where_it_belongs(machine, tmp_path):
    home, env = machine
    three_kinds(env)
    run(env)
    run(env)
    assert runs(home, "a-root") == runs(home, "b-user") == runs(home, "c-mixed") == 1
    assert (tmp_path / "migrations-done" / "a-root.sh").exists()
    assert user_marker(home, "b-user").exists() and user_marker(home, "c-mixed").exists()
    assert not (tmp_path / "migrations-done" / "b-user.sh").exists()
    assert any(call.startswith("sudo -n env REPO=") and call.endswith("a-root.sh") for call in calls(home))


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
def test_as_root_under_sudo_user_migrations_run_as_that_person_with_their_home(machine, tmp_path):
    home, env = machine
    alice = home / "people" / "alice"
    alice.mkdir(parents=True)
    script, folder = installed(tmp_path)
    migration(env, "a-root", "root")
    migration(env, "b-user", "user", folder)
    migration(env, "c-mixed", "user, with sudo", folder)
    done = run({**env, "SUDO_USER": "alice"}, prefix=("unshare", "-r"), script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert runs(alice, "b-user") == 1 and runs(alice, "c-mixed") == 0
    assert runs(home, "b-user") == 0 and runs(home, "c-mixed") == 0
    assert summary(done.stdout)["migrations"] == "skipped c-mixed.sh (run herald-os update, without sudo, in a terminal)"
    assert runs(home, "a-root") == 1 and runs(alice, "a-root") == 0
    assert user_marker(alice, "b-user").exists() and not user_marker(home, "b-user").exists()
    assert any(call.startswith("sudo -n -u alice -H env bash ") and call.endswith("b-user.sh") for call in calls(home))
    run({**env, "SUDO_USER": "alice"}, prefix=("unshare", "-r"), script=script)
    assert runs(alice, "b-user") == 1


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
@pytest.mark.parametrize("sudo_user", [None, "root"], ids=["root-login", "sudo-from-root"])
def test_as_root_without_a_person_user_migrations_are_skipped_not_run_as_root(machine, sudo_user):
    home, env = machine
    three_kinds(env)
    env = {key: value for key, value in env.items() if key != "SUDO_USER"}
    if sudo_user:
        env["SUDO_USER"] = sudo_user
    done = run(env, prefix=("unshare", "-r"))
    assert done.returncode == 0, done.stdout + done.stderr
    assert runs(home, "b-user") == 0 and runs(home, "c-mixed") == 0
    assert runs(home, "a-root") == 1
    assert not user_marker(home, "b-user").exists()
    assert "==> user migrations: skipped (they run as a person, not as root: run herald-os update from your account)" in done.stdout
    assert summary(done.stdout)["user-migrations"] == "skipped b-user.sh c-mixed.sh (run herald-os update from your account)"
    assert problems(home) == "none"


def test_migrate_alone_from_the_menu_runs_user_migrations_and_leaves_the_rest(machine):
    home, env = machine
    three_kinds(env)
    (home / "no-sudo").write_text("")
    done = run(env, "--migrate")
    assert done.returncode == 0
    assert runs(home, "b-user") == 1 and runs(home, "a-root") == 0
    assert "==> migrations: skipped (needs root: run sudo herald-os update)" in done.stdout


def test_a_failing_user_migration_is_a_problem_and_runs_again(machine):
    home, env = machine
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "broken.sh").write_text("# Runs as: user\nexit 1\n")
    done = run(env)
    assert done.returncode == 1
    assert problems(home) == "migration:broken.sh"
    assert not user_marker(home, "broken").exists()


@TERMINAL
def test_in_a_terminal_sudo_asks_once_for_migrations_and_the_system(machine, tmp_path):
    home, env = machine
    three_kinds(env)
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    output = in_a_terminal(env)
    assert runs(home, "a-root") == runs(home, "b-user") == runs(home, "c-mixed") == 1
    assert len((home / "sudo.log").read_text().splitlines()) == 1
    assert calls(home).count("sudo -v") == 1
    assert summary(output)["system"] == "ok (bootc upgrade)"
    assert summary(output)["system-flatpaks"] == "ok"


def test_every_shipped_migration_says_whose_it_is():
    for path in sorted((ROOT / "linux" / "migrations").glob("*.sh")):
        text = path.read_text()
        kind = re.search(r"^# Runs as: (.+)$", text, re.M)
        assert kind, f"{path.name} has no '# Runs as:' line"
        touches_the_person = "$HOME" in text or "systemctl --user" in text or "herald-os-theme" in text or "herald-os keymap" in text
        assert not (touches_the_person and kind.group(1) == "root"), f"{path.name} works on the person's files but runs as root"
        if "sudo -n" in text:
            assert kind.group(1) in ("root", "user, with sudo"), f"{path.name} takes root steps but says {kind.group(1)}"


def test_the_tests_never_touch_var_lib(machine):
    home, env = machine
    three_kinds(env)
    run(env)
    assert not [call for call in calls(home) if "/var/lib" in call]


@pytest.mark.parametrize("value", [1, "true", "yes"])
def test_a_regenerate_initramfs_that_is_true_but_not_a_boolean_counts(machine, value):
    home, env = machine
    deploy(home, booted={"regenerate-initramfs": value})
    done = run(env)
    assert "rpm-ostree upgrade" in calls(home) and not ran(home, "bootc")
    assert "initramfs: regenerated" in summary(done.stdout)["system"]


@pytest.mark.parametrize("value", [0, "", None])
def test_a_regenerate_initramfs_that_is_false_does_not_count(machine, value):
    home, env = machine
    deploy(home, booted={"regenerate-initramfs": value})
    (home / "layered").write_text("")
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home) and not ran(home, "rpm-ostree upgrade")


def on_arch(env: dict, tmp_path: Path, helper: str | None) -> dict:
    """Arch: no image, pacman, and an AUR helper or none; all of them log their calls."""
    stubs = tmp_path / "stubs"
    for name in ["pacman", *([helper] if helper else [])]:
        (stubs / name).write_text(f'#!/bin/sh\necho "{name} $*" >>"$TEST_HOME/calls.log"\n')
        (stubs / name).chmod(0o755)
    return {**env, "HERALD_OS_OSTREE_BOOTED": str(tmp_path / "not-booted"), "HERALD_OS_IMAGE_SHELL": str(tmp_path / "no-shell")}


@pytest.mark.skipif(any(shutil.which(name) for name in ("yay", "paru", "omarchy-update")), reason="this machine has an AUR helper or Omarchy of its own")
def test_pacman_without_an_aur_helper_needs_root(machine, tmp_path):
    home, env = machine
    (home / "no-sudo").write_text("")
    done = run(on_arch(env, tmp_path, None))
    assert "==> system (pacman)" in done.stdout
    assert summary(done.stdout)["system"] == "skipped (pacman needs root: run sudo herald-os update)"
    assert not ran(home, "pacman")


@pytest.mark.skipif(any(shutil.which(name) for name in ("yay", "paru", "omarchy-update")), reason="this machine has an AUR helper or Omarchy of its own")
def test_pacman_with_an_aur_helper_lets_the_helper_ask_for_root(machine, tmp_path):
    home, env = machine
    (home / "no-sudo").write_text("")
    done = run(on_arch(env, tmp_path, "yay"))
    assert summary(done.stdout)["system"] == "ok (pacman)"
    assert "yay -Syu --noconfirm" in calls(home)
    assert not ran(home, "pacman")


@TERMINAL
def test_without_timeout_the_check_still_never_reads_the_terminal(machine, tmp_path):
    """macOS has no timeout: the check then runs as it is, but still without the terminal."""
    home, env = machine
    (tmp_path / "stubs" / "timeout").unlink()
    tools = tmp_path / "tools"
    tools.mkdir()
    for folder in ("/usr/bin", "/bin"):
        for tool in Path(folder).iterdir():
            if tool.name != "timeout" and not (tools / tool.name).exists():
                (tools / tool.name).symlink_to(tool)
    env = {**env, "PATH": os.pathsep.join([str(tmp_path / "stubs"), str(tools)])}
    deploy(home, booted={"requested-packages": ["htop"]})
    in_a_terminal(env, "--check")
    assert "rpm-ostree upgrade --check" in calls(home)
    assert not [call for call in calls(home) if call.startswith("timeout")]
    assert "rpm-ostree check read a terminal" not in calls(home)


def test_without_timeout_the_check_uses_gtimeout(machine, tmp_path):
    """macOS with Homebrew's coreutils: gtimeout instead of timeout."""
    home, env = machine
    stubs = tmp_path / "stubs"
    (stubs / "timeout").rename(stubs / "gtimeout")
    (stubs / "gtimeout").write_text((stubs / "gtimeout").read_text().replace('echo "timeout $*"', 'echo "gtimeout $*"'))
    tools = tmp_path / "tools"
    tools.mkdir()
    for folder in ("/usr/bin", "/bin"):
        for tool in Path(folder).iterdir():
            if tool.name not in ("timeout", "gtimeout") and not (tools / tool.name).exists():
                (tools / tool.name).symlink_to(tool)
    env = {**env, "PATH": os.pathsep.join([str(stubs), str(tools)])}
    out, _, _ = check(home, env)
    assert out == "1 package"
    assert "gtimeout 120 rpm-ostree upgrade --check" in calls(home)


@pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")
def test_under_sudo_user_migrations_come_from_the_installed_folder_not_roots_checkout(machine, tmp_path):
    """Root's ~/Herald-OS is not readable by the person; the installed migrations are."""
    home, env = machine
    alice = home / "people" / "alice"
    alice.mkdir(parents=True)
    script, folder = installed(tmp_path)
    roots_checkout = home / "Herald-OS" / "linux" / "migrations"
    migration(env, "b-user", "user", roots_checkout, mark="from-roots-checkout")
    migration(env, "b-user", "user", folder, mark="from-the-installed-folder")
    migration(env, "a-root", "root", roots_checkout)
    env = {key: value for key, value in env.items() if key != "HERALD_OS_REPO"}
    done = run({**env, "SUDO_USER": "alice"}, prefix=("unshare", "-r"), script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert runs(alice, "from-the-installed-folder") == 1
    assert runs(alice, "from-roots-checkout") == 0 and runs(home, "from-roots-checkout") == 0
    assert runs(home, "a-root") == 1
    assert not [call for call in calls(home) if call.startswith("sudo -n -u alice") and str(roots_checkout) in call]


def test_as_the_person_migrations_still_come_from_their_checkout(machine, tmp_path):
    home, env = machine
    script, folder = installed(tmp_path)
    migration(env, "b-user", "user", mark="from-the-checkout")
    migration(env, "b-user", "user", folder, mark="from-the-installed-folder")
    run(env, script=script)
    assert runs(home, "from-the-checkout") == 1 and runs(home, "from-the-installed-folder") == 0


def test_a_marker_that_cannot_be_written_is_a_warning_and_the_migration_runs_again(machine):
    home, env = machine
    migration(env, "b-user", "user")
    state = home / ".local" / "state" / "herald-os"
    state.mkdir(parents=True)
    (state / "migrations").write_text("a file where the folder should be")
    done = run(env)
    assert done.returncode == 0, done.stderr
    assert runs(home, "b-user") == 1
    assert "WARNING: migration b-user.sh ran, but could not be recorded in ~/.local/state/herald-os/migrations; it will run again on the next update" in done.stderr
    run(env)
    assert runs(home, "b-user") == 2


def test_a_migration_that_reads_its_input_does_not_swallow_the_others(machine):
    home, env = machine
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "a-reads.sh").write_text("# Runs as: user\ncat >/dev/null\n")
    migration(env, "b-user", "user")
    migration(env, "c-user", "user")
    assert run(env).returncode == 0
    assert runs(home, "b-user") == 1 and runs(home, "c-user") == 1


def leftovers(home: Path) -> list[str]:
    """Processes still running from this test's update (they carry its TEST_HOME)."""
    found = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            environ = (proc / "environ").read_bytes()
            command = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if f"TEST_HOME={home}".encode() in environ.split(b"\0"):
            found.append(f"{proc.name}: {command}")
    return found


@TERMINAL
def test_the_sudo_keeper_ends_with_the_update(machine):
    import time
    home, env = machine
    (home / "no-sudo").write_text("")
    in_a_terminal(env, stays_open=True)
    assert calls(home).count("sudo -v") == 1
    for _ in range(30):
        if not leftovers(home):
            break
        time.sleep(0.1)
    assert leftovers(home) == []


# Round 8: the unreadable, sorted, deduplicated and person-less paths of migrations, and the
# smaller branches QA's mutants reached.

ROOT_NS = pytest.mark.skipif(not can_be_root(), reason="needs unprivileged user namespaces (unshare -r)")


def as_root_under_sudo(env: dict, who: str = "alice", **kwargs) -> subprocess.CompletedProcess:
    return run({**env, "SUDO_USER": who}, prefix=("unshare", "-r"), **kwargs)


def person(home: Path, who: str = "alice") -> Path:
    folder = home / "people" / who
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def started(stdout: str) -> list[str]:
    """The migrations in the order they started."""
    return re.findall(r"^==> migration (\S+)", stdout, re.M)


@ROOT_NS
def test_under_sudo_an_unreadable_user_migration_is_warned_about_once_and_skipped(machine, tmp_path):
    home, env = machine
    alice = person(home)
    script, folder = installed(tmp_path)
    migration(env, "b-user", "user", folder)
    migration(env, "c-user", "user", folder)
    (home / "unreadable").write_text(f"{folder / 'b-user.sh'}\n")
    done = as_root_under_sudo(env, script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stderr.count(f"WARNING: alice cannot read {folder / 'b-user.sh'}, so migration b-user.sh did not run") == 1
    assert runs(alice, "b-user") == 0 and runs(alice, "c-user") == 1
    assert not user_marker(alice, "b-user").exists()
    assert started(done.stdout) == ["c-user.sh"]
    assert problems(home) == "none"


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads every file")
def test_as_the_person_an_unreadable_migration_is_warned_about_and_skipped(machine):
    home, env = machine
    migration(env, "b-user", "user")
    migration(env, "c-user", "user")
    path = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "b-user.sh"
    path.chmod(0)
    done = run(env)
    path.chmod(0o644)
    assert done.returncode == 0, done.stderr
    assert f"cannot read {path}, so migration b-user.sh did not run" in done.stderr
    assert runs(home, "b-user") == 0 and runs(home, "c-user") == 1


@ROOT_NS
def test_migrations_from_both_folders_run_in_name_order(machine, tmp_path):
    home, env = machine
    person(home)
    script, folder = installed(tmp_path)
    migration(env, "b-root", "root")
    migration(env, "a-user", "user", folder)
    migration(env, "c-user", "user", folder)
    done = as_root_under_sudo(env, script=script)
    assert started(done.stdout) == ["a-user.sh", "b-root.sh", "c-user.sh"]


@ROOT_NS
def test_under_sudo_a_root_migration_only_in_the_installed_folder_does_not_run(machine, tmp_path):
    """The installed folder gives the person's migrations; root's come from the usual one."""
    home, env = machine
    alice = person(home)
    script, folder = installed(tmp_path)
    migration(env, "a-root", "root")
    migration(env, "z-root", "root", folder)
    done = as_root_under_sudo(env, script=script)
    assert started(done.stdout) == ["a-root.sh"]
    assert runs(home, "z-root") == 0 and runs(alice, "z-root") == 0


@ROOT_NS
def test_a_migration_in_both_folders_runs_once_as_the_usual_folder_says(machine, tmp_path):
    home, env = machine
    alice = person(home)
    script, folder = installed(tmp_path)
    checkout = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    migration(env, "x", "root", checkout, mark="x-checkout")
    migration(env, "x", "user", folder, mark="x-installed")
    migration(env, "y", "user", checkout, mark="y-checkout")
    migration(env, "y", "root", folder, mark="y-installed")
    done = as_root_under_sudo(env, script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert started(done.stdout) == ["x.sh", "y.sh"]
    assert runs(home, "x-checkout") == 1 and runs(alice, "x-installed") == 0
    assert runs(alice, "y-installed") == 1 and runs(home, "y-installed") == 0 and runs(alice, "y-checkout") == 0
    assert f"WARNING: migration x.sh is root in {checkout} but user in {folder}; it runs as root" in done.stderr
    assert f"WARNING: migration y.sh is user in {checkout} but root in {folder}; it runs as user" in done.stderr


@ROOT_NS
def test_under_sudo_a_user_migration_only_in_roots_checkout_is_warned_about(machine, tmp_path):
    home, env = machine
    alice = person(home)
    script, _ = installed(tmp_path)
    checkout = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    migration(env, "only-here", "user", checkout)
    done = as_root_under_sudo(env, script=script)
    assert f"WARNING: migration only-here.sh is only in {checkout}, which alice cannot read, so it did not run" in done.stderr
    assert runs(alice, "only-here") == 0 and runs(home, "only-here") == 0


@ROOT_NS
def test_a_sudo_user_that_is_not_an_account_gives_one_warning(machine, tmp_path):
    home, env = machine
    script, folder = installed(tmp_path)
    migration(env, "a-root", "root")
    migration(env, "b-user", "user", folder)
    migration(env, "c-user", "user", folder)
    done = as_root_under_sudo(env, "mallory", script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stderr.count("WARNING: SUDO_USER=mallory is not an account sudo can run as, so user migrations did not run") == 1
    assert "cannot read" not in done.stderr and "unknown user" not in done.stderr
    assert runs(home, "a-root") == 1
    assert summary(done.stdout)["user-migrations"] == "skipped b-user.sh c-user.sh (SUDO_USER=mallory is not an account sudo can run as)"


@ROOT_NS
def test_a_person_without_a_home_folder_gets_one_notice(machine, tmp_path):
    home, env = machine
    (home / "accounts").write_text("bob\n")
    script, folder = installed(tmp_path)
    migration(env, "a-root", "root")
    migration(env, "b-user", "user", folder)
    done = as_root_under_sudo(env, "bob", script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stdout.count("==> user migrations: skipped (bob has no home folder to run them in)") == 1
    assert runs(home, "a-root") == 1 and runs(home, "b-user") == 0
    assert not (home / "people" / "bob").exists()


def mixed(folder: Path, name: str) -> None:
    """A "user, with sudo" migration whose system step goes through the person's own sudo -n, as
    the rename migration's do; it fails when that does."""
    (folder / f"{name}.sh").write_text(f'# Runs as: user, with sudo\nsudo -n true || exit 1\necho run >>"$HOME/runs-{name}"\n')


@ROOT_NS
@pytest.mark.parametrize("terminal", [False, True], ids=["no-terminal", "terminal"])
def test_under_sudo_mixed_migrations_wait_for_the_persons_own_run_with_one_notice(machine, tmp_path, terminal):
    """On stock Fedora (use_pty) the password typed for sudo herald-os update does not reach the
    person's own sudo -n inside sudo -u, so running them there could only fail."""
    if terminal and (sys.platform != "linux" or shutil.which("script") is None):
        pytest.skip("needs script from util-linux for a terminal")
    home, env = machine
    alice = person(home)
    script, folder = installed(tmp_path)
    mixed(folder, "c-mixed")
    mixed(folder, "d-mixed")
    migration(env, "b-user", "user", folder)
    for marker in ("person-needs-password", "use-pty", "person-remembered"):
        (home / marker).write_text("")
    env = {**env, "SUDO_USER": "alice"}
    if terminal:
        done = subprocess.run(["script", "-qec", f"unshare -r {BASH} {script} --no-hermes", "/dev/null"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        output = done.stdout.replace("\r\n", "\n")
    else:
        done = run(env, prefix=("unshare", "-r"), script=script)
        output = done.stdout
    assert done.returncode == 0, output + done.stderr
    assert runs(alice, "c-mixed") == runs(alice, "d-mixed") == 0 and runs(alice, "b-user") == 1
    assert output.count("==> migrations: skipped c-mixed.sh d-mixed.sh (they take system steps as alice: run herald-os update, without sudo, in a terminal)") == 1
    assert summary(output)["migrations"] == "skipped c-mixed.sh d-mixed.sh (run herald-os update, without sudo, in a terminal)"
    assert "FAILED" not in output and problems(home) == "none"
    assert not (home / "sudo.log").exists()
    assert not [call for call in calls(home) if call.startswith("sudo -n -u alice -H sudo")]


@TERMINAL
def test_the_persons_own_run_asks_once_and_runs_their_mixed_migrations(machine):
    home, env = machine
    folder = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    mixed(folder, "c-mixed")
    mixed(folder, "d-mixed")
    (home / "no-sudo").write_text("")
    (home / "use-pty").write_text("")
    output = in_a_terminal(env)
    assert runs(home, "c-mixed") == runs(home, "d-mixed") == 1, output
    assert len((home / "sudo.log").read_text().splitlines()) == 1
    assert problems(home) == "none"


@TERMINAL
def test_a_wrong_password_means_no_root_for_the_rest_of_the_update(machine):
    home, env = machine
    migration(env, "a-root", "root")
    (home / "system-refs").write_text(f"{SYSTEM_APP}\n")
    (home / "no-sudo").write_text("")
    (home / "wrong-password").write_text("")
    output = in_a_terminal(env)
    assert len((home / "sudo.log").read_text().splitlines()) == 1
    assert runs(home, "a-root") == 0
    steps = summary(output)
    assert steps["migrations"] == "password refused (a-root.sh not run)"
    assert steps["system"] == "password refused (bootc upgrade not run)"
    assert steps["system-flatpaks"] == "password refused"
    assert "==> system: password refused" in output


def test_with_sudo_that_needs_no_password_nothing_asks(machine):
    home, env = machine
    migration(env, "a-root", "root")
    run(env)
    assert runs(home, "a-root") == 1
    assert "sudo -v" not in calls(home)


def repo_seen(env: dict, name: str, kind: str, folder: Path | None = None) -> None:
    folder = folder or Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    (folder / f"{name}.sh").write_text(f'# Runs as: {kind}\necho "REPO=${{REPO:-}}" >"$TEST_HOME/repo-{name}"\n')


def test_a_persons_own_migrations_get_their_checkout_as_repo(machine):
    home, env = machine
    repo_seen(env, "b-user", "user")
    repo_seen(env, "a-root", "root")
    run(env)
    assert (home / "repo-b-user").read_text().strip() == f"REPO={env['HERALD_OS_REPO']}"
    assert (home / "repo-a-root").read_text().strip() == f"REPO={env['HERALD_OS_REPO']}"


@ROOT_NS
def test_under_sudo_user_migrations_get_no_repo_from_root(machine, tmp_path):
    home, env = machine
    person(home)
    script, folder = installed(tmp_path)
    repo_seen(env, "b-user", "user", folder)
    as_root_under_sudo(env, script=script)
    assert (home / "repo-b-user").read_text().strip() == "REPO="


def test_a_failing_root_migration_fails_the_update_and_is_not_recorded(machine, tmp_path):
    home, env = machine
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "a-root.sh").write_text("# Runs as: root\nexit 3\n")
    done = run(env)
    assert done.returncode == 1
    assert problems(home) == "migration:a-root.sh"
    assert not (tmp_path / "migrations-done" / "a-root.sh").exists()


def test_waiting_migrations_are_in_the_final_skipped_line(machine):
    home, env = machine
    migration(env, "a-root", "root")
    (home / "no-sudo").write_text("")
    done = run(env)
    assert re.search(r"^skipped: migrations( |$)", done.stdout, re.M)


@TERMINAL
def test_migrations_get_no_terminal_and_no_list_on_fd_3(machine):
    home, env = machine
    body = '''if [ -t 0 ]; then echo terminal; else echo no-terminal; fi >>"$TEST_HOME/seen-{0}"
if [ -e /dev/fd/3 ]; then echo fd3-open; else echo fd3-closed; fi >>"$TEST_HOME/seen-{0}"
'''
    folder = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    (folder / "a-root.sh").write_text("# Runs as: root\n" + body.format("a-root"))
    (folder / "b-user.sh").write_text("# Runs as: user\n" + body.format("b-user"))
    in_a_terminal(env)
    for name in ("a-root", "b-user"):
        assert (home / f"seen-{name}").read_text().split() == ["no-terminal", "fd3-closed"], name


def test_without_date_iseconds_the_check_time_falls_back(machine, tmp_path):
    home, env = machine
    (tmp_path / "stubs" / "date").write_text('#!/bin/sh\n[ "$1" = -Iseconds ] && exit 1\nexec /bin/date "$@"\n')
    (tmp_path / "stubs" / "date").chmod(0o755)
    _, state, _ = check(home, env)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}", state["checkedAt"]), state["checkedAt"]


def test_flatpak_refs_with_a_blank_line_and_no_last_newline_are_all_updated(machine):
    home, env = machine
    (home / "refs").write_text(f"{GOOD}\n\n{BROKEN}")
    (home / "broken-refs").write_text(f"{BROKEN}\n")
    done = run(env)
    assert f"Updated {GOOD}" in (home / "updated.log").read_text()
    assert summary(done.stdout)["flatpaks"] == f"did not all update: {BROKEN}: Failed to install {BROKEN}: No space left on device"
    assert "flatpak update -y --noninteractive --user " not in calls(home)


def test_a_hermes_command_with_a_blank_line_and_no_last_newline_runs_whole(machine, tmp_path):
    home, env = machine
    hermes = tmp_path / "stubs" / "hermes"
    hermes.write_text('#!/bin/sh\necho "hermes $*" >>"$TEST_HOME/calls.log"\n')
    hermes.chmod(0o755)
    (home / "hermes-command").write_text(f"{hermes}\n\n--profile=default")
    done = run(env, hermes=True)
    assert "hermes --profile=default update" in calls(home)
    assert summary(done.stdout)["hermes"] == "ok"


@pytest.mark.parametrize("installs", [True, False], ids=["installed", "failed"])
def test_a_newer_release_is_reported_with_nothing_failed_before_it(machine, tmp_path, installs):
    home, env = machine
    tarball = tmp_path / "stubs" / "herald-os-tarball"
    tarball.write_text(f'#!/bin/sh\n[ "$1" = check ] && echo 0.2.0 && exit 0\nexit {0 if installs else 1}\n')
    tarball.chmod(0o755)
    done = run(env)
    assert summary(done.stdout)["herald-os"] == ("0.2.0 installed" if installs else "FAILED: 0.2.0 did not install")


# Round 9: no descriptor of the updater reaches a migration, and none sees the terminal under sudo.

GREEDY = """# Runs as: {kind}
# Each test in a subshell: a redirection on the loop or the eval would itself hold descriptors.
open=""
for fd in $(seq 3 254); do
  if (eval "true <&$fd") 2>/dev/null; then open="$open $fd"; fi
done
echo "$open" >"$TEST_HOME/open-fds-{name}"
cat >/dev/null
for fd in $(seq 3 255); do
  eval "cat <&$fd" >/dev/null 2>&1
done
echo run >>"$HOME/runs-{name}"
"""


def greedy(folder: Path, name: str, kind: str = "user") -> None:
    """A migration that reads all of its input and every descriptor from 3 to 255, after noting which
    of 3 to 254 were open (255 is its own shell's script)."""
    (folder / f"{name}.sh").write_text(GREEDY.format(kind=kind, name=name))


def test_a_greedy_migration_cannot_stop_the_ones_after_it(machine):
    home, env = machine
    folder = Path(env["HERALD_OS_REPO"]) / "linux" / "migrations"
    greedy(folder, "a-greedy")
    greedy(folder, "b-greedy-root", "root")
    migration(env, "c-user", "user")
    migration(env, "d-user", "user")
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert started(done.stdout) == ["a-greedy.sh", "b-greedy-root.sh", "c-user.sh", "d-user.sh"]
    assert runs(home, "c-user") == runs(home, "d-user") == 1
    assert (home / "open-fds-a-greedy").read_text().split() == []
    assert (home / "open-fds-b-greedy-root").read_text().split() == []


@ROOT_NS
def test_under_sudo_a_greedy_migration_cannot_stop_the_ones_after_it(machine, tmp_path):
    home, env = machine
    alice = person(home)
    script, folder = installed(tmp_path)
    greedy(folder, "a-greedy")
    migration(env, "b-user", "user", folder)
    done = as_root_under_sudo(env, script=script)
    assert done.returncode == 0, done.stdout + done.stderr
    assert runs(alice, "a-greedy") == runs(alice, "b-user") == 1
    assert (home / "open-fds-a-greedy").read_text().split() == []


@ROOT_NS
@TERMINAL
def test_under_sudo_migrations_get_no_terminal(machine, tmp_path):
    home, env = machine
    person(home)
    script, folder = installed(tmp_path)
    body = 'if [ -t 0 ]; then echo terminal; else echo no-terminal; fi >"$TEST_HOME/seen-{0}"\n'
    (folder / "b-user.sh").write_text("# Runs as: user\n" + body.format("b-user"))
    (Path(env["HERALD_OS_REPO"]) / "linux" / "migrations" / "a-root.sh").write_text("# Runs as: root\n" + body.format("a-root"))
    subprocess.run(["script", "-qec", f"unshare -r {BASH} {script} --no-hermes", "/dev/null"], env={**env, "SUDO_USER": "alice"}, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    assert (home / "seen-b-user").read_text().strip() == "no-terminal"
    assert (home / "seen-a-root").read_text().strip() == "no-terminal"
