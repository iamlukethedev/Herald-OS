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


SESSION = LINUX / "session" / "herald-os-session"
OVERRIDE = LINUX / "session" / "90-herald-os-a11y.gschema.override"


def test_the_accessibility_bus_and_its_schema_are_installed():
    assert {"at-spi2-core", "at-spi2-atk", "gsettings-desktop-schemas"} <= set(listed(LINUX / "image" / "packages.txt"))


def test_gtk_and_gnome_apps_have_accessibility_on_by_default():
    import configparser

    parser = configparser.ConfigParser(comment_prefixes=("#",))
    parser.read_string(OVERRIDE.read_text())
    assert parser["org.gnome.desktop.interface"]["toolkit-accessibility"] == "true"
    packages = (LINUX / "image" / "packages.sh").read_text()
    assert f'install -Dm0644 "$LINUX/session/{OVERRIDE.name}" /usr/share/glib-2.0/schemas/{OVERRIDE.name}' in packages
    assert packages.index(OVERRIDE.name) < packages.index("glib-compile-schemas /usr/share/glib-2.0/schemas")


def session_vars() -> list[str]:
    import subprocess

    line = next(line for line in SESSION.read_text().splitlines() if line.startswith("SESSION_VARS=("))
    return subprocess.run(["bash", "-c", f'{line}\nprintf "%s\\n" "${{SESSION_VARS[@]}}"'], capture_output=True, text=True, check=True).stdout.split()


def test_qt_apps_expose_their_tree_and_activated_apps_inherit_it():
    text = SESSION.read_text()
    for name in ("QT_ACCESSIBILITY", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON"):
        assert f"export {name}=1\n" in text
        assert name in session_vars()


def test_the_accessibility_bus_starts_before_the_shell_and_after_the_environment_is_published():
    text = SESSION.read_text()
    start = text.index("systemctl --user start at-spi-dbus-bus.service")
    assert text.index("dbus-update-activation-environment --systemd") < start
    assert start < text.index('"${RUN[@]}" "${flags[@]}"')


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
