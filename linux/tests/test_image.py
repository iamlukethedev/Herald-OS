"""Telling the Herald OS image from other bootc and ostree systems (Silverblue, Bazzite, Bluefin)."""

import importlib.machinery
import importlib.util
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_LOADER = importlib.machinery.SourceFileLoader("herald_os_image_cli", str(ROOT / "linux" / "bin" / "herald-os"))
_SPEC = importlib.util.spec_from_loader("herald_os_image_cli", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

FEDORA = 'NAME="Fedora Linux"\nVERSION_ID=44\nID=fedora\n'
SILVERBLUE = FEDORA + 'VARIANT="Silverblue"\nVARIANT_ID=silverblue\n'
HERALD = FEDORA + "IMAGE_ID=herald-os\n"
# Each machine: whether it booted from an image, its /usr/lib/os-release and whether the shell is in
# /usr/share/herald-os/app, then whether it is the Herald OS image.
MACHINES = {
    "herald-os": ((True, HERALD, False), True),
    "herald-os, quoted": ((True, FEDORA + 'IMAGE_ID="herald-os"\n', False), True),
    "herald-os before IMAGE_ID": ((True, FEDORA, True), True),
    "silverblue": ((True, SILVERBLUE, False), False),
    "bazzite": ((True, FEDORA + "IMAGE_ID=bazzite\n", False), False),
    "fedora workstation": ((False, FEDORA, False), False),
    "herald-os as a container": ((False, HERALD, True), False),
}


def machine(tmp_path, booted: bool, release: str, shell: bool) -> dict[str, Path]:
    paths = {"booted": tmp_path / "run" / "ostree-booted", "release": tmp_path / "usr" / "lib" / "os-release", "shell": tmp_path / "app.asar"}
    paths["release"].parent.mkdir(parents=True)
    paths["release"].write_text(release)
    if booted:
        paths["booted"].parent.mkdir(parents=True)
        paths["booted"].write_text("")
    if shell:
        paths["shell"].write_text("")
    return paths


def use(monkeypatch, paths: dict[str, Path]) -> None:
    monkeypatch.setattr(cli, "OSTREE_BOOTED", paths["booted"])
    monkeypatch.setattr(cli, "OS_RELEASES", (paths["release"].parent.parent / "etc-os-release", paths["release"]))
    monkeypatch.setattr(cli, "IMAGE_SHELL", paths["shell"])


@pytest.mark.parametrize("name", MACHINES)
def test_only_the_herald_os_image_is_the_image(name, tmp_path, monkeypatch):
    setup, expected = MACHINES[name]
    use(monkeypatch, machine(tmp_path, *setup))
    assert cli.is_image() is expected


@pytest.mark.parametrize("name", MACHINES)
def test_the_updater_agrees(name, tmp_path):
    setup, expected = MACHINES[name]
    paths = machine(tmp_path, *setup)
    script = (ROOT / "linux" / "bin" / "herald-os-update").read_text()
    function = re.search(r"^is_herald_image\(\) \{\n.*?^\}\n", script, re.M | re.S).group(0)
    found = subprocess.run(
        ["bash", "-c", f'OSTREE_BOOTED="{paths["booted"]}"\nOS_RELEASE=("{tmp_path / "etc-os-release"}" "{paths["release"]}")\nIMAGE_SHELL="{paths["shell"]}"\n{function}is_herald_image'],
        check=False,
    )
    assert (found.returncode == 0) is expected


def test_on_silverblue_rollback_and_channel_never_run_bootc(tmp_path, monkeypatch):
    use(monkeypatch, machine(tmp_path, True, SILVERBLUE, False))
    monkeypatch.setattr(cli, "CONFIG_DIR", tmp_path / "config")
    ran = []
    monkeypatch.setattr(cli.subprocess, "call", lambda argv, **kwargs: ran.append(argv) or 0)
    monkeypatch.setattr(cli, "sh", lambda argv, **kwargs: ran.append(argv) or subprocess.CompletedProcess(argv, 0, "{}", ""))
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    with pytest.raises(SystemExit) as stopped:
        cli.rollback()
    assert stopped.value.code == 2
    assert cli.main(["channel", "edge"]) == 0
    assert (tmp_path / "config" / "channel").read_text() == "edge\n"
    assert not [argv for argv in ran if "bootc" in argv]


def test_the_image_build_names_the_image_in_os_release():
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    assert "echo 'IMAGE_ID=herald-os' >>/usr/lib/os-release" in packages


# The NVIDIA image (ADR-029): a stage of the same Containerfile, a leg of the image workflow.

FIRSTBOOT_SCRIPT = ROOT / "linux" / "image" / "firstboot.sh"
CONTAINERFILE = ROOT / "linux" / "image" / "Containerfile"
NVIDIA = ROOT / "linux" / "image" / "nvidia.sh"


def stages() -> list[tuple[str, str]]:
    """Each FROM in the Containerfile: what it starts from, and the stage's name ('' without one)."""
    found = re.findall(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$", CONTAINERFILE.read_text(), re.M)
    return [(base, name) for base, name in found]


def test_a_build_without_a_target_is_the_default_image():
    assert stages()[-1] == ("herald-os", "")
    named = dict((name, base) for base, name in stages() if name)
    assert named["herald-os"] == "${FEDORA_BOOTC}"
    assert named["herald-os-nvidia"] == "herald-os"
    # Only the NVIDIA stage reads the akmods images, so the default build never pulls them.
    default = CONTAINERFILE.read_text().split("FROM herald-os AS herald-os-nvidia")[0].split("AS herald-os\n", 1)[1]
    assert "akmods" not in default


def test_the_akmods_images_follow_one_tag():
    text = CONTAINERFILE.read_text()
    assert "FROM ghcr.io/ublue-os/akmods:${AKMODS_TAG} AS akmods" in text
    assert "FROM ghcr.io/ublue-os/akmods-nvidia-open:${AKMODS_TAG} AS akmods-nvidia" in text


def image_job() -> dict:
    import yaml
    return yaml.safe_load((ROOT / ".github" / "workflows" / "image.yml").read_text())["jobs"]["image"]


def test_the_workflow_builds_the_nvidia_image_next_to_the_default_one():
    job = image_job()
    legs = {(leg["image"], leg["arch"]): leg for leg in job["strategy"]["matrix"]["include"]}
    assert set(legs) == {("herald-os", "amd64"), ("herald-os", "arm64"), ("herald-os-nvidia", "amd64")}
    # The default image keeps its per-architecture tags (the manifest job joins them) and its check names.
    assert legs[("herald-os", "amd64")]["suffix"] == "-amd64" and legs[("herald-os", "arm64")]["suffix"] == "-arm64"
    assert legs[("herald-os", "amd64")]["label"] == "amd64" and legs[("herald-os", "arm64")]["label"] == "arm64"
    assert legs[("herald-os-nvidia", "amd64")]["suffix"] == ""
    # Every image is a stage, built by its name.
    names = {name for _, name in stages()}
    assert {image for image, _ in legs} <= names
    build = next(step for step in job["steps"] if step.get("name") == "Build the image")["run"]
    assert '--target "${{ matrix.image }}"' in build
    # A missing NVIDIA module build never holds back the default image.
    assert job["continue-on-error"] == "${{ matrix.image == 'herald-os-nvidia' }}"
    assert job["env"]["REPO"].endswith("/${{ matrix.image }}")


def test_the_nvidia_leg_pins_the_base_and_the_modules_to_one_kernel():
    pin = next(step for step in image_job()["steps"] if step.get("name") == "Pin the base and the NVIDIA modules to one kernel")
    assert pin["if"] == "matrix.image == 'herald-os-nvidia'"
    assert '.Labels["ostree.linux"]' in pin["run"] and 'akmods="main-44-$kernel"' in pin["run"]
    assert 'echo "FEDORA_BOOTC=${base%:*}@$digest"' in pin["run"]


def test_the_signature_policy_covers_both_images():
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    for repo in ("ghcr.io/iamlukethedev/herald-os", "ghcr.io/iamlukethedev/herald-os-nvidia"):
        assert f'"{repo}"' in packages and f"  {repo}:\\n    use-sigstore-attachments: true" in packages


def fake_build(tmp_path: Path, image_kernel: str, modules_kernel: str) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in {"uname": "echo x86_64", "rpm": f'echo "{image_kernel}"', "dnf": 'echo "dnf $*" >>"$CALLS"'}.items():
        (bin_dir / name).write_text(f"#!/bin/sh\n{body}\n")
        (bin_dir / name).chmod(0o755)
    kmods = tmp_path / "akmods-nvidia" / "kmods"
    kmods.mkdir(parents=True)
    (kmods / "nvidia-vars").write_text(f'DIST_ARCH="fc44.x86_64"\nKERNEL_VERSION={modules_kernel}\nNVIDIA_AKMOD_VERSION=615.78.08-1\n')
    return subprocess.run(
        ["bash", str(NVIDIA), str(tmp_path / "akmods"), str(tmp_path / "akmods-nvidia")],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin", "CALLS": str(tmp_path / "calls")}, capture_output=True, text=True, check=False,
    )


def test_nvidia_modules_for_another_kernel_stop_the_build_before_it_installs_anything(tmp_path):
    result = fake_build(tmp_path, "7.2.11-200.fc44.x86_64", "7.2.10-200.fc44.x86_64")
    assert result.returncode == 1
    assert "built for kernel 7.2.10-200.fc44.x86_64, and this image has 7.2.11-200.fc44.x86_64" in result.stderr
    assert "AKMODS_TAG=main-44-7.2.11-200.fc44.x86_64" in result.stderr
    assert not (tmp_path / "calls").exists()


def test_the_nvidia_layer_leaves_xorg_out_and_puts_the_driver_in_the_initramfs():
    script = NVIDIA.read_text()
    assert "xorg-x11-nvidia-*" in script and "--setopt=install_weak_deps=False" in script
    assert "s@omit_drivers@force_drivers@" in script and 'dracut -f --no-hostonly' in script
    assert "--excludepath=/etc/yum.repos.d" in script
    kargs = (ROOT / "linux" / "image" / "kargs-nvidia.toml").read_text()
    assert '"rd.driver.blacklist=nouveau"' in kargs and 'match-architectures = ["x86_64"]' in kargs


# herald-os-gpu-check: an NVIDIA GPU on the default image is told how to switch to the NVIDIA image,
# and on the NVIDIA image with Secure Boot on, how to enroll the key its driver is signed with.

GPU_CHECK = ROOT / "linux" / "bin" / "herald-os-gpu-check"
NVIDIA_VGA = ("0x10de", "0x030000")
NVIDIA_3D = ("0x10de", "0x030200")
NVIDIA_AUDIO = ("0x10de", "0x040300")
INTEL_VGA = ("0x8086", "0x030000")
SECURE_BOOT_VAR = "SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"
ENROLL = "sudo mokutil --import /etc/pki/akmods/certs/akmods-ublue.der"


class Gpu:
    """A machine's PCI devices, Secure Boot state, loaded modules and image, and the session's state."""

    def __init__(self, tmp_path: Path, devices, release=HERALD, driver=False, loaded=False, secure_boot=None,
                 arch="x86_64", channel="edge"):
        self.root = tmp_path
        sysfs = tmp_path / "sys"
        for i, (vendor, cls) in enumerate(devices):
            dev = sysfs / "bus" / "pci" / "devices" / f"0000:0{i}:00.0"
            dev.mkdir(parents=True)
            (dev / "vendor").write_text(vendor + "\n")
            (dev / "class").write_text(cls + "\n")
        if loaded:
            (sysfs / "module" / "nvidia").mkdir(parents=True)
        if secure_boot is not None:
            efivars = sysfs / "firmware" / "efi" / "efivars"
            efivars.mkdir(parents=True)
            (efivars / SECURE_BOOT_VAR).write_bytes(b"\x06\x00\x00\x00" + bytes([1 if secure_boot else 0]))
        modules = tmp_path / "modules" / "7.2.10-200.fc44.x86_64" / "extra" / "nvidia"
        modules.mkdir(parents=True)
        if driver:
            (modules / "nvidia.ko.xz").write_text("")
        (tmp_path / "os-release").write_text(release)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        (bin_dir / "herald-os").write_text(f'#!/bin/sh\n[ "$1" = channel ] && {{ echo {channel}; exit 0; }}\necho "$@" >>"{tmp_path / "notified"}"\n')
        (bin_dir / "herald-os").chmod(0o755)
        self.state = tmp_path / "state"
        self.env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HERALD_OS_SYSFS": str(sysfs), "HERALD_OS_MODULES": str(tmp_path / "modules"),
                    "HERALD_OS_OS_RELEASE": str(tmp_path / "os-release"), "HERALD_OS_ARCH": arch, "HERALD_OS_STATE": str(self.state)}

    def run(self, notify=True) -> str:
        argv = ["bash", str(GPU_CHECK)] + (["--notify"] if notify else [])
        result = subprocess.run(argv, env=self.env, capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        return result.stdout

    def notified(self) -> list[str]:
        path = self.root / "notified"
        return path.read_text().splitlines() if path.exists() else []


@pytest.mark.parametrize("devices", [[NVIDIA_VGA], [INTEL_VGA, NVIDIA_3D]], ids=["desktop", "hybrid laptop"])
def test_an_nvidia_gpu_on_the_default_image_is_told_how_to_switch(tmp_path, devices):
    gpu = Gpu(tmp_path, devices)
    assert "sudo bootc switch ghcr.io/iamlukethedev/herald-os-nvidia:edge" in gpu.run()
    [shown] = gpu.notified()
    assert shown.startswith("notify NVIDIA graphics found ") and "herald-os-nvidia:edge" in shown


@pytest.mark.parametrize("devices", [[NVIDIA_VGA], [INTEL_VGA, NVIDIA_3D]], ids=["desktop", "hybrid laptop"])
def test_the_nvidia_image_with_secure_boot_and_no_driver_loaded_is_told_how_to_enroll_the_key(tmp_path, devices):
    gpu = Gpu(tmp_path, devices, driver=True, secure_boot=True)
    out = gpu.run()
    assert ENROLL in out and "Enroll MOK, Continue, Yes" in out and "bootc switch" not in out
    [shown] = gpu.notified()
    assert shown.startswith("notify The NVIDIA driver did not load ") and ENROLL in shown


@pytest.mark.parametrize("case", ["no nvidia", "nvidia audio only", "nvidia image without secure boot",
                                  "nvidia image, efi says secure boot is off", "nvidia image, driver loaded",
                                  "not the image", "arm"])
def test_nothing_is_said_where_there_is_nothing_to_do(tmp_path, case):
    args = {
        "no nvidia": dict(devices=[INTEL_VGA]),
        "nvidia audio only": dict(devices=[INTEL_VGA, NVIDIA_AUDIO]),
        "nvidia image without secure boot": dict(devices=[NVIDIA_VGA], driver=True),
        "nvidia image, efi says secure boot is off": dict(devices=[NVIDIA_VGA], driver=True, secure_boot=False),
        "nvidia image, driver loaded": dict(devices=[NVIDIA_VGA], driver=True, loaded=True, secure_boot=True),
        "not the image": dict(devices=[NVIDIA_VGA], release=FEDORA, driver=True, secure_boot=True),
        "arm": dict(devices=[NVIDIA_VGA], arch="aarch64"),
    }[case]
    gpu = Gpu(tmp_path, **args)
    assert gpu.run() == "" and gpu.notified() == []


def test_each_notice_is_shown_once_and_a_switch_does_not_hide_the_next(tmp_path):
    gpu = Gpu(tmp_path, [NVIDIA_VGA])
    gpu.run()
    gpu.run()
    assert len(gpu.notified()) == 1
    # After the switch to the NVIDIA image, the Secure Boot notice is a new one.
    (tmp_path / "modules" / "7.2.10-200.fc44.x86_64" / "extra" / "nvidia" / "nvidia.ko.xz").write_text("")
    efivars = tmp_path / "sys" / "firmware" / "efi" / "efivars"
    efivars.mkdir(parents=True)
    (efivars / SECURE_BOOT_VAR).write_bytes(b"\x06\x00\x00\x00\x01")
    gpu.run()
    gpu.run()
    first, second = gpu.notified()
    assert first.startswith("notify NVIDIA graphics found ") and second.startswith("notify The NVIDIA driver did not load ")
    assert sorted(p.name for p in gpu.state.iterdir()) == ["gpu-notice-secure-boot", "gpu-notice-switch"]


def test_a_switch_notice_shown_by_the_earlier_session_is_not_shown_again(tmp_path):
    gpu = Gpu(tmp_path, [NVIDIA_VGA])
    gpu.state.mkdir()
    (gpu.state / "gpu-check-done").write_text("")
    assert "bootc switch" in gpu.run() and gpu.notified() == []


def test_without_a_channel_the_advice_is_stable(tmp_path):
    gpu = Gpu(tmp_path, [NVIDIA_VGA], channel="")
    assert "herald-os-nvidia:stable" in gpu.run(notify=False) and gpu.notified() == []


def test_the_first_boot_and_every_session_run_the_gpu_check():
    assert "herald-os-gpu-check || true" in FIRSTBOOT_SCRIPT.read_text()
    session = (ROOT / "linux" / "session" / "herald-os-session").read_text()
    assert 'herald-os-gpu-check --notify >>"$LOG_DIR/gpu-check.log" 2>&1\n' in session
    assert "gpu-check-done" not in session


def test_the_session_and_the_gpu_check_keep_state_in_one_folder():
    session = (ROOT / "linux" / "session" / "herald-os-session").read_text()
    assert 'LOG_DIR="$HOME/.local/state/herald-os"' in session
    assert 'STATE="${HERALD_OS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/herald-os}"' in GPU_CHECK.read_text()
