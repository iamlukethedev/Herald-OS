"""The ready-made VM disks: x86_64 and aarch64 qcow2, the Hyper-V VHDX and the UTM bundle (#67)."""

import fnmatch
import hashlib
import importlib.machinery
import importlib.util
import os
import plistlib
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
VM = ROOT / "linux" / "vm"
PACKAGE = VM / "package-disk.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "image.yml"
README = ROOT / "README.md"

_LOADER = importlib.machinery.SourceFileLoader("herald_os_make_utm", str(VM / "make-utm.py"))
utm = importlib.util.module_from_spec(importlib.util.spec_from_loader("herald_os_make_utm", _LOADER))
_LOADER.exec_module(utm)

linux_only = pytest.mark.skipif(
    sys.platform != "linux" or shutil.which("zip") is None,
    reason="package-disk.sh runs on the image workflow's Linux runners (GNU coreutils and zip)",
)

# qemu-img and zstd stand-ins: each copies its input to its output and logs its arguments.
STUB = """#!/usr/bin/env bash
printf '%s\\n' "$*" >>"{log}"
args=("$@")
if [[ "$(basename "$0")" == zstd ]]; then
  for ((i = 0; i < ${{#args[@]}}; i++)); do [[ "${{args[i]}}" == -o ]] && out="${{args[i+1]}}"; done
  in="${{args[${{#args[@]}} - 3]}}"
else
  in="${{args[${{#args[@]}} - 2]}}"; out="${{args[${{#args[@]}} - 1]}}"
fi
cp "$in" "$out"
"""


def stubs(tmp_path: Path) -> tuple[Path, Path]:
    bin_dir, log = tmp_path / "bin", tmp_path / "tools.log"
    bin_dir.mkdir()
    for tool in ("qemu-img", "zstd"):
        (bin_dir / tool).write_text(STUB.format(log=log))
        (bin_dir / tool).chmod(0o755)
    return bin_dir, log


def builder_output(tmp_path: Path, kind: str, data: bytes = b"herald-os disk\n" * 64) -> Path:
    out = tmp_path / "output"
    path = out / ("bootiso/install.iso" if kind == "iso" else "qcow2/disk.qcow2")
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    return out


def package(tmp_path: Path, out: Path, arch: str, env: dict | None = None, version: str = "9.9.9") -> subprocess.CompletedProcess:
    bin_dir, _ = stubs(tmp_path)
    full_env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", **(env or {})}
    return subprocess.run(
        ["bash", str(PACKAGE), str(out), arch, version, str(tmp_path / "dist")],
        capture_output=True, text=True, env=full_env, check=False,
    )


def files(tmp_path: Path) -> list[str]:
    return sorted(p.name for p in (tmp_path / "dist").iterdir())


def checksum_matches(dist: Path, name: str, parts: list[str] | None = None) -> bool:
    digest, listed = (dist / f"{name}.sha256").read_text().split()
    data = b"".join((dist / p).read_bytes() for p in (parts or [name]))
    return listed == name and digest == hashlib.sha256(data).hexdigest()


# The release workflow.


def disks_job() -> dict:
    return yaml.safe_load(WORKFLOW.read_text())["jobs"]["disks"]


def test_the_release_builds_a_vm_disk_for_both_architectures():
    entries = {(e["arch"], e["type"]): e for e in disks_job()["strategy"]["matrix"]["include"]}
    assert set(entries) == {("amd64", "anaconda-iso"), ("amd64", "qcow2"), ("arm64", "qcow2")}
    assert entries[("amd64", "qcow2")]["config"] == entries[("arm64", "qcow2")]["config"] == "disk.toml"
    assert entries[("amd64", "qcow2")]["runner"] == "ubuntu-24.04"
    assert entries[("arm64", "qcow2")]["runner"] == "ubuntu-24.04-arm"


def test_the_disks_job_packages_with_the_script_and_uploads_what_it_made():
    steps = disks_job()["steps"]
    runs = "\n".join(step.get("run", "") for step in steps)
    assert 'bash linux/vm/package-disk.sh output "${{ matrix.arch }}" "$version" dist' in runs
    room = next(step for step in steps if step.get("name") == "Make room for the VM disks")
    assert room["if"] == "matrix.type == 'qcow2'"
    assert all(tool in room["run"] for tool in ("qemu-utils", "zip", "zstd"))
    build = next(step for step in steps if step.get("name") == "Build the disk with bootc-image-builder")["run"]
    assert build.index("sudo podman rmi --ignore") > build.index("bootc-image-builder@sha256:")
    rmi = build[build.index("sudo podman rmi"):]
    assert '"$IMAGE:$CHANNEL-${{ matrix.arch }}"' in rmi and "quay.io/centos-bootc/bootc-image-builder@sha256:" in rmi
    pack = next(step for step in steps if step.get("name") == "Name, compress and split it")["run"]
    assert pack.rstrip().endswith("df -h .")
    upload = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact"))
    assert upload["with"]["path"] == "dist/herald-os-*"
    assert upload["with"]["name"] == "herald-os-${{ matrix.type }}-${{ matrix.arch }}"


# package-disk.sh.


@linux_only
def test_an_x86_64_disk_becomes_a_qcow2_and_a_hyper_v_vhdx(tmp_path):
    result = package(tmp_path, builder_output(tmp_path, "qcow2"), "amd64")
    assert result.returncode == 0, result.stderr
    assert files(tmp_path) == [
        "herald-os-9.9.9-x86_64.qcow2.zst", "herald-os-9.9.9-x86_64.qcow2.zst.sha256",
        "herald-os-9.9.9-x86_64.vhdx.zip", "herald-os-9.9.9-x86_64.vhdx.zip.sha256",
    ]
    dist = tmp_path / "dist"
    assert checksum_matches(dist, "herald-os-9.9.9-x86_64.qcow2.zst")
    assert checksum_matches(dist, "herald-os-9.9.9-x86_64.vhdx.zip")
    with zipfile.ZipFile(dist / "herald-os-9.9.9-x86_64.vhdx.zip") as z:
        assert z.namelist() == ["herald-os-9.9.9-x86_64.vhdx"]
    log = (tmp_path / "tools.log").read_text()
    assert re.search(r"^convert -O vhdx -o subformat=dynamic \S+/disk\.qcow2 \S+\.vhdx$", log, re.M)
    assert re.search(r"^-T0 -19 -q \S+/disk\.qcow2 -o \S+x86_64\.qcow2\.zst$", log, re.M)


@linux_only
def test_an_aarch64_disk_becomes_a_qcow2_and_a_utm_bundle(tmp_path):
    disk = b"aarch64 disk\n" * 64
    result = package(tmp_path, builder_output(tmp_path, "qcow2", disk), "arm64")
    assert result.returncode == 0, result.stderr
    assert files(tmp_path) == [
        "herald-os-9.9.9-aarch64.qcow2.zst", "herald-os-9.9.9-aarch64.qcow2.zst.sha256",
        "herald-os-9.9.9-aarch64.utm.zip", "herald-os-9.9.9-aarch64.utm.zip.sha256",
    ]
    dist = tmp_path / "dist"
    assert checksum_matches(dist, "herald-os-9.9.9-aarch64.utm.zip")
    with zipfile.ZipFile(dist / "herald-os-9.9.9-aarch64.utm.zip") as z:
        assert sorted(n for n in z.namelist() if not n.endswith("/")) == [
            "Herald OS.utm/Data/herald-os.qcow2", "Herald OS.utm/config.plist",
        ]
        assert z.read("Herald OS.utm/Data/herald-os.qcow2") == disk
        assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())
        config = plistlib.loads(z.read("Herald OS.utm/config.plist"))
    assert config["Information"]["Notes"].startswith("Herald OS Linux 9.9.9.")
    assert re.search(r"^convert -c -O qcow2 \S+/disk\.qcow2 \S+/herald-os\.qcow2$", (tmp_path / "tools.log").read_text(), re.M)
    assert "vhdx" not in (tmp_path / "tools.log").read_text()


@linux_only
def test_the_installer_iso_is_named_and_gets_no_vm_files(tmp_path):
    result = package(tmp_path, builder_output(tmp_path, "iso"), "amd64")
    assert result.returncode == 0, result.stderr
    assert files(tmp_path) == ["herald-os-9.9.9-x86_64.iso", "herald-os-9.9.9-x86_64.iso.sha256"]
    assert not (tmp_path / "tools.log").exists()


@linux_only
def test_big_files_are_split_the_way_their_tools_join_them(tmp_path):
    # Incompressible, so the zip of it is as big as the disk: 10 KiB in 4 KiB parts is three of each.
    disk = b"".join(hashlib.sha256(i.to_bytes(2, "big")).digest() for i in range(320))
    result = package(tmp_path, builder_output(tmp_path, "qcow2", disk), "amd64",
                     {"SPLIT_AT": "4096", "PART_SIZE": "4096"})
    assert result.returncode == 0, result.stderr
    dist, names = tmp_path / "dist", files(tmp_path)
    qcow2_parts = [n for n in names if re.fullmatch(r"herald-os-9\.9\.9-x86_64\.qcow2\.zst\.part\d", n)]
    zip_parts = [n for n in names if re.fullmatch(r"herald-os-9\.9\.9-x86_64\.vhdx\.zip\.\d{3}", n)]
    assert qcow2_parts == ["herald-os-9.9.9-x86_64.qcow2.zst.part0", "herald-os-9.9.9-x86_64.qcow2.zst.part1", "herald-os-9.9.9-x86_64.qcow2.zst.part2"]
    assert zip_parts == ["herald-os-9.9.9-x86_64.vhdx.zip.001", "herald-os-9.9.9-x86_64.vhdx.zip.002", "herald-os-9.9.9-x86_64.vhdx.zip.003"]
    assert "herald-os-9.9.9-x86_64.qcow2.zst" not in names and "herald-os-9.9.9-x86_64.vhdx.zip" not in names
    assert checksum_matches(dist, "herald-os-9.9.9-x86_64.qcow2.zst", qcow2_parts)
    assert checksum_matches(dist, "herald-os-9.9.9-x86_64.vhdx.zip", zip_parts)
    assert sorted(n for n in names if n.endswith(".sha256sums")) == [
        "herald-os-9.9.9-x86_64.qcow2.zst.sha256sums", "herald-os-9.9.9-x86_64.vhdx.zip.sha256sums",
    ]
    for name, parts in (("herald-os-9.9.9-x86_64.qcow2.zst", qcow2_parts), ("herald-os-9.9.9-x86_64.vhdx.zip", zip_parts)):
        lines = [line.split() for line in (dist / f"{name}.sha256sums").read_text().splitlines()]
        assert [listed for _, listed in lines] == parts
        assert all(digest == hashlib.sha256((dist / part).read_bytes()).hexdigest() for digest, part in lines)


@linux_only
def test_the_documented_commands_check_the_parts_join_them_and_check_the_whole(tmp_path):
    disk = b"".join(hashlib.sha256(i.to_bytes(2, "big")).digest() for i in range(320))
    env = {"SPLIT_AT": "4096", "PART_SIZE": "4096"}
    assert package(tmp_path, builder_output(tmp_path, "qcow2", disk), "amd64", env).returncode == 0
    dist = tmp_path / "dist"
    script = """set -e
    sha256sum -c --quiet herald-os-9.9.9-x86_64.qcow2.zst.sha256sums
    sha256sum -c --quiet herald-os-9.9.9-x86_64.vhdx.zip.sha256sums
    cat herald-os-9.9.9-x86_64.qcow2.zst.part* > herald-os-9.9.9-x86_64.qcow2.zst
    cat herald-os-9.9.9-x86_64.vhdx.zip.[0-9][0-9][0-9] > herald-os-9.9.9-x86_64.vhdx.zip
    sha256sum -c --quiet herald-os-9.9.9-x86_64.qcow2.zst.sha256
    sha256sum -c --quiet herald-os-9.9.9-x86_64.vhdx.zip.sha256
    """
    result = subprocess.run(["bash", "-c", script], cwd=dist, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (dist / "herald-os-9.9.9-x86_64.qcow2.zst").read_bytes() == disk

    (dist / "herald-os-9.9.9-x86_64.vhdx.zip.002").write_bytes(b"damaged")
    damaged = subprocess.run(["sha256sum", "-c", "--quiet", "herald-os-9.9.9-x86_64.vhdx.zip.sha256sums"],
                             cwd=dist, capture_output=True, text=True, check=False)
    assert damaged.returncode != 0
    assert "herald-os-9.9.9-x86_64.vhdx.zip.002: FAILED" in damaged.stdout


@linux_only
@pytest.mark.parametrize("arch, leftovers", [("amd64", (".vhdx", "disk.qcow2")), ("arm64", ("Herald OS.utm", "disk.qcow2"))])
def test_the_disk_and_the_conversions_are_gone_before_the_zip_is_checksummed(tmp_path, arch, leftovers):
    # A sha256sum that first lists every file packaging still holds, under the output and dist.
    real = shutil.which("sha256sum")
    seen = tmp_path / "seen.log"
    out = builder_output(tmp_path, "qcow2")
    stubs(tmp_path)
    (tmp_path / "bin" / "sha256sum").write_text(
        f'#!/usr/bin/env bash\necho "== $*" >>"{seen}"\nfind "{out}" "{tmp_path / "dist"}" >>"{seen}"\nexec "{real}" "$@"\n')
    (tmp_path / "bin" / "sha256sum").chmod(0o755)
    full_env = {**os.environ, "PATH": f"{tmp_path / 'bin'}:{os.environ['PATH']}"}
    result = subprocess.run(["bash", str(PACKAGE), str(out), arch, "9.9.9", str(tmp_path / "dist")],
                            capture_output=True, text=True, env=full_env, check=False)
    assert result.returncode == 0, result.stderr
    at_zip = seen.read_text().split("== herald-os-9.9.9-")[2]
    assert ".zip" in at_zip.splitlines()[0]
    held = at_zip.splitlines()[1:]
    assert any(line.endswith(".zip") for line in held)
    for leftover in leftovers:
        assert not [line for line in held if line.endswith(leftover)]
    assert not (out / "qcow2" / "disk.qcow2").exists()


@linux_only
def test_no_work_files_are_left_behind_for_the_upload(tmp_path):
    assert package(tmp_path, builder_output(tmp_path, "qcow2"), "arm64").returncode == 0
    assert not [p for p in (tmp_path / "dist").iterdir() if not p.name.startswith("herald-os-")]


@linux_only
@pytest.mark.parametrize("version", ["1.0 beta", "../1.0", "1.0/2", "1.0;rm -rf x", "1.0*", "$(id)", "", "1.0\n"])
def test_a_version_that_is_not_one_plain_word_is_refused_before_anything_is_written(tmp_path, version):
    out = builder_output(tmp_path, "qcow2")
    result = package(tmp_path, out, "amd64", version=version)
    assert result.returncode == 2
    assert "may only use letters, digits, '.', '_' and '-'" in result.stderr
    assert not (tmp_path / "dist").exists()
    assert (out / "qcow2" / "disk.qcow2").exists()
    assert not (tmp_path / "tools.log").exists()


@linux_only
@pytest.mark.parametrize("version", ["0.1.0-alpha.5", "edge-abc1234", "dev-1a2b3c4", "1_0"])
def test_release_and_channel_versions_are_accepted(tmp_path, version):
    result = package(tmp_path, builder_output(tmp_path, "iso"), "amd64", version=version)
    assert result.returncode == 0, result.stderr
    assert files(tmp_path) == [f"herald-os-{version}-x86_64.iso", f"herald-os-{version}-x86_64.iso.sha256"]


@linux_only
@pytest.mark.parametrize("arch, kind, message", [
    ("riscv64", "qcow2", "unknown architecture riscv64"),
    ("arm64", "iso", "the installer ISO is x86_64 only"),
    ("amd64", None, "no installer ISO or qcow2"),
])
def test_what_it_cannot_package_it_refuses(tmp_path, arch, kind, message):
    out = builder_output(tmp_path, kind) if kind else tmp_path / "empty"
    result = package(tmp_path, out, arch)
    assert result.returncode != 0
    assert message in result.stderr


def test_try_sh_still_finds_only_the_aarch64_qcow2():
    pattern = re.search(r"grep -E -o '\"browser_download_url\": \*\"\[\^\"\]\*(.*?)\"'", (VM / "try.sh").read_text()).group(1)
    found = re.compile(pattern + "$")
    assert found.search("herald-os-1.0-aarch64.qcow2.zst")
    assert found.search("herald-os-1.0-aarch64.qcow2.zst.part1")
    for other in ("herald-os-1.0-aarch64.utm.zip", "herald-os-1.0-aarch64.utm.zip.001",
                  "herald-os-1.0-x86_64.qcow2.zst", "herald-os-1.0-x86_64.vhdx.zip.001"):
        assert not found.search(other)


# make-utm.py.


def test_the_utm_bundle_runs_on_apples_hypervisor_with_gpu_sound_clipboard_and_resizing(tmp_path):
    disk = tmp_path / "disk.qcow2"
    disk.write_bytes(b"qcow2")
    bundle = utm.make(disk, tmp_path / "out", version="1.2.3")
    assert bundle == tmp_path / "out" / "Herald OS.utm"
    config = plistlib.loads((bundle / "config.plist").read_bytes())
    assert config["Backend"] == "QEMU" and config["ConfigurationVersion"] == 4
    assert config["System"]["Architecture"] == "aarch64" and config["System"]["Target"] == "virt"
    assert config["QEMU"]["Hypervisor"] is True and config["QEMU"]["UEFIBoot"] is True
    assert config["System"]["CPUCount"] == 4 and config["System"]["MemorySize"] == 6144
    [display] = config["Display"]
    assert display["Hardware"] == "virtio-gpu-gl-pci" and display["DynamicResolution"] is True
    assert config["Sharing"]["ClipboardSharing"] is True
    assert config["Sound"] == [{"Hardware": "intel-hda"}]
    assert config["Network"][0]["Mode"] == "Shared"
    [drive] = config["Drive"]
    assert drive["Interface"] == "VirtIO" and drive["ImageType"] == "Disk"
    assert (bundle / "Data" / drive["ImageName"]).read_bytes() == b"qcow2"
    assert disk.exists()


def test_the_same_version_gives_the_same_bundle_and_another_version_another_vm(tmp_path):
    disk = tmp_path / "disk.qcow2"
    disk.write_bytes(b"qcow2")
    first = (utm.make(disk, tmp_path / "a", version="1.0") / "config.plist").read_bytes()
    again = (utm.make(disk, tmp_path / "b", version="1.0") / "config.plist").read_bytes()
    other = plistlib.loads((utm.make(disk, tmp_path / "c", version="1.1") / "config.plist").read_bytes())
    assert first == again
    config = plistlib.loads(first)
    assert config["Information"]["UUID"] != other["Information"]["UUID"]
    assert config["Drive"][0]["Identifier"] != other["Drive"][0]["Identifier"]
    assert re.fullmatch(r"52:54:00(:[0-9a-f]{2}){3}", config["Network"][0]["MacAddress"])


def test_move_takes_the_disk_and_an_existing_bundle_is_never_replaced(tmp_path):
    disk = tmp_path / "disk.qcow2"
    disk.write_bytes(b"qcow2")
    assert utm.main(["--move", "--name", "Try", str(disk), str(tmp_path)]) == 0
    assert not disk.exists()
    assert (tmp_path / "Try.utm" / "Data" / "herald-os.qcow2").read_bytes() == b"qcow2"
    disk.write_bytes(b"newer")
    with pytest.raises(SystemExit, match="already exists"):
        utm.make(disk, tmp_path, name="Try")
    assert (tmp_path / "Try.utm" / "Data" / "herald-os.qcow2").read_bytes() == b"qcow2"
    with pytest.raises(SystemExit, match="no disk"):
        utm.make(tmp_path / "missing.qcow2", tmp_path / "elsewhere")


# The README.


def anchors(markdown: str) -> set[str]:
    def slug(heading: str) -> str:
        return re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")
    return {slug(m.group(1)) for m in re.finditer(r"^#{1,6} (.+)$", markdown, re.M)}


def test_the_install_table_lists_the_mac_and_windows_virtual_machines():
    text = README.read_text()
    table = text.split("## Install", 1)[1].split("\n\n")[2]
    rows = {row.split("|")[1].strip(): row.split("|")[2] for row in table.splitlines()[2:]}
    windows = next(v for k, v in rows.items() if "Windows" in k)
    mac = next(v for k, v in rows.items() if "Apple Silicon Mac, to try" in k)
    assert "#the-whole-os-in-a-virtual-machine" in mac or "#on-a-mac-with-utm" in mac
    links = re.findall(r"\(#([^)]+)\)", table)
    assert set(links) <= anchors(text), set(links) - anchors(text)
    assert "#on-windows-with-hyper-v" in windows


@pytest.mark.parametrize("doc", [README, ROOT / "docs" / "LINUX.md", ROOT / "docs" / "manual" / "virtual-machine.md"])
def test_the_documented_joins_take_every_part_and_never_the_checksums(doc):
    text = doc.read_text()
    joins = re.findall(r"^\s*cat (herald-os-<version>-\S+) > (herald-os-<version>-\S+)$", text, re.M)
    assert joins
    for glob, whole in joins:
        glob, whole = glob.replace("<version>", "9.9.9"), whole.replace("<version>", "9.9.9")
        parts = [f"{whole}.part0", f"{whole}.part1"] if ".part" in glob else [f"{whole}.001", f"{whole}.002"]
        assert all(fnmatch.fnmatchcase(p, glob) for p in parts)
        for checksum in (f"{whole}.sha256", f"{whole}.sha256sums"):
            assert not fnmatch.fnmatchcase(checksum, glob)
        assert f"{whole.replace('9.9.9', '<version>')}.sha256sums" in text
        assert f"{whole.replace('9.9.9', '<version>')}.sha256" in text


def test_the_readme_names_the_files_the_release_carries():
    text = README.read_text()
    for name in ("herald-os-<version>-aarch64.utm.zip", "herald-os-<version>-x86_64.vhdx.zip",
                 "herald-os-<version>-x86_64.qcow2.zst"):
        assert name in text
