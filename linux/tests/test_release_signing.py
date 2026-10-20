"""Signed releases (#41): scripts/release-sums.sh writes and signs SHA256SUMS in the release workflows,
and what it signs is what herald-os-tarball accepts (docs/RELEASE-SIGNING.md)."""

import hashlib
import importlib.machinery
import importlib.util
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "release-sums.sh"
# The bash the scripts run under: macOS has 3.2, so CI on macOS runs them there.
BASH = os.environ.get("HERALD_OS_TEST_BASH", "bash")

_LOADER = importlib.machinery.SourceFileLoader("herald_os_tarball_signing", str(ROOT / "linux" / "bin" / "herald-os-tarball"))
tb = importlib.util.module_from_spec(importlib.util.spec_from_loader("herald_os_tarball_signing", _LOADER))
_LOADER.exec_module(tb)

DOWNLOADS = {
    "herald-os-0.2.0-linux-x64.tar.gz": b"tarball x64",
    "herald-os-0.2.0-linux-arm64.tar.gz": b"tarball arm64",
    "herald-os-0.2.0-x86_64.iso": b"the joined installer",
    "herald-os-0.2.0-aarch64.qcow2.zst": b"the joined disk",
    "HeraldOS-0.2.0-mac-arm64.dmg": b"dmg",
}


def checksums(folder: Path, downloads=DOWNLOADS) -> Path:
    """The .sha256 files the build jobs write, named as downloaded (sha256sum's two-space format)."""
    folder.mkdir(parents=True, exist_ok=True)
    for name, data in downloads.items():
        (folder / f"{name}.sha256").write_text(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
    return folder


def run(tmp_path: Path, env: dict | None = None, sums: Path | None = None) -> subprocess.CompletedProcess:
    sums = sums or checksums(tmp_path / "sums")
    full = {k: v for k, v in os.environ.items() if not k.startswith("RELEASE_")}
    full.update({"RELEASE_KEYS": str(tmp_path / "not-committed.asc"), "GITHUB_OUTPUT": str(tmp_path / "github-output"), **(env or {})})
    return subprocess.run([BASH, str(SCRIPT), str(sums), str(tmp_path / "out")], env=full, capture_output=True, text=True, timeout=120)


def output(tmp_path: Path) -> str:
    path = tmp_path / "github-output"
    return path.read_text() if path.exists() else ""


def test_without_the_key_sha256sums_is_written_and_left_unsigned(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    (out / "SHA256SUMS.sig").write_bytes(b"left from an earlier run")
    done = run(tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "::notice::RELEASE_SIGNING_KEY is not set" in done.stdout and output(tmp_path) == "signed=false\n"
    lines = (out / "SHA256SUMS").read_text().splitlines()
    assert [line.split("  ")[1] for line in lines] == sorted(DOWNLOADS)
    for line in lines:
        digest, name = line.split("  ")
        assert digest == hashlib.sha256(DOWNLOADS[name]).hexdigest()
    assert sorted(path.name for path in out.iterdir()) == ["SHA256SUMS"]


def test_without_the_key_a_committed_release_key_fails_the_release(tmp_path):
    committed = tmp_path / "committed.asc"
    committed.write_text("a public key\n")
    done = run(tmp_path, {"RELEASE_KEYS": str(committed)})
    assert done.returncode == 1 and "::error::RELEASE_SIGNING_KEY is not set" in done.stdout
    assert output(tmp_path) == "signed=false\n" and not (tmp_path / "out" / "SHA256SUMS.sig").exists()
    forked = run(tmp_path, {"RELEASE_KEYS": str(committed), "RELEASE_FORK": "true"})
    assert forked.returncode == 0 and "::warning::" in forked.stdout


@pytest.mark.parametrize("content", [
    "{digest}  herald-os-0.2.0-linux-arm64.tar.gz\n",
    "{digest}  herald-os-0.2.0-linux-x64.tar.gz\n{digest}  herald-os-0.2.0-linux-x64.tar.gz\n",
    "{digest}  ../herald-os-0.2.0-linux-x64.tar.gz\n",
    "{digest}\n",
    "not a checksum\n",
])
def test_a_sha256_that_is_not_one_line_for_its_own_file_is_refused(tmp_path, content):
    sums = checksums(tmp_path / "sums")
    (sums / "herald-os-0.2.0-linux-x64.tar.gz.sha256").write_text(content.format(digest="a" * 64))
    done = run(tmp_path, sums=sums)
    assert done.returncode == 1 and "::error::release-sums:" in done.stdout


def test_no_checksums_at_all_is_refused(tmp_path):
    (tmp_path / "empty").mkdir()
    assert run(tmp_path, sums=tmp_path / "empty").returncode == 1


def committed(tmp_path: Path, keys, *fingerprints: str) -> Path:
    path = tmp_path / "committed.asc"
    path.write_bytes(keys.export(*fingerprints))
    return path


def test_with_the_key_the_signature_is_one_installs_accept(tmp_path, keys):
    keys_file = committed(tmp_path, keys, keys.release)
    done = run(tmp_path, {"RELEASE_KEYS": str(keys_file), "RELEASE_SIGNING_KEY": keys.export_signing_subkeys(keys.release)})
    assert done.returncode == 0, done.stdout + done.stderr
    assert output(tmp_path) == "signed=true\n" and keys.release in done.stdout
    out = tmp_path / "out"
    assert (out / "herald-os-release-key.asc").read_bytes() == keys_file.read_bytes()
    assert tb.verify_signature(out / "SHA256SUMS", out / "SHA256SUMS.sig", keys_file, out / "herald-os-release-key.asc") == keys.release
    assert tb.listed_checksum(out / "SHA256SUMS", "herald-os-0.2.0-linux-x64.tar.gz") == hashlib.sha256(b"tarball x64").hexdigest()


def test_a_key_that_is_not_committed_is_refused(tmp_path, keys):
    keys_file = committed(tmp_path, keys, keys.release)
    done = run(tmp_path, {"RELEASE_KEYS": str(keys_file), "RELEASE_SIGNING_KEY": keys.export_signing_subkeys(keys.other)})
    assert done.returncode == 1 and f"belongs to {keys.other}, which is not in" in done.stdout
    assert not (tmp_path / "out" / "SHA256SUMS.sig").exists()


def test_while_the_key_is_not_committed_releases_are_signed_and_say_so(tmp_path, keys):
    done = run(tmp_path, {"RELEASE_SIGNING_KEY": keys.export_signing_subkeys(keys.release)})
    assert done.returncode == 0, done.stdout + done.stderr
    assert "::notice::not-committed.asc is not committed" in done.stdout
    out = tmp_path / "out"
    assert tb.verify_signature(out / "SHA256SUMS", out / "SHA256SUMS.sig", out / "herald-os-release-key.asc") == keys.release


def test_a_key_with_a_passphrase_needs_the_right_one(tmp_path, keys):
    guarded = keys.make("Herald OS releases guarded", passphrase="correct horse")
    secret = keys.export_signing_subkeys(guarded, passphrase="correct horse")
    env = {"RELEASE_KEYS": str(committed(tmp_path, keys, guarded)), "RELEASE_SIGNING_KEY": secret}
    wrong = run(tmp_path, {**env, "RELEASE_SIGNING_PASSPHRASE": "battery staple"})
    assert wrong.returncode == 1 and "could not sign" in wrong.stdout
    right = run(tmp_path, {**env, "RELEASE_SIGNING_PASSPHRASE": "correct horse"})
    assert right.returncode == 0, right.stdout + right.stderr


def test_a_secret_that_is_not_one_key_is_refused(tmp_path, keys):
    assert run(tmp_path, {"RELEASE_SIGNING_KEY": "not a key"}).returncode == 1
    two = keys.export_signing_subkeys(keys.release) + keys.export_signing_subkeys(keys.other)
    done = run(tmp_path, {"RELEASE_SIGNING_KEY": two})
    assert done.returncode == 1 and "holds 2 keys" in done.stdout


def test_a_secret_with_the_primary_key_in_it_signs_but_warns(tmp_path, keys):
    whole = keys.gpg("--armor", "--export-secret-keys", keys.release).stdout
    done = run(tmp_path, {"RELEASE_KEYS": str(committed(tmp_path, keys, keys.release)), "RELEASE_SIGNING_KEY": whole})
    assert done.returncode == 0 and "::warning::RELEASE_SIGNING_KEY holds the primary key" in done.stdout
    quiet = run(tmp_path, {"RELEASE_KEYS": str(committed(tmp_path, keys, keys.release)), "RELEASE_SIGNING_KEY": keys.export_signing_subkeys(keys.release)})
    assert "::warning::" not in quiet.stdout


# The workflows: both release jobs sign the same way, one at a time, after their own upload.

WORKFLOWS = ROOT / ".github" / "workflows"


def release_job(workflow: str) -> dict:
    return yaml.safe_load((WORKFLOWS / workflow).read_text())["jobs"]["release"]


def step(job: dict, name: str) -> dict:
    return next(item for item in job["steps"] if item.get("name") == name)


def test_both_release_jobs_write_and_sign_sha256sums_alike():
    jobs = {workflow: release_job(workflow) for workflow in ("image.yml", "release.yml")}
    signing = [step(job, "Write and sign SHA256SUMS") for job in jobs.values()]
    assert signing[0] == signing[1]
    env = signing[0]["env"]
    assert env["RELEASE_SIGNING_KEY"] == "${{ secrets.RELEASE_SIGNING_KEY }}"
    assert env["RELEASE_SIGNING_PASSPHRASE"] == "${{ secrets.RELEASE_SIGNING_PASSPHRASE }}"
    assert env["RELEASE_FORK"] == "${{ github.event.repository.fork }}"
    assert "bash scripts/release-sums.sh sums signed" in signing[0]["run"]
    assert "--pattern '*.sha256'" in signing[0]["run"]
    for workflow, job in jobs.items():
        assert job["environment"] == "release-signing", workflow
        assert job["concurrency"] == {"group": "release-sums-${{ github.ref }}", "cancel-in-progress": False}, workflow
        assert job["permissions"] == {"contents": "write"}, workflow
        checkout = job["steps"][0]
        assert checkout["uses"].startswith("actions/checkout@") and checkout["with"]["persist-credentials"] is False
        assert set(checkout["with"]["sparse-checkout"].split()) == {"scripts", "linux/keys"}
        names = [item.get("name") for item in job["steps"]]
        assert names[-1] == "Write and sign SHA256SUMS", workflow
        assert job["steps"][-2]["run"].rstrip().endswith("--clobber"), workflow


def test_the_mac_downloads_get_a_sha256_for_sha256sums():
    job = release_job("release.yml")
    assert "sha256sum" in step(job, "Checksum the Mac downloads")["run"]
    upload = step(job, "Upload to the draft release")["run"]
    assert "dist/*.dmg.sha256" in upload and "dist/*.zip.sha256" in upload


# The Arch package: makepkg checks SHA256SUMS.sig with validpgpkeys, prepare() the tarball against it.

PKGBUILD = ROOT / "packaging" / "arch" / "herald-os-bin" / "PKGBUILD"
FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567"


def pkgbuild(tmp_path: Path, keys: str = "") -> Path:
    text = PKGBUILD.read_text()
    assert text.count("\n_release_keys=(") == 1
    path = tmp_path / "PKGBUILD"
    path.write_text(text.replace("\n_release_keys=()\n", f"\n_release_keys=({keys})\n") if keys else text)
    return path


def sourced(path: Path, script: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, "-c", f'source "$1" && {script}', "pkgbuild", str(path)], capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})


def test_until_the_release_key_is_set_the_package_is_as_before(tmp_path):
    done = sourced(pkgbuild(tmp_path), 'echo "${#source[@]} ${#sha256sums[@]} ${validpgpkeys[*]-none}"')
    assert done.stdout.split() == ["1", "1", "none"], done.stderr


def test_with_the_release_key_makepkg_checks_the_signed_sha256sums(tmp_path):
    done = sourced(pkgbuild(tmp_path, FINGERPRINT), 'printf "%s\\n" "${validpgpkeys[@]}" "${source[@]}" "${sha256sums[@]}" "$_version"')
    lines = done.stdout.splitlines()
    version = lines[-1]
    base = f"https://github.com/iamlukethedev/Herald-OS/releases/download/v{version}"
    assert lines[:-1] == [
        FINGERPRINT,
        "herald-os-package.sh",
        f"SHA256SUMS-{version}::{base}/SHA256SUMS",
        f"SHA256SUMS-{version}.sig::{base}/SHA256SUMS.sig",
        lines[4], "SKIP", "SKIP",
    ]


@pytest.mark.parametrize("carch,build", [("x86_64", "x64"), ("aarch64", "arm64")])
def test_prepare_checks_the_tarball_against_sha256sums(tmp_path, carch, build):
    path = pkgbuild(tmp_path, FINGERPRINT)
    version = sourced(path, 'echo "$_version"').stdout.strip()
    srcdir = tmp_path / "src"
    srcdir.mkdir()
    tarball = srcdir / f"herald-os-{version}-{build}.tar.gz"
    tarball.write_bytes(b"the release tarball")
    good = hashlib.sha256(b"the release tarball").hexdigest()
    sums = srcdir / f"SHA256SUMS-{version}"
    env = {"srcdir": str(srcdir), "CARCH": carch}
    for listed, ok in (
        (f"{good}  herald-os-{version}-linux-{build}.tar.gz\n{'0' * 64}  herald-os-{version}-x86_64.iso\n", True),
        (f"{good} *herald-os-{version}-linux-{build}.tar.gz\n", True),
        (f"{'0' * 64}  herald-os-{version}-linux-{build}.tar.gz\n", False),
        (f"{good}  herald-os-{version}-linux-other.tar.gz\n", False),
        (f"{good}  herald-os-{version}-linux-{build}.tar.gz\n{good}  herald-os-{version}-linux-{build}.tar.gz\n", False),
    ):
        sums.write_text(listed)
        done = sourced(path, "prepare", env)
        assert (done.returncode == 0) == ok, (listed, done.stderr)
    # A tarball of your own is checked by nothing here, as before.
    assert sourced(path, "prepare", {**env, "HERALD_OS_TARBALL_URL": f"file://{tarball}"}).returncode == 0
    unset = tmp_path / "unset"
    unset.mkdir()
    sums.write_text(f"{'0' * 64}  herald-os-{version}-linux-{build}.tar.gz\n")
    assert sourced(pkgbuild(unset), "prepare", env).returncode == 0


# The fingerprint: the key file, SECURITY.md, the README and the PKGBUILD agree, so the key cannot be
# committed with the docs still unset, or the docs and package name a key installs do not have.

KEY_FILE = ROOT / "linux" / "keys" / "herald-os-release.asc"
FINGERPRINT_LINE = re.compile(r"^\s*Release key fingerprint: (.+)$", re.M)
NOT_SET = "not set yet"


def key_file_fingerprints(path: Path, home: Path) -> list[str]:
    home.mkdir(mode=0o700, exist_ok=True)
    shown = subprocess.run(["gpg", "--batch", "--no-options", "--no-autostart", "--homedir", str(home), "--with-colons", "--import-options", "show-only", "--import", str(path)], capture_output=True, text=True, timeout=60)
    return list(tb.primary_keys(shown.stdout))


def mismatches(key_file: Path, docs: list[Path], pkgbuild_file: Path, home: Path) -> list[str]:
    problems = []
    keys = key_file_fingerprints(key_file, home) if key_file.exists() else []
    if key_file.exists() and not keys:
        problems.append(f"{key_file.name} holds no key")
    for doc in docs:
        lines = FINGERPRINT_LINE.findall(doc.read_text())
        if len(lines) != 1:
            problems.append(f"{doc.name} has {len(lines)} 'Release key fingerprint:' lines")
            continue
        listed = re.findall(r"`([0-9A-F]{40})`", lines[0])
        if keys and (NOT_SET in lines[0] or sorted(listed) != sorted(keys)):
            problems.append(f"{doc.name} gives {listed or lines[0]!r}, the key file holds {keys}")
        if not keys and (listed or not lines[0].startswith(NOT_SET)):
            problems.append(f"{doc.name} gives {lines[0]!r} but no release key is committed")
    sourced_keys = subprocess.run([BASH, "-c", 'source "$1" && printf "%s\\n" "${_release_keys[@]}"', "pkgbuild", str(pkgbuild_file)], capture_output=True, text=True, timeout=60)
    if sorted(sourced_keys.stdout.split()) != sorted(keys):
        problems.append(f"{pkgbuild_file.name}'s _release_keys are {sourced_keys.stdout.split()}, the key file holds {keys}")
    return problems


def test_the_release_key_is_published_the_same_everywhere(tmp_path):
    if KEY_FILE.exists() and shutil.which("gpg") is None:
        pytest.skip("needs gpg to read the release key")
    assert mismatches(KEY_FILE, [ROOT / "SECURITY.md", ROOT / "README.md"], PKGBUILD, tmp_path / "gpg") == []


def test_the_check_catches_a_key_committed_without_the_rest(tmp_path, keys):
    security, readme = tmp_path / "SECURITY.md", tmp_path / "README.md"
    for doc, source in ((security, ROOT / "SECURITY.md"), (readme, ROOT / "README.md")):
        doc.write_text(source.read_text())
    key_file = tmp_path / "herald-os-release.asc"
    (tmp_path / "unset").mkdir()
    unset = pkgbuild(tmp_path / "unset")
    home = tmp_path / "gpg"
    # As shipped today: no key, nothing set.
    assert mismatches(key_file, [security, readme], unset, home) == []
    # The key committed alone.
    key_file.write_bytes(keys.export(keys.release))
    assert len(mismatches(key_file, [security, readme], unset, home)) == 3
    # Everything set: the fingerprint in backticks, and the PKGBUILD's keys.
    for doc in (security, readme):
        doc.write_text(FINGERPRINT_LINE.sub(lambda match: match.group(0).replace(match.group(1), f"`{keys.release}`"), doc.read_text()))
    (tmp_path / "set").mkdir()
    assert mismatches(key_file, [security, readme], pkgbuild(tmp_path / "set", keys.release), home) == []
    # A second key in the file (a rotation) must be listed too.
    key_file.write_bytes(keys.export(keys.release, keys.successor))
    assert len(mismatches(key_file, [security, readme], pkgbuild(tmp_path / "set", keys.release), home)) == 3
    # The docs and package naming a key with none committed.
    key_file.unlink()
    assert len(mismatches(key_file, [security, readme], pkgbuild(tmp_path / "set", keys.release), home)) == 3
