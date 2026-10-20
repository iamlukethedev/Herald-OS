"""Shared by the Linux tests: OpenPGP keys made with gpg, for the signed releases (docs/RELEASE-SIGNING.md)."""

import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

GPG = shutil.which("gpg")


class Keys:
    """A GnuPG home holding the secret keys: the maintainer's offline machine and CI in one."""

    def __init__(self, home: Path):
        self.home = home
        self.gpg_path = GPG

    def gpg(self, *args: str, faked: str | None = None, passphrase: str = "") -> subprocess.CompletedProcess:
        clock = ["--faked-system-time", faked] if faked else []
        done = subprocess.run([GPG, "--batch", "--homedir", str(self.home), "--pinentry-mode", "loopback", "--passphrase", passphrase, *clock, *args], capture_output=True, text=True, timeout=120)
        assert done.returncode == 0, done.stderr
        return done

    def make(self, name: str, expires: str = "0", faked: str | None = None, passphrase: str = "") -> str:
        """A certify-only primary key with a signing subkey, as docs/RELEASE-SIGNING.md makes it."""
        uid = f"{name} <{name.lower().replace(' ', '-')}@example.com>"
        before = set(self.primaries())
        self.gpg("--yes", "--quick-generate-key", uid, "ed25519", "cert", "0", faked=faked, passphrase=passphrase)
        (fingerprint,) = set(self.primaries()) - before
        self.gpg("--quick-add-key", fingerprint, "ed25519", "sign", expires, faked=faked, passphrase=passphrase)
        return fingerprint

    def primaries(self) -> list[str]:
        listing = subprocess.run([GPG, "--batch", "--homedir", str(self.home), "--with-colons", "--fixed-list-mode", "--list-keys"], capture_output=True, text=True, timeout=120).stdout
        return [line.split(":")[9] for line, before in zip(listing.splitlines()[1:], listing.splitlines()) if line.startswith("fpr:") and before.startswith("pub:")]

    def fingerprints(self, key: str) -> list[str]:
        """The primary key's fingerprint, then its subkeys'."""
        listing = self.gpg("--with-colons", "--fixed-list-mode", "--list-keys", key).stdout
        return [line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:")]

    def export(self, *fingerprints: str) -> bytes:
        return self.gpg("--armor", "--export", *fingerprints).stdout.encode()

    def export_signing_subkeys(self, fingerprint: str, passphrase: str = "") -> str:
        """What the CI secret holds: the subkeys' secrets, the primary key's left behind."""
        return self.gpg("--armor", "--export-secret-subkeys", fingerprint, passphrase=passphrase).stdout

    def export_binary(self, fingerprint: str) -> bytes:
        return subprocess.run([GPG, "--batch", "--homedir", str(self.home), "--export", fingerprint], capture_output=True, timeout=120, check=True).stdout

    def sign(self, key: str, path: Path, faked: str | None = None) -> Path:
        signature = path.with_name(f"{path.name}.sig")
        signature.unlink(missing_ok=True)
        self.gpg("--local-user", key, "--detach-sign", "--output", str(signature), str(path), faked=faked)
        return signature

    def certify(self, by: str, key: str) -> None:
        self.gpg("--local-user", by, "--quick-sign-key", key)


@pytest.fixture(scope="session")
def keys():
    if GPG is None:
        pytest.skip("needs gpg (GnuPG)")
    # Short and outside the test folders: gpg-agent's socket path has a length limit.
    home = Path(tempfile.mkdtemp(prefix="hos-gpg-", dir="/tmp" if Path("/tmp").is_dir() else None))
    found = Keys(home)
    found.release = found.make("Herald OS releases")
    found.other = found.make("Someone else")
    found.successor = found.make("Herald OS releases two")
    found.certify(found.release, found.successor)
    found.unvouched = found.make("Herald OS releases unvouched")
    found.vouched_by_other = found.make("Herald OS releases elsewhere")
    found.certify(found.other, found.vouched_by_other)
    found.expired = found.make("Herald OS releases expired", expires="1y", faked="20200101T000000")
    yield found
    subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "all"], capture_output=True, check=False)
    shutil.rmtree(home, ignore_errors=True)
