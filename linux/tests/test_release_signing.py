"""Signed releases (#41): scripts/release-sums.sh writes and signs SHA256SUMS in the release workflows,
and what it signs is what herald-os-tarball accepts (docs/RELEASE-SIGNING.md)."""

import hashlib
import importlib.machinery
import importlib.util
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "release-sums.sh"

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
    return subprocess.run(["bash", str(SCRIPT), str(sums), str(tmp_path / "out")], env=full, capture_output=True, text=True, timeout=120)


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
