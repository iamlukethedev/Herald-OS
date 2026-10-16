"""Telling the Herald OS image from other bootc and ostree systems (Silverblue, Bazzite, Bluefin)."""

import importlib.machinery
import importlib.util
import re
import shutil
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


# The NVIDIA image (ADR-029): Containerfile.nvidia on top of the default image, a leg of the workflow.

FIRSTBOOT_SCRIPT = ROOT / "linux" / "image" / "firstboot.sh"
CONTAINERFILE = ROOT / "linux" / "image" / "Containerfile"
CONTAINERFILE_NVIDIA = ROOT / "linux" / "image" / "Containerfile.nvidia"
NVIDIA = ROOT / "linux" / "image" / "nvidia.sh"
UBLUE_COSIGN = ROOT / "linux" / "image" / "ublue-os-akmods-cosign.pub"


def froms(path: Path) -> list[tuple[str, str]]:
    """Each FROM: what it starts from, and the stage's name ('' without one)."""
    return re.findall(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$", path.read_text(), re.M)


def test_the_default_image_never_refers_to_the_akmods_images():
    # One stage, so no builder's handling of unused stages can make the default build pull them.
    assert froms(CONTAINERFILE) == [("${FEDORA_BOOTC}", "")]
    assert "ARG FEDORA_BOOTC=quay.io/fedora/fedora-bootc:44" in CONTAINERFILE.read_text()
    assert "akmods" not in CONTAINERFILE.read_text().split("ARG FEDORA_BOOTC", 1)[1]


def test_the_nvidia_image_starts_from_the_default_one_and_the_akmods_images_it_is_given():
    assert froms(CONTAINERFILE_NVIDIA) == [("${AKMODS_REF}", "akmods"), ("${AKMODS_NVIDIA_REF}", "akmods-nvidia"), ("${HERALD_OS}", "")]
    text = CONTAINERFILE_NVIDIA.read_text()
    for name in ("nvidia.sh", "kargs-nvidia.toml", "negativo17.asc", "nvidia-container-toolkit.asc"):
        assert f"linux/image/{name}" in text and (ROOT / "linux" / "image" / name).is_file()


def image_job() -> dict:
    import yaml
    return yaml.safe_load((ROOT / ".github" / "workflows" / "image.yml").read_text())["jobs"]["image"]


def step(name: str) -> dict:
    return next(s for s in image_job()["steps"] if s.get("name") == name)


def test_the_workflow_builds_the_nvidia_image_next_to_the_default_one():
    job = image_job()
    legs = {(leg["image"], leg["arch"]): leg for leg in job["strategy"]["matrix"]["include"]}
    assert set(legs) == {("herald-os", "amd64"), ("herald-os", "arm64"), ("herald-os-nvidia", "amd64")}
    # The default image keeps its per-architecture tags (the manifest job joins them) and its check names.
    assert legs[("herald-os", "amd64")]["suffix"] == "-amd64" and legs[("herald-os", "arm64")]["suffix"] == "-arm64"
    assert legs[("herald-os", "amd64")]["label"] == "amd64" and legs[("herald-os", "arm64")]["label"] == "arm64"
    assert legs[("herald-os-nvidia", "amd64")]["suffix"] == ""
    build = step("Build the image")["run"]
    assert build.count("-f linux/image/Containerfile ") == 2 and "-f linux/image/Containerfile.nvidia" in build
    assert '--build-arg "AKMODS_REF=$AKMODS_REF" --build-arg "AKMODS_NVIDIA_REF=$AKMODS_NVIDIA_REF"' in build
    assert '--build-arg "FEDORA_BOOTC=$FEDORA_BOOTC"' in build
    # A missing NVIDIA module build never holds back the default image, and does not go unseen.
    assert job["continue-on-error"] == "${{ matrix.image == 'herald-os-nvidia' }}"
    assert job["env"]["REPO"].endswith("/${{ matrix.image }}")
    said = step("Say that the NVIDIA image did not go out")
    assert said["if"] == "failure() && matrix.image == 'herald-os-nvidia'"
    assert "::warning" in said["run"] and '>>"$GITHUB_STEP_SUMMARY"' in said["run"]


def test_the_nvidia_leg_makes_room_first_and_says_how_much_there_is():
    names = [s.get("name") or s.get("uses") for s in image_job()["steps"]]
    assert names[:2] == ["actions/checkout@v7", "Make room for the NVIDIA image"]
    room = step("Make room for the NVIDIA image")
    assert room["if"] == "matrix.image == 'herald-os-nvidia'" and room["run"].rstrip().endswith("df -h .")


def test_the_nvidia_leg_pins_every_image_by_digest_and_checks_universal_blues_signatures():
    pin = step("Pin the base and the NVIDIA modules to one kernel")
    run = pin["run"]
    assert pin["if"] == "matrix.image == 'herald-os-nvidia'"
    assert '.Labels["ostree.linux"]' in run and 'tag="ghcr.io/ublue-os/$repo:main-44-$kernel"' in run
    assert 'echo "FEDORA_BOOTC=${base%:*}@$digest"' in run
    assert 'ref="ghcr.io/ublue-os/$repo@$(jq -r .Digest <<<"$inspect")"' in run
    assert 'cosign verify --key linux/image/ublue-os-akmods-cosign.pub "$ref"' in run
    assert 'echo "$tag is $ref (signature verified)"' in run and "AKMODS_NVIDIA_REF" in run
    # cosign is there for this leg even while the project does not sign its own images.
    installer = next(s for s in image_job()["steps"] if s.get("uses", "").startswith("sigstore/cosign-installer"))
    assert installer["if"] == "env.SIGNING == 'true' || matrix.image == 'herald-os-nvidia'"
    assert image_job()["steps"].index(installer) < image_job()["steps"].index(pin)


def test_universal_blues_cosign_key_is_the_one_they_publish():
    # https://github.com/ublue-os/akmods/raw/main/cosign.pub, as fetched; a change here is a review item.
    import hashlib
    data = UBLUE_COSIGN.read_bytes()
    assert data.startswith(b"-----BEGIN PUBLIC KEY-----")
    assert hashlib.sha256(data).hexdigest() == "af78ecfda6eb21c35195af3739341715e9cfc3f2f5911dd9c10b0670547bf6e8"
    # Not the project's own cosign.pub, which turns on the image's signature policy.
    assert UBLUE_COSIGN.name != "cosign.pub"


@pytest.mark.skipif(shutil.which("gpg") is None, reason="needs gpg to read the committed keys")
@pytest.mark.parametrize("name,variable", [("negativo17.asc", "NEGATIVO17_KEY"), ("nvidia-container-toolkit.asc", "NVIDIA_KEY")])
def test_the_committed_repository_keys_are_the_ones_nvidia_sh_pins(tmp_path, name, variable):
    shown = subprocess.run(["gpg", "--homedir", str(tmp_path), "--show-keys", "--with-colons", str(ROOT / "linux" / "image" / name)],
                           capture_output=True, text=True, check=True).stdout
    primary = next(line.split(":")[9] for line in shown.splitlines() if line.startswith("fpr:"))
    pinned = re.search(rf"^{variable}=([0-9a-f]{{40}})$", NVIDIA.read_text(), re.M).group(1)
    assert primary.lower() == pinned


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
    assert "main-44-7.2.11-200.fc44.x86_64" in result.stderr
    assert not (tmp_path / "calls").exists()


def test_the_nvidia_layer_leaves_xorg_out_and_puts_the_driver_in_the_initramfs():
    script = NVIDIA.read_text()
    assert "xorg-x11-nvidia-*" in script and "--setopt=install_weak_deps=False" in script
    assert "s@omit_drivers@force_drivers@" in script and 'dracut -f --no-hostonly' in script
    assert "--excludepath=/etc/yum.repos.d" in script
    kargs = (ROOT / "linux" / "image" / "kargs-nvidia.toml").read_text()
    assert '"rd.driver.blacklist=nouveau"' in kargs and 'match-architectures = ["x86_64"]' in kargs


def test_the_nvidia_layer_checks_the_key_people_enroll_and_what_it_installs():
    script = NVIDIA.read_text()
    assert "KEY_SHA256=4e5c68474cb133fd8984d9599762cece9100c3e6cd8a9709aeaabd85dd9e70d1" in script
    assert 'echo "$KEY_SHA256  $KEY" | sha256sum --quiet -c -' in script
    assert '--setopt="fedora-nvidia.gpgkey=file://$HERE/negativo17.asc"' in script
    assert '--setopt="nvidia-container-toolkit.gpgkey=file://$HERE/nvidia-container-toolkit.asc"' in script
    assert "rpm -K \"$rpm\" | grep -q ' signatures OK$'" in script


# The repository files as ublue-os-nvidia-addons ships them (0.15), trimmed to what the checks read.
ADDON_REPOS = {
    "negativo17-fedora-nvidia.repo": "[fedora-nvidia]\nenabled=0\ngpgcheck=1\nrepo_gpgcheck=0\n"
                                     "[fedora-nvidia-source]\nenabled=0\ngpgcheck=1\n[fedora-nvidia-debug]\nenabled=0\ngpgcheck=1\n",
    "negativo17-fedora-nvidia-lts.repo": "[fedora-nvidia-lts]\nenabled=0\ngpgcheck=1\n",
    "nvidia-container-toolkit.repo": "[nvidia-container-toolkit]\nrepo_gpgcheck=1\ngpgcheck=1\nenabled=0\n"
                                     "[nvidia-container-toolkit-experimental]\nrepo_gpgcheck=1\ngpgcheck=1\nenabled=0\n",
}


def repo_check(tmp_path: Path, check: str, change=None) -> subprocess.CompletedProcess:
    repos = tmp_path / "yum.repos.d"
    repos.mkdir(parents=True)
    for name, text in ADDON_REPOS.items():
        (repos / name).write_text(text)
    if change:
        change(repos)
    script = NVIDIA.read_text()
    function = re.search(rf"^{check}\(\) \{{\n.*?^\}}\n", script, re.M | re.S).group(0)
    return subprocess.run(["bash", "-c", f'REPOS="{repos}"\n{function}{check}'], capture_output=True, text=True, check=False)


def test_the_addon_repositories_as_shipped_are_signed_and_stay_disabled(tmp_path):
    assert repo_check(tmp_path / "a", "repos_signed").returncode == 0
    assert repo_check(tmp_path / "b", "repos_disabled").returncode == 0


@pytest.mark.parametrize("check,change,said", [
    ("repos_signed", lambda d: (d / "negativo17-fedora-nvidia.repo").write_text("[fedora-nvidia]\ngpgcheck=0\n"), "[fedora-nvidia] has no gpgcheck=1"),
    ("repos_signed", lambda d: (d / "nvidia-container-toolkit.repo").write_text("[nvidia-container-toolkit]\ngpgcheck=1\nrepo_gpgcheck=0\n"), "no repo_gpgcheck=1"),
    ("repos_signed", lambda d: (d / "nvidia-container-toolkit.repo").unlink(), "nvidia-container-toolkit.repo is missing"),
    ("repos_disabled", lambda d: (d / "negativo17-fedora-nvidia.repo").write_text("[fedora-nvidia]\nenabled=1\n"), "negativo17-fedora-nvidia.repo [fedora-nvidia]"),
    ("repos_disabled", lambda d: (d / "nvidia-container-toolkit.repo").write_text("[nvidia-container-toolkit]\ngpgcheck=1\n"), "[nvidia-container-toolkit]"),
    ("repos_disabled", lambda d: (d / "_copr_ublue-os-akmods.repo").write_text("[copr]\nenabled=1\n"), "_copr_ublue-os-akmods.repo"),
], ids=["negativo17 unsigned", "toolkit metadata unsigned", "toolkit missing", "negativo17 enabled", "enabled by default", "copr"])
def test_the_repository_checks_stop_the_build(tmp_path, check, change, said):
    result = repo_check(tmp_path, check, change)
    assert result.returncode != 0 and said in result.stderr


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
