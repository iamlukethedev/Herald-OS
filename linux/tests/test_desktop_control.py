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


def pinned() -> dict[str, str]:
    return dict(line.split("=", 1) for line in (THIRD_PARTY / "UPSTREAM.lock").read_text().splitlines() if line and not line.startswith("#"))


def test_the_notice_and_patches_name_the_pinned_revision_and_lock():
    import hashlib

    assert pinned()["repo"] == "https://github.com/vercel-labs/agent-desktop"
    sha = pinned()["sha"]
    assert len(sha) == 40
    notice, patches = (THIRD_PARTY / "NOTICE").read_text(), (THIRD_PARTY / "PATCHES.md").read_text()
    assert sha in notice and "Vercel Labs" in notice and "modified" in notice
    assert f"`{sha}`" in patches
    lock = hashlib.sha256((THIRD_PARTY / "Cargo.lock").read_bytes()).hexdigest()
    assert f"sha256 `{lock}`" in patches


def test_every_patch_is_listed_and_applies_to_a_carried_file():
    patches = (THIRD_PARTY / "PATCHES.md").read_text()
    sync = (ROOT / "scripts" / "sync-agent-desktop.sh").read_text()
    for patch in sorted((THIRD_PARTY / "patches").glob("*.patch")):
        assert f"patches/{patch.name}" in patches
        assert patch.stem in sync
        target = patch.read_text().split("\n", 1)[0].rsplit(" b/", 1)[1]
        assert (THIRD_PARTY / target).is_file()
        assert f"| `{target}` | `patches/{patch.name}` |" in patches
