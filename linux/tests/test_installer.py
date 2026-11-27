"""The installer ISO's kickstart (linux/image/iso.toml): encrypted by default, the storage screen still
the person's, the LVM D-Bus service up before Anaconda reads the disks, and the installer test
covering both answers to "Encrypt my data"."""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    tomllib = pytest.importorskip("tomli")

ROOT = Path(__file__).resolve().parents[2]
ISO = ROOT / "linux" / "image" / "iso.toml"
UNATTENDED = ROOT / "linux" / "image" / "unattended.ks"
WORKFLOW = ROOT / ".github" / "workflows" / "installer-test.yml"
SECTION = re.compile(r"%(pre|post|packages|onerror|traceback|addon|anaconda)\b")
LVM_SECTION = re.compile(r"^%pre [^\n]*--log=/tmp/herald-os-lvm\.log\n.*?^%end\n", re.M | re.S)
BASH = shutil.which(os.environ.get("HERALD_OS_TEST_BASH", "bash"))


def contents() -> str:
    return tomllib.loads(ISO.read_text())["customizations"]["installer"]["kickstart"]["contents"]


def kickstart() -> list[str]:
    """The kickstart's commands: every line outside comments and outside %pre, %post and the like."""
    lines, section = [], False
    for line in contents().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line == "%end":
            section = False
        elif SECTION.match(line):
            section = True
        elif not section:
            lines.append(line)
    return lines


def lvm_section(text: str) -> str:
    found = LVM_SECTION.findall(text)
    assert len(found) == 1
    return found[0]


def lvm_pre() -> str:
    return lvm_section(contents()).split("\n", 1)[1].rsplit("%end\n", 1)[0]


def test_the_automatic_layout_is_encrypted_and_asks_for_the_passphrase():
    layouts = [line for line in kickstart() if line.split()[0] == "autopart"]
    assert layouts == ["autopart --type=btrfs --encrypted"]
    # A passphrase here would be the same on every computer installed from the ISO.
    assert not any("--passphrase" in line for line in kickstart())


def test_the_storage_screen_stays_the_persons():
    """Nothing that erases, hides disks or completes the install without the person: no clearpart,
    zerombr or ignoredisk, no account or root password (so the hub never starts by itself), and no
    text mode or reboot."""
    commands = {line.split()[0] for line in kickstart()}
    assert commands == {"autopart", "xconfig"}


def test_the_only_script_is_the_lvm_pre():
    sections = [line.strip() for line in contents().splitlines() if SECTION.match(line.strip())]
    assert sections == ["%pre --interpreter=/usr/bin/bash --log=/tmp/herald-os-lvm.log"]


def test_the_kickstart_parses_where_pykickstart_is_installed():
    parser_module = pytest.importorskip("pykickstart.parser")
    version = pytest.importorskip("pykickstart.version")
    handler = version.makeVersion()
    parser = parser_module.KickstartParser(handler)
    parser.readKickstartFromString(contents())
    assert handler.autopart.autopart and handler.autopart.encrypted and not handler.autopart.passphrase
    assert handler.autopart.type is not None
    assert [(script.interp, script.errorOnFail) for script in handler.scripts] == [("/usr/bin/bash", False)]


def test_the_kickstart_is_a_literal_string_so_the_script_reaches_the_iso_as_written():
    """In a basic TOML string (\"\"\"), \\n and a backslash at a line's end would change the script."""
    assert "contents = '''\n" in ISO.read_text()
    assert "printf '%s\\n' '[Unit]'" in lvm_pre()


def test_unattended_installs_get_the_same_lvm_pre():
    assert lvm_section(UNATTENDED.read_text()) == lvm_section(contents())
    assert UNATTENDED.read_text().endswith(lvm_section(contents()))


# The %pre with fakes for what it runs: each fake writes its command line to $FAKE/calls.
FAKE_SCRIPT = """#!/usr/bin/env bash
echo "$(basename "$0") $*" >>"$FAKE/calls"
case "$(basename "$0") $1" in
  "busctl --system")
    outcome="$(head -n 1 "$FAKE/answers")"
    tail -n +2 "$FAKE/answers" >"$FAKE/answers.next" && mv "$FAKE/answers.next" "$FAKE/answers"
    [[ "$outcome" == up* ]] && { touch "$FAKE/active"; echo "t 3"; exit 0; }
    [[ "$outcome" == "answers, then stops" ]] && { rm -f "$FAKE/active"; echo "t 3"; exit 0; }
    echo "Call failed: Could not activate remote peer 'com.redhat.lvmdbus1': startup job failed" >&2
    exit 1 ;;
  "systemctl --quiet") [[ -f "$FAKE/active" ]]; exit ;;
  "logger -t") shift 3; echo "$*" >>"$FAKE/journal"; exit 0 ;;
  "journalctl -b") echo "lvmdbusd[812]: Too many errors in update_thread, exiting daemon"; exit 0 ;;
  "lvm fullreport") echo "  WARNING: something about a disk" >&2; exit 5 ;;
  "lsblk -o") echo "nvme0n1 disk 476.9G 0 0 nvme gpt"; exit 0 ;;
esac
exit 0
"""


def run_lvm_pre(tmp_path: Path, answers: list[str], pre: str | None = None):
    fake, bin_dir, units = tmp_path / "fake", tmp_path / "bin", tmp_path / "units"
    fake.mkdir(parents=True)
    bin_dir.mkdir(parents=True)
    (bin_dir / "bash").symlink_to(BASH)
    for name in ("busctl", "systemctl", "udevadm", "logger", "journalctl", "lvm", "lsblk", "sleep"):
        (bin_dir / name).write_text(FAKE_SCRIPT)
        (bin_dir / name).chmod(0o755)
    (fake / "answers").write_text("".join(f"{line}\n" for line in answers))
    (fake / "calls").write_text("")
    (fake / "journal").write_text("")
    console = tmp_path / "console"
    console.write_text("")
    script = (pre or lvm_pre()).replace("/run/systemd/system", str(units)).replace("/dev/console", str(console))
    found = subprocess.run(
        ["bash", "-c", script],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE": str(fake)},
        capture_output=True,
        text=True,
        check=False,
    )
    calls = [call for call in (fake / "calls").read_text().splitlines() if not call.startswith("logger ")]
    return found, calls, (fake / "journal").read_text(), console.read_text(), units


REFRESH = "busctl --system --timeout=60 call com.redhat.lvmdbus1 /com/redhat/lvmdbus1/Manager com.redhat.lvmdbus1.Manager Refresh"


def test_the_service_is_started_once_udev_is_done_and_reads_the_disks(tmp_path):
    found, calls, journal, console, units = run_lvm_pre(tmp_path, ["up"])
    assert found.returncode == 0, found.stderr
    assert calls == [
        "systemctl daemon-reload",
        "udevadm settle --timeout=60",
        "systemctl reset-failed lvm2-lvmdbusd.service",
        REFRESH,
        "systemctl --quiet is-active lvm2-lvmdbusd.service",
    ]
    assert journal == "the LVM D-Bus service read the disks (attempt 1)\n"
    assert console == ""


def test_systemd_never_refuses_to_start_the_service_again_this_boot(tmp_path):
    """"startup job failed" is also what an activation gets once the service has stopped five times in
    ten seconds; the drop-in lifts that limit, and only in /run, for the installer's boot."""
    _, calls, _, _, units = run_lvm_pre(tmp_path, ["up"])
    dropin = units / "lvm2-lvmdbusd.service.d" / "50-herald-os.conf"
    assert dropin.read_text() == "[Unit]\nStartLimitIntervalSec=0\n"
    assert calls.index("systemctl daemon-reload") < calls.index(REFRESH)


def test_a_service_that_fails_to_start_is_tried_again_from_a_clean_state(tmp_path):
    found, calls, journal, console, _ = run_lvm_pre(tmp_path, ["fails", "fails", "up"])
    assert found.returncode == 0, found.stderr
    assert calls.count(REFRESH) == 3
    tries = [call for call in calls if call in (REFRESH, "systemctl reset-failed lvm2-lvmdbusd.service")]
    assert tries == ["systemctl reset-failed lvm2-lvmdbusd.service", REFRESH] * 3
    assert calls.count("sleep 5") == 2
    assert journal == "the LVM D-Bus service read the disks (attempt 3)\n"
    assert console == ""


def test_a_service_that_stops_after_answering_does_not_count_as_up(tmp_path):
    found, calls, journal, _, _ = run_lvm_pre(tmp_path, ["answers, then stops", "up"])
    assert found.returncode == 0, found.stderr
    assert calls.count(REFRESH) == 2
    assert journal == "the LVM D-Bus service read the disks (attempt 2)\n"


def test_when_the_service_never_answers_why_goes_into_the_journal_and_the_install_goes_on(tmp_path):
    found, calls, journal, console, _ = run_lvm_pre(tmp_path, ["fails"] * 3)
    assert found.returncode == 0
    assert calls.count(REFRESH) == 3
    assert "lvm2-lvmdbusd.service" in console and "journalctl -b -u lvm2-lvmdbusd.service" in console
    for line in (
        "Too many errors in update_thread, exiting daemon",
        "WARNING: something about a disk",
        "lvm fullreport exit code: 5",
        "nvme0n1 disk 476.9G 0 0 nvme gpt",
    ):
        assert line in journal
    assert "systemctl status --no-pager --full lvm2-lvmdbusd.service" in calls
    # Anaconda's own start of the service afterwards begins from a clean state.
    assert calls[-1] == "systemctl reset-failed lvm2-lvmdbusd.service"


@pytest.mark.parametrize(
    "old, new",
    [
        ("StartLimitIntervalSec=0", "StartLimitBurst=5"),
        ('systemctl reset-failed "$unit" 2>/dev/null || true\n  if answers', "if answers"),
        ("udevadm settle --timeout=60 ||", "true ||"),
        ('&&\n    systemctl --quiet is-active "$unit"', ""),
    ],
)
def test_taking_out_each_part_is_caught(tmp_path, old, new):
    pre = lvm_pre()
    assert old in pre
    found, calls, journal, _, units = run_lvm_pre(tmp_path, ["answers, then stops", "fails", "up"], pre.replace(old, new, 1))
    dropin = units / "lvm2-lvmdbusd.service.d" / "50-herald-os.conf"
    expected = run_lvm_pre(tmp_path / "expected", ["answers, then stops", "fails", "up"])
    assert (calls, journal, dropin.read_text()) != (expected[1], expected[2], (expected[4] / "lvm2-lvmdbusd.service.d" / "50-herald-os.conf").read_text())


def test_the_lvm_pre_passes_shellcheck(tmp_path):
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck is not installed")
    path = tmp_path / "pre.sh"
    path.write_text("#!/usr/bin/env bash\n" + lvm_pre())
    found = subprocess.run(["shellcheck", "--shell=bash", str(path)], capture_output=True, text=True, check=False)
    assert found.returncode == 0, found.stdout


def test_the_installer_test_installs_both_ways():
    workflow = yaml.safe_load(WORKFLOW.read_text())
    job = workflow["jobs"]["install"]
    assert job["strategy"]["matrix"]["disk"] == ["encrypted", "unencrypted"]
    assert job["strategy"]["fail-fast"] is False
    steps = {step.get("name"): step.get("run", "") for step in job["steps"]}
    kickstart_step = steps["The ISO's kickstart, unattended"]
    # The ISO's own default is what the encrypted run checks, and its layout line gives way to the run's.
    assert "--encrypted( |$)" in kickstart_step and "sed -i '/^autopart" in kickstart_step
    assert re.search(r"autopart --type=btrfs --noswap --encrypted --passphrase=\$PASSPHRASE", kickstart_step)
    assert "echo 'autopart --type=btrfs --noswap'" in kickstart_step
    disk_step = steps["The disk is encrypted, or not"]
    assert "crypto_LUKS" in disk_step and "--test-passphrase" in disk_step
    boot_step = steps["Boot what was installed"]
    assert "passphrase for disk" in boot_step and "serial.sock" in boot_step
    # The passphrase is typed over the serial console and never printed with the kickstart.
    assert re.fullmatch(r"[a-z0-9]+", job["env"]["PASSPHRASE"])
    assert 's/$PASSPHRASE/<passphrase>/' in kickstart_step
    upload = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/upload-artifact"))
    assert "${{ matrix.disk }}" in upload["with"]["name"]


def test_the_release_builds_the_iso_from_this_kickstart():
    image = (ROOT / ".github" / "workflows" / "image.yml").read_text()
    assert re.search(r"type: anaconda-iso\s+config: iso\.toml", image)
