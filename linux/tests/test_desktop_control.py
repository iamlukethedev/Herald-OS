"""Desktop control on Herald OS Linux: how it is built, where it is installed, and what it needs."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "linux"
THIRD_PARTY = ROOT / "third_party" / "agent-desktop"


def listed(path: Path) -> list[str]:
    return [line.split("#", 1)[0].strip() for line in path.read_text().splitlines() if line.split("#", 1)[0].strip()]


def test_the_development_vm_has_rust_and_builds_desktop_control_offline():
    assert {"rust", "cargo"} <= set(listed(LINUX / "image" / "packages-dev.txt"))
    assert "rust" not in listed(LINUX / "image" / "packages.txt")
    build = (LINUX / "dev" / "build.sh").read_text()
    assert "(cd third_party/agent-desktop && cargo build --release --frozen --offline)" in build
    assert "/usr/local/libexec/herald-os/" in build
    for name in ("agent-desktop", "agent-desktop-linux-clipboard-owner"):
        assert f"third_party/agent-desktop/target/release/{name}" in build


def test_copying_the_checkout_into_the_vm_leaves_cargo_s_build_behind():
    for script in ("push.sh", "sync.sh"):
        assert "--exclude 'third_party/agent-desktop/target'" in (LINUX / "dev" / script).read_text()


def test_ci_tests_both_crates_offline_with_the_image_s_rust():
    import yaml

    job = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yml").read_text())["jobs"]["desktop-control"]
    assert job["container"] == "quay.io/fedora/fedora:44"
    runs = [step for step in job["steps"] if "run" in step]
    assert runs[0]["run"] == "dnf -y install --setopt=install_weak_deps=False rust cargo"
    test = runs[-1]
    assert test["working-directory"] == "third_party/agent-desktop"
    assert test["run"] == "cargo test --frozen --offline -p agent-desktop-core -p agent-desktop-linux"


def test_the_vendored_lock_is_the_pinned_one():
    import hashlib

    lock = (THIRD_PARTY / "Cargo.lock").read_bytes()
    assert hashlib.sha256(lock).hexdigest() == "da80a051f33db5dd38c19f924cef4a75c3bd340186f29678bc426b32b2d974f4"
    pinned = dict(line.split("=", 1) for line in (THIRD_PARTY / "UPSTREAM.lock").read_text().splitlines() if line and not line.startswith("#"))
    assert pinned == {"repo": "https://github.com/vercel-labs/agent-desktop", "sha": "9eb9b296192fcb70bda25e918cd6dd66abfa3d0d"}
