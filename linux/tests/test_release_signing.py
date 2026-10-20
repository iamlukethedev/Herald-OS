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
    check = hashlib.sha256((PKGBUILD.parent / "herald-os-release-check.sh").read_bytes()).hexdigest()
    assert lines[:-1] == [
        FINGERPRINT,
        "herald-os-package.sh",
        "herald-os-release-check.sh",
        f"SHA256SUMS-{version}::{base}/SHA256SUMS",
        f"SHA256SUMS-{version}.sig::{base}/SHA256SUMS.sig",
        f"herald-os-release-key-{version}.key::{base}/herald-os-release-key.asc",
        lines[6], check, "SKIP", "SKIP", "SKIP",
    ]
    # makepkg checks the local files' hashes, which the Arch workflow skips (--skipchecksums).
    assert lines[6] == hashlib.sha256((PKGBUILD.parent / "herald-os-package.sh").read_bytes()).hexdigest()


# makepkg's own rule (libmakepkg/integrity/verify_signature.sh): a source whose name matches
# *.@(sig?(n)|asc) is a detached signature of the source named without that ending, which must exist.
SIGNATURE_PAIRS = r"""shopt -s extglob
source "$1"
names=()
for entry in "${source[@]}" "${source_x86_64[@]}" "${source_aarch64[@]}"; do
  name="${entry%%::*}"
  [[ "$entry" == *::* ]] || name="${entry##*/}"
  names+=("$name")
done
for name in "${names[@]}"; do
  if [[ "$name" == *.@(sig?(n)|asc) ]]; then
    found=missing
    for other in "${names[@]}"; do [[ "$other" == "${name%.*}" ]] && found=paired; done
    echo "$found $name"
  fi
done
"""


@pytest.mark.parametrize("keys_set", [False, True])
def test_every_source_makepkg_takes_for_a_signature_signs_another_source(tmp_path, keys_set):
    """A key file saved as .asc made makepkg look for the file it would sign, and stop."""
    (tmp_path / "pkg").mkdir()
    path = pkgbuild(tmp_path / "pkg", FINGERPRINT if keys_set else "")
    done = subprocess.run([BASH, "-c", SIGNATURE_PAIRS, "pairs", str(path)], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    pairs = done.stdout.split("\n")[:-1]
    version = sourced(path, 'echo "$_version"').stdout.strip()
    assert pairs == ([f"paired SHA256SUMS-{version}.sig"] if keys_set else []), pairs


@pytest.mark.parametrize("carch,build", [("x86_64", "x64"), ("aarch64", "arm64")])
def test_prepare_checks_the_tarball_against_sha256sums(tmp_path, carch, build, keys):
    path = pkgbuild(tmp_path, keys.release)
    version = sourced(path, 'echo "$_version"').stdout.strip()
    srcdir = tmp_path / "src"
    srcdir.mkdir()
    shutil.copy(PKGBUILD.parent / "herald-os-release-check.sh", srcdir)
    (srcdir / f"herald-os-release-key-{version}.key").write_bytes(keys.export(keys.release))
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
        (f"{good}  old-herald-os-{version}-linux-{build}.tar.gz\n", False),
        (f"{good[:-1]}{'0' if good[-1] != '0' else '1'}  herald-os-{version}-linux-{build}.tar.gz\n", False),
        (f"{good[:8]}{'0' * 56}  herald-os-{version}-linux-{build}.tar.gz\n", False),
        (f"{good}  herald-os-{version}-linux-{build}.tar.gz\n{good}  herald-os-{version}-linux-{build}.tar.gz\n", False),
    ):
        sums.write_text(listed)
        keys.sign(keys.release, sums)
        # As makepkg runs it: errexit and an ERR trap, so any command that fails stops it.
        done = sourced(path, "set -eE; trap 'exit 3' ERR; prepare", env)
        assert (done.returncode == 0) == ok, (listed, done.stderr)
    # A good tarball under a signature makepkg would pass with a warning: an expired subkey's.
    sums.write_text(f"{good}  herald-os-{version}-linux-{build}.tar.gz\n")
    (tmp_path / "expired").mkdir()
    expired = pkgbuild(tmp_path / "expired", keys.expired)
    keys.sign(keys.expired, sums, faked="20200601T000000")
    (srcdir / f"herald-os-release-key-{version}.key").write_bytes(keys.export(keys.expired))
    done = sourced(expired, "set -eE; trap 'exit 3' ERR; prepare", env)
    assert done.returncode != 0 and "expired or been revoked" in done.stderr, done.stderr
    # A tarball of your own is checked by nothing here, as before.
    assert sourced(path, "prepare", {**env, "HERALD_OS_TARBALL_URL": f"file://{tarball}"}).returncode == 0
    unset = tmp_path / "unset"
    unset.mkdir()
    sums.write_text(f"{'0' * 64}  herald-os-{version}-linux-{build}.tar.gz\n")
    assert sourced(pkgbuild(unset), "prepare", env).returncode == 0


# The Arch package's own check of SHA256SUMS.sig, against the same cases as herald-os-tarball's.

RELEASE_CHECK = PKGBUILD.parent / "herald-os-release-check.sh"


def arch_check(sums: Path, signature: Path, offered: Path, *fingerprints: str) -> subprocess.CompletedProcess:
    """The check as prepare() calls it, under errexit and an ERR trap as in makepkg: it prints PASSED
    or REFUSED, and anything else means a command failed where it must not."""
    script = 'set -eE; trap "echo ERR-TRAP; exit 3" ERR; source "$1"; shift; if _herald_os_check_release "$@"; then echo PASSED; else echo REFUSED; fi'
    return subprocess.run([BASH, "-c", script, "check", str(RELEASE_CHECK), str(sums), str(signature), str(offered), *fingerprints], capture_output=True, text=True, timeout=120)


def release_case(tmp_path: Path, keys, case: str):
    """SHA256SUMS, its signature, the release's key file, and the fingerprints the PKGBUILD names, for
    one case; and what herald-os-tarball's check is given for it (the keys it carries, and the key file)."""
    sums = tmp_path / "SHA256SUMS"
    sums.write_text(f"{'a' * 64}  herald-os-0.2.0-linux-x64.tar.gz\n")
    offered = tmp_path / "herald-os-release-key.asc"
    key, signer, offered_keys = keys.release, keys.release, None
    if case == "expired subkey":
        key = signer = keys.expired
        signature = keys.sign(keys.expired, sums, faked="20200601T000000")
    elif case == "revoked subkey":
        key = signer = keys.make("Herald OS releases subkey revoked")
        signature = keys.sign(key, sums)
        offered_keys = keys.revoke_subkey(key)
    elif case == "revoked key":
        key = signer = keys.make("Herald OS releases key revoked")
        signature = keys.sign(key, sums)
        offered_keys = keys.revoked(key)
    elif case == "expired key":
        key = signer = keys.make("Herald OS releases key lapsed", faked="20200101T000000", primary_expires="1y")
        signature = keys.sign(key, sums, faked="20200601T000000")
    elif case == "another key":
        signer = keys.other
        signature = keys.sign(keys.other, sums)
        offered_keys = keys.export(keys.release, keys.other)
    elif case == "two signatures":
        signature = tmp_path / "two.sig"
        signature.write_bytes(keys.sign(keys.release, sums).read_bytes() + keys.sign(keys.other, sums).read_bytes())
        offered_keys = keys.export(keys.release, keys.other)
    elif case == "bad then good":
        write_other = tmp_path / "other.txt"
        write_other.write_text("something else\n")
        bad = keys.sign(keys.release, write_other).read_bytes()
        signature = tmp_path / "two.sig"
        signature.write_bytes(bad + keys.sign(keys.release, sums).read_bytes())
    elif case == "good then bad":
        # The pair a check that only looks for one GOODSIG and the fingerprint would trust.
        write_other = tmp_path / "other.txt"
        write_other.write_text("something else\n")
        signature = tmp_path / "two.sig"
        signature.write_bytes(keys.sign(keys.release, sums).read_bytes() + keys.sign(keys.other, write_other).read_bytes())
        offered_keys = keys.export(keys.release, keys.other)
    elif case == "junk after the signature":
        # gpg checks the signature, reports it good, then fails on what follows it.
        signature = tmp_path / "junk.sig"
        signature.write_bytes(keys.sign(keys.release, sums).read_bytes() + b"JUNKJUNKJUNK")
    elif case == "changed after signing":
        signature = keys.sign(keys.release, sums)
        sums.write_text(f"{'b' * 64}  herald-os-0.2.0-linux-x64.tar.gz\n")
    elif case == "key file without the key":
        signature = keys.sign(keys.release, sums)
        offered_keys = keys.export(keys.other)
    else:
        signature = keys.sign(keys.release, sums)
    offered.write_bytes(offered_keys if offered_keys is not None else keys.export(key))
    trusted = tmp_path / "trusted.asc"
    trusted.write_bytes(keys.export(key))
    return sums, signature, offered, key, trusted


ARCH_CASES = ["good", "expired subkey", "revoked subkey", "revoked key", "expired key", "another key", "two signatures", "bad then good", "good then bad", "junk after the signature", "changed after signing", "key file without the key"]


@pytest.mark.parametrize("case", ARCH_CASES)
def test_the_arch_check_refuses_what_herald_os_tarball_refuses(tmp_path, keys, case):
    sums, signature, offered, key, trusted = release_case(tmp_path, keys, case)
    done = arch_check(sums, signature, offered, key)
    assert done.stdout.strip() in ("PASSED", "REFUSED"), done.stdout + done.stderr
    try:
        tb.verify_signature(sums, signature, trusted, offered)
        tarball_accepts = True
    except tb.ReleaseError:
        tarball_accepts = False
    if case == "key file without the key":
        # herald-os-tarball carries the key itself; the package has only the release's key file.
        assert tarball_accepts and done.stdout.strip() == "REFUSED", done.stderr
    else:
        assert (done.stdout.strip() == "PASSED") == tarball_accepts == (case == "good"), (case, done.stderr)


def test_the_arch_check_passes_a_good_signature_as_a_plain_command(tmp_path, keys):
    """Not inside an if, where bash would turn errexit off: every command in it must succeed."""
    sums, signature, offered, key, _ = release_case(tmp_path, keys, "good")
    script = 'set -eE; trap "echo ERR-TRAP; exit 3" ERR; source "$1"; shift; _herald_os_check_release "$@"; echo PASSED'
    done = subprocess.run([BASH, "-c", script, "check", str(RELEASE_CHECK), str(sums), str(signature), str(offered), key], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0 and done.stdout.strip() == "PASSED", done.stdout + done.stderr


def test_the_arch_check_accepts_no_key_outside_the_pkgbuild_s_even_certified(tmp_path, keys):
    """A successor the release key certified is accepted by herald-os-tarball, which only knows the old
    key; the PKGBUILD names its own version's keys, so it must name the successor."""
    sums = tmp_path / "SHA256SUMS"
    sums.write_text(f"{'a' * 64}  herald-os-0.2.0-linux-x64.tar.gz\n")
    signature = keys.sign(keys.successor, sums)
    offered = tmp_path / "herald-os-release-key.asc"
    offered.write_bytes(keys.export(keys.release, keys.successor))
    assert arch_check(sums, signature, offered, keys.release).stdout.strip() == "REFUSED"
    assert arch_check(sums, signature, offered, keys.release, keys.successor).stdout.strip() == "PASSED"


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


# The check people run by hand, as written in the README and SECURITY.md: run against the same
# signatures, it passes only one good signature by the release key.


def documented_check(path: Path) -> str:
    """The lines from `gpg --status-fd` to the end of the awk program, as a script."""
    lines = path.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip().startswith("gpg --status-fd 1 --verify SHA256SUMS.sig SHA256SUMS 2>/dev/null |"))
    end = next(i for i in range(start, len(lines)) if lines[i].rstrip().endswith("}'"))
    indent = len(lines[start]) - len(lines[start].lstrip())
    return "\n".join(line[indent:] for line in lines[start:end + 1]) + "\n"


def test_the_readme_and_security_md_give_the_same_check():
    assert documented_check(ROOT / "README.md") == documented_check(ROOT / "SECURITY.md")


MANUAL_CASES = ["good", "expired subkey", "revoked subkey", "another key", "two signatures", "bad then good", "good then bad", "junk after the signature", "changed after signing"]


@pytest.mark.parametrize("case", MANUAL_CASES)
def test_the_documented_check_passes_only_a_good_signature(tmp_path, keys, case):
    sums, signature, offered, key, _ = release_case(tmp_path, keys, case)
    if signature != tmp_path / "SHA256SUMS.sig":
        shutil.copy(signature, tmp_path / "SHA256SUMS.sig")
    home = tmp_path / "reader"
    home.mkdir(mode=0o700)
    # The reader's keyring: what the release's key file holds, imported as the README says.
    subprocess.run(["gpg", "--batch", "--no-autostart", "--homedir", str(home), "--import", str(offered)], capture_output=True, timeout=120)
    script = tmp_path / "check.sh"
    script.write_text(documented_check(ROOT / "SECURITY.md"))
    done = subprocess.run([BASH, str(script)], cwd=tmp_path, env={**os.environ, "GNUPGHOME": str(home), "fpr": key}, capture_output=True, text=True, timeout=120)
    if case == "good":
        assert done.returncode == 0 and done.stdout.strip() == "signed with the release key", done.stdout + done.stderr
    else:
        assert done.returncode == 1 and done.stdout.strip() == "NOT signed with a good release key", (case, done.stdout, done.stderr)
