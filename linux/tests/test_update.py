"""herald-os-update on the Herald OS image: bootc, or rpm-ostree once packages are layered, and Flatpaks that fail one by one."""

import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
UPDATE = ROOT / "linux" / "bin" / "herald-os-update"

# The booted deployment as `rpm-ostree status --json` reports it, with whatever it adds to the image.
# Removals and replacements come from GVariant tuples: [nevra, name, epoch, version, release, arch].
FIREFOX = ["firefox-131.0-1.fc44.x86_64", "firefox", "0", "131.0", "1.fc44", "x86_64"]
MESA = ["mesa-dri-drivers-25.0-2.fc44.x86_64", "mesa-dri-drivers", "0", "25.0", "2.fc44", "x86_64"]
MESA_OLD = ["mesa-dri-drivers-25.0-1.fc44.x86_64", "mesa-dri-drivers", "0", "25.0", "1.fc44", "x86_64"]
CHANGES = {
    "requested-packages": (["htop", "vim-enhanced"], "layered: htop, vim-enhanced"),
    "requested-local-packages": (["mytool-1.0-1.x86_64"], "local: mytool-1.0-1.x86_64"),
    "base-removals": ([FIREFOX], "removed: firefox-131.0-1.fc44.x86_64"),
    "base-local-replacements": ([[MESA, MESA_OLD]], "replaced: mesa-dri-drivers-25.0-2.fc44.x86_64"),
}

STUBS = {
    "herald-os": 'echo "$@" >>"$HOME/herald-os.log"',
    "sudo": '[ "$1" = -n ] && shift\nexec "$@"',
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
    # Updating everything fails when any ref in ~/broken-refs does; so does updating that ref alone.
    "flatpak": """echo "flatpak $*" >>"$HOME/calls.log"
case "$1" in
  list) cat "$HOME/refs" ;;
  remote-ls) ;;
  update)
    for arg in "$@"; do last="$arg"; done
    if [ -s "$HOME/broken-refs" ]; then
      if [ "$last" = --user ]; then
        echo "Error: Failed to update some refs" >&2
        exit 1
      fi
      if grep -qx "$last" "$HOME/broken-refs"; then
        echo "Looking for updates..." >&2
        echo "error: Failed to install $last: No space left on device" >&2
        exit 1
      fi
    fi
    echo "Updated $last" >>"$HOME/updated.log"
    ;;
esac""",
}


@pytest.fixture
def machine(tmp_path):
    """The Herald OS image with every command herald-os-update runs stood in for."""
    stubs, home, repo = tmp_path / "stubs", tmp_path / "home", tmp_path / "checkout"
    for folder in (stubs, home, repo / "linux" / "migrations"):
        folder.mkdir(parents=True)
    for name, body in STUBS.items():
        (stubs / name).write_text(f"#!/bin/sh\n{body}\n")
        (stubs / name).chmod(0o755)
    (tmp_path / "ostree-booted").write_text("")
    (tmp_path / "app.asar").write_text("")
    (home / "refs").write_text("app/org.example.Good/x86_64/stable\napp/org.example.Broken/x86_64/stable\n")
    env = {
        "HOME": str(home),
        "HERALD_OS_REPO": str(repo),
        "HERALD_OS_OSTREE_BOOTED": str(tmp_path / "ostree-booted"),
        "HERALD_OS_IMAGE_SHELL": str(tmp_path / "app.asar"),
        "PATH": os.pathsep.join([str(stubs), "/usr/bin", "/bin"]),
    }
    deploy(home, {})
    return home, env


def deploy(home: Path, changes: dict) -> None:
    booted = {"id": "fedora-herald", "booted": True, "requested-packages": [], "requested-local-packages": [], "base-removals": [], "base-local-replacements": [], **changes}
    staged = {"id": "fedora-herald-staged", "booted": False, "requested-packages": ["only-in-the-staged-one"]}
    (home / "status.json").write_text(json.dumps({"deployments": [staged, booted]}))
    (home / "layered").write_text("1" if any(changes.values()) else "")


def run(env, *args):
    return subprocess.run(["bash", str(UPDATE), "--no-hermes", *args], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)


def calls(home: Path) -> list[str]:
    log = home / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def test_the_image_as_built_upgrades_with_bootc(machine):
    home, env = machine
    done = run(env)
    assert done.returncode == 0, done.stderr
    assert "bootc upgrade" in calls(home)
    assert not [call for call in calls(home) if call.startswith("rpm-ostree")]
    assert "system     ok (bootc upgrade)" in done.stdout


@pytest.mark.parametrize("key", CHANGES)
def test_layered_overridden_or_local_packages_upgrade_with_rpm_ostree(machine, key):
    home, env = machine
    packages, described = CHANGES[key]
    deploy(home, {key: packages})
    done = run(env)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "rpm-ostree upgrade" in calls(home)
    assert not [call for call in calls(home) if call.startswith("bootc")]
    assert f"packages of its own on top of the image ({described})" in done.stdout
    assert f"system     ok (rpm-ostree upgrade, keeping {described})" in done.stdout


def test_only_the_booted_deployment_counts(machine):
    home, env = machine
    assert "only-in-the-staged-one" in (home / "status.json").read_text()
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)


def test_unreadable_rpm_ostree_status_falls_back_to_bootc(machine):
    home, env = machine
    (home / "status.json").write_text("not json")
    assert run(env).returncode == 0
    assert "bootc upgrade" in calls(home)


def test_the_check_asks_rpm_ostree_when_packages_are_layered(machine):
    home, env = machine
    deploy(home, {"requested-packages": ["htop"]})
    done = run(env, "--check")
    assert done.returncode == 0
    assert "rpm-ostree upgrade --check" in calls(home)
    assert not [call for call in calls(home) if call.startswith("bootc")]
    assert done.stdout.strip() == "1 package"


def test_a_failed_system_upgrade_fails_the_update(machine):
    home, env = machine
    deploy(home, {"requested-packages": ["htop"]})
    (home / "rpm-ostree-exit").write_text("1")
    done = run(env)
    assert done.returncode == 1
    assert "system     FAILED (rpm-ostree upgrade, keeping layered: htop, exit 1)" in done.stdout
    assert "failed: system" in done.stderr
    assert "flatpaks   ok" in done.stdout


def test_a_broken_flatpak_is_named_and_does_not_fail_the_update(machine):
    home, env = machine
    (home / "broken-refs").write_text("app/org.example.Broken/x86_64/stable\n")
    done = run(env)
    assert done.returncode == 0, done.stderr
    problem = "app/org.example.Broken/x86_64/stable: Failed to install app/org.example.Broken/x86_64/stable: No space left on device"
    assert f"WARNING: flatpak: {problem}" in done.stderr
    assert f"flatpaks   did not all update: {problem}" in done.stdout
    assert "Updated app/org.example.Good/x86_64/stable" in (home / "updated.log").read_text()
    assert "system     ok (bootc upgrade)" in done.stdout
    assert "after-update problems=flatpaks" in (home / "herald-os.log").read_text()


def test_flatpaks_that_cannot_be_listed_report_the_whole_update_error(machine):
    home, env = machine
    (home / "broken-refs").write_text("app/org.example.Broken/x86_64/stable\n")
    (home / "refs").write_text("")
    done = run(env)
    assert done.returncode == 0
    assert "flatpaks   did not all update: Failed to update some refs" in done.stdout
