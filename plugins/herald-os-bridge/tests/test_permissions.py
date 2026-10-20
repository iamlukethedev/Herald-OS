"""Behaviour contracts for the permission engine."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path


def _perm(plugin):
    return importlib.import_module(plugin.__name__ + ".bridge.permissions")


def test_destructive_can_never_be_allowed_by_policy(plugin):
    perm = _perm(plugin)
    policy = perm.parse_policy({"tiers": {"destructive": "allow", "read": "deny"}})
    assert policy.mode(perm.Tier.DESTRUCTIVE) == "confirm"
    assert policy.mode(perm.Tier.READ) == "deny"


def test_malformed_policy_falls_back_to_defaults(plugin):
    perm = _perm(plugin)
    policy = perm.parse_policy(["not", "a", "mapping"])
    for tier, mode in perm.DEFAULT_TIER_MODES.items():
        assert policy.mode(tier) == mode


def test_protected_paths_include_builtin_and_user_entries(plugin, isolated_home):
    perm = _perm(plugin)
    policy = perm.parse_policy({"protected_paths": ["~/Documents/Taxes"]})
    assert perm.protected_root(Path.home() / ".ssh" / "id_ed25519", policy) is not None
    assert perm.protected_root(isolated_home / ".env", policy) is not None
    assert perm.protected_root(Path.home() / "Documents" / "Taxes" / "2025.pdf", policy) is not None
    assert perm.protected_root(Path.home() / "Documents" / "notes.txt", policy) is None


def test_protected_paths_cover_linux_system_locations(plugin):
    perm = _perm(plugin)
    for root in ("/boot", "/var/lib", "/lib", "/lib64", "/proc", "/sys"):
        assert root in perm.BUILTIN_PROTECTED
    policy = perm.parse_policy({})
    assert perm.protected_root(Path("/boot/vmlinuz"), policy) is not None
    assert perm.protected_root(Path("/var/lib/dpkg/status"), policy) is not None
    assert perm.protected_root(Path("/proc/1/status"), policy) is not None
    assert perm.protected_root(Path("/var/log/syslog"), policy) is None


def test_protected_paths_cover_the_linux_keyring(plugin):
    perm = _perm(plugin)
    assert "~/.local/share/keyrings" in perm.BUILTIN_PROTECTED
    policy = perm.parse_policy({})
    keyrings = Path.home() / ".local" / "share" / "keyrings"
    for path in (keyrings, keyrings / "login.keyring", keyrings / "default"):
        assert perm.protected_root(path, policy) == keyrings
    assert perm.protected_root(Path.home() / ".local" / "share" / "applications" / "x.desktop", policy) is None
    assert perm.protected_root(Path.home() / ".local" / "share" / "keyrings-notes.txt", policy) is None


def test_a_keyring_is_refused_through_a_link_before_any_prompt(plugin, isolated_home, tmp_path, monkeypatch):
    perm = _perm(plugin)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(perm, "_cache", None)
    keyrings = Path.home() / ".local" / "share" / "keyrings"
    keyrings.mkdir(parents=True)
    (keyrings / "login.keyring").write_text("[keyring]\n")
    link = Path.home() / "Documents" / "notes"
    link.parent.mkdir(parents=True)
    link.symlink_to(keyrings / "login.keyring")
    asked = []
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: asked.append(a) or perm.Decision(True, "approved"))
    for tier, action, path in ((perm.Tier.READ, "read", keyrings / "login.keyring"), (perm.Tier.MUTATE, "move", keyrings), (perm.Tier.DESTRUCTIVE, "delete", link)):
        decision = perm.authorize("system_files", tier, action, f"{action} keyring", paths=[path])
        assert not decision.allowed and decision.outcome == "protected", (action, path)
    assert asked == []


def test_protected_path_is_refused_before_any_prompt(plugin, monkeypatch):
    perm = _perm(plugin)
    asked = []
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: asked.append(a) or perm.Decision(True, "approved"))
    decision = perm.authorize("system_files", perm.Tier.MUTATE, "move", "move keys", paths=[Path.home() / ".ssh" / "config"])
    assert not decision.allowed
    assert decision.outcome == "protected"
    assert asked == []


def test_confirm_tier_uses_stable_key_for_mutate_and_fresh_key_for_destructive(plugin, monkeypatch):
    perm = _perm(plugin)
    keys = []

    def fake_confirm(tool, reason, rule_key):
        keys.append(rule_key)
        return perm.Decision(True, "approved")

    monkeypatch.setattr(perm, "_confirm", fake_confirm)
    perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder")
    perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder")
    perm.authorize("system_kill_process", perm.Tier.DESTRUCTIVE, "kill", "kill node")
    perm.authorize("system_kill_process", perm.Tier.DESTRUCTIVE, "kill", "kill node")
    assert keys[0] == keys[1], "mutate actions share a rule key so 'always' can apply"
    assert keys[2] != keys[3], "destructive actions never share a rule key"


def test_read_tier_runs_without_confirmation(plugin, monkeypatch):
    perm = _perm(plugin)
    monkeypatch.setattr(perm, "_confirm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not ask")))
    assert perm.authorize("system_info", perm.Tier.READ, "read", "read info").allowed


def test_confirm_fails_closed_without_approval_channel(plugin, monkeypatch):
    perm = _perm(plugin)
    monkeypatch.setitem(sys.modules, "tools", None)
    monkeypatch.setitem(sys.modules, "tools.approval", None)
    decision = perm._confirm("system_files", "mkdir", "herald_os:system_files:mkdir")
    assert not decision.allowed
    assert decision.outcome == "blocked"


def test_policy_file_is_reloaded_when_it_changes(plugin, isolated_home):
    perm = _perm(plugin)
    path = perm.policy_path()
    path.parent.mkdir(parents=True)
    path.write_text("tiers:\n  act: deny\n")
    assert perm.load_policy().mode(perm.Tier.ACT) == "deny"
    import os
    import time

    path.write_text("tiers:\n  act: allow\n")
    os.utime(path, (time.time() + 5, time.time() + 5))
    assert perm.load_policy().mode(perm.Tier.ACT) == "allow"


def test_a_scope_narrows_a_mutate_rule_key_and_no_scope_keeps_it(plugin, monkeypatch):
    perm = _perm(plugin)
    keys = []
    monkeypatch.setattr(perm, "_confirm", lambda tool, reason, rule_key: keys.append(rule_key) or perm.Decision(True, "approved"))
    perm.authorize("system_files", perm.Tier.MUTATE, "mkdir", "create folder")
    perm.authorize("system_os", perm.Tier.MUTATE, "restart", "restart Wi-Fi", scope="wifi")
    perm.authorize("system_os", perm.Tier.MUTATE, "restart", "restart sound", scope="sound")
    perm.authorize("system_os", perm.Tier.MUTATE, "restart", "restart Wi-Fi", scope="wifi")
    assert keys == ["herald_os:system_files:mkdir", "herald_os:system_os:restart:wifi", "herald_os:system_os:restart:sound", "herald_os:system_os:restart:wifi"]
