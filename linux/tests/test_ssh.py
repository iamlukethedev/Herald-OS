"""`herald-os setup ssh` (linux/bin/herald-os): SSH on for keys only and never root, rate-limited in
the firewall, off again, and its status. The commands it runs as root go to a stand-in for systemctl,
sshd, firewalld and the rest, which keeps their state; the files in the home folder and the drop-in
are real, in a temporary directory. Each safety check also has a mutant: the CLI with that check
taken out, which the same scenario must catch."""

import base64
import importlib.machinery
import importlib.util
import json
import os
import pwd
import stat
import struct
import subprocess
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = ROOT / "linux" / "bin" / "herald-os"
_LOADER = importlib.machinery.SourceFileLoader("herald_os_cli_ssh", str(CLI_PATH))
_SPEC = importlib.util.spec_from_loader("herald_os_cli_ssh", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

DROP_IN = (
    "# Written by `herald-os setup ssh`; `herald-os setup ssh --off` removes it.\n"
    "PermitRootLogin no\n"
    "PasswordAuthentication no\n"
    "KbdInteractiveAuthentication no\n"
    "PermitEmptyPasswords no\n"
)
RULE = 'rule service name="ssh" accept limit value="4/m"'
# sshd's own defaults for what the drop-in sets.
SSHD_DEFAULTS = {"permitrootlogin": "prohibit-password", "passwordauthentication": "yes", "kbdinteractiveauthentication": "yes", "permitemptypasswords": "no"}


def public_key(kind: str = "ssh-ed25519", comment: str = "me@laptop", seed: int = 1, data_kind: str | None = None) -> str:
    """A public key line in OpenSSH's format, with made-up key material."""
    name = (data_kind or kind).encode()
    body = bytes([seed]) * 32
    blob = struct.pack(">I", len(name)) + name + struct.pack(">I", len(body)) + body
    return f"{kind} {base64.b64encode(blob).decode()} {comment}".strip()


def bare(key: str) -> str:
    return " ".join(key.split()[:2])


def looks(argv: list[str]) -> bool:
    """Whether a command only reads the machine's state."""
    tool = Path(argv[0]).name
    if tool == "systemctl":
        return argv[1] in ("show", "is-enabled", "is-active")
    if tool.startswith("firewall"):
        return any(arg == "--get-default-zone" or arg.startswith("--query-") for arg in argv)
    return tool in ("sshd", "ip", "curl") or argv[:2] == ["ssh-keygen", "-lf"]


class System:
    """A machine with sshd installed and off, firewalld running with the herald-os zone, and a person
    whose home is in tmp_path. `module` is the CLI under test (a mutant, sometimes)."""

    def __init__(self, module, tmp_path: Path, monkeypatch):
        self.module = module
        self.home = tmp_path / "home" / "me"
        self.home.mkdir(parents=True)
        self.etc = tmp_path / "etc-ssh"
        (self.etc / "sshd_config.d").mkdir(parents=True)
        (self.etc / "ssh_host_ed25519_key.pub").write_text("ssh-ed25519 AAAA root@host\n")
        self.drop_in = self.etc / "sshd_config.d" / "10-herald-os.conf"
        self.calls: list[tuple[bool, list[str]]] = []
        self.units = {"sshd.service": ["disabled", "inactive"], "sshd.socket": ["disabled", "inactive"]}
        self.firewalld = True
        self.installed = {"sshd", "firewall-cmd", "firewall-offline-cmd", "restorecon", "curl", "ssh-keygen"}
        self.zone = "herald-os"
        self.rules = {"runtime": set(), "permanent": set()}
        self.services: set[str] = set()
        # sshd_config lines sshd reads before its Include line.
        self.before_include: list[str] = []
        self.queries_need_root = False
        self.github: dict[str, tuple[str, int]] = {}
        # The CLI runs as root (the first boot), so commands need no sudo to be root's.
        self.is_root = False
        self.account = pwd.struct_passwd(("me", "x", os.getuid(), os.getgid(), "", str(self.home), "/bin/bash"))
        monkeypatch.setattr(module, "SSHD_DROP_IN", self.drop_in)
        monkeypatch.setattr(module, "SSH_HOST_KEYS", self.etc)
        monkeypatch.setattr(module.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(module.pwd, "getpwuid", lambda uid: self.account)
        monkeypatch.setattr(module.shutil, "which", lambda name, path=None: f"/usr/sbin/{name}" if name in self.installed else None)
        monkeypatch.setattr(module.subprocess, "run", self.run)

    # -- the stand-in ----------------------------------------------------------------------------
    def run(self, argv, capture_output=False, text=False, check=False, timeout=None, input=None, **_):
        argv = list(argv)
        root = argv[:1] == ["sudo"]
        if root:
            argv = argv[1:]
            if argv[:1] == ["-n"]:
                argv = argv[1:]
        self.calls.append((root, argv))
        out, code = self.answer(argv, root or self.is_root)
        return subprocess.CompletedProcess(argv, code, out, "" if code == 0 else f"{argv[0]}: refused")

    def answer(self, argv: list[str], root: bool) -> tuple[str, int]:
        tool = Path(argv[0]).name
        if tool == "systemctl":
            return self.systemctl(argv[1:], root)
        if tool == "sshd":
            if not root:
                return "", 1  # host keys are root's
            if argv[1] == "-t":
                return "", 0
            return self.effective(), 0
        if tool == "ssh-keygen":
            if argv[1] == "-A":
                return "", 0 if root else 1
            return "256 SHA256:hostkeyfingerprint root@host (ED25519)\n", 0
        if tool == "install":
            if not root:
                return "", 1
            Path(argv[-1]).write_text(Path(argv[-2]).read_text())
            Path(argv[-1]).chmod(0o644)
            return "", 0
        if tool == "rm":
            if not root:
                return "", 1
            Path(argv[-1]).unlink(missing_ok=True)
            return "", 0
        if tool == "restorecon":
            return "", 0 if root else 1
        if tool in ("firewall-cmd", "firewall-offline-cmd"):
            return self.firewall(tool, argv[1:], root)
        if tool == "ip":
            return ("2: enp1s0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic enp1s0\n"
                    "2: enp1s0    inet6 fd00::20/64 scope global dynamic\n"), 0
        if tool == "curl":
            return self.github.get(argv[-1], ("", 22))
        raise AssertionError(f"unexpected command: {argv}")

    def systemctl(self, args: list[str], root: bool) -> tuple[str, int]:
        if args[:4] == ["show", "-p", "LoadState", "--value"]:
            return ("loaded\n" if args[4] in self.units else "not-found\n"), 0
        if args == ["is-active", "--quiet", "firewalld"]:
            return "", 0 if self.firewalld else 3
        if args[0] == "is-enabled":
            state = self.units[args[1]][0]
            return state + "\n", 0 if state == "enabled" else 1
        if args[0] == "is-active":
            state = self.units[args[1]][1]
            return state + "\n", 0 if state == "active" else 3
        if not root:
            return "", 1
        if args == ["start", "sshd-keygen.target"]:
            return "", 0
        if args == ["enable", "sshd.service"]:
            self.units["sshd.service"][0] = "enabled"
            return "", 0
        if args == ["reload-or-restart", "sshd.service"]:
            self.units["sshd.service"][1] = "active"
            return "", 0
        if args[:2] == ["disable", "--now"]:
            self.units[args[2]] = ["disabled", "inactive"]
            return "", 0
        raise AssertionError(f"unexpected systemctl {args}")

    def effective(self) -> str:
        """`sshd -T`: the first value read wins, sshd_config before its Include, then sshd_config.d in order."""
        values: dict[str, str] = {}
        lines = list(self.before_include)
        for file in sorted((self.etc / "sshd_config.d").glob("*.conf")):
            lines += file.read_text().splitlines()
        for line in lines:
            if line.strip() and not line.startswith("#"):
                key, value = line.split(None, 1)
                values.setdefault(key.lower(), value.strip().lower())
        for key, value in SSHD_DEFAULTS.items():
            values.setdefault(key, value)
        return "".join(f"{key} {value}\n" for key, value in values.items())

    def firewall(self, tool: str, args: list[str], root: bool) -> tuple[str, int]:
        layer = "permanent" if "--permanent" in args or tool == "firewall-offline-cmd" else "runtime"
        args = [arg for arg in args if arg != "--permanent" and not arg.startswith("--zone=")]
        if args == ["--get-default-zone"]:
            return (self.zone + "\n", 0) if root or not self.queries_need_root else ("", 11)
        name, _, value = args[0].partition("=")
        if name.startswith("--query-"):
            if self.queries_need_root and not root:
                return "", 11
            found = value in (self.rules[layer] if name == "--query-rich-rule" else self.services)
            return ("yes\n" if found else "no\n"), 0 if found else 1
        if not root:
            return "", 11
        if name == "--add-rich-rule":
            self.rules[layer].add(value)
            return "", 0
        if name == "--remove-rich-rule":
            self.rules[layer].discard(value)
            return "", 0
        raise AssertionError(f"unexpected {tool} {args}")

    # -- what the tests look at ------------------------------------------------------------------
    @property
    def ssh(self) -> Path:
        return self.home / ".ssh"

    @property
    def keys_file(self) -> Path:
        return self.ssh / "authorized_keys"

    def on(self) -> bool:
        return self.units["sshd.service"] == ["enabled", "active"]

    def changes(self) -> list[list[str]]:
        """The commands that change something, rather than look."""
        return [argv for _, argv in self.calls if not looks(argv)]

    def setup(self, *args: str) -> int:
        return self.module.setup(["ssh", *args])


@pytest.fixture
def machine(tmp_path, monkeypatch):
    return System(cli, tmp_path, monkeypatch)


def refused(machine: System, capsys, *args: str, code: int = 1) -> str:
    with pytest.raises(SystemExit) as stopped:
        machine.setup(*args)
    assert stopped.value.code == code
    return capsys.readouterr().err


# ---------------------------------------------------------------------------------------------
# Keys, as text (pure).
def test_a_public_key_is_one_line_of_a_type_sshd_takes_whose_data_names_that_type():
    key = public_key()
    assert cli.ssh_key(key) == key
    assert cli.ssh_key(f"  {key}  ") == key
    assert cli.ssh_key(public_key(comment="")) == public_key(comment="")
    assert cli.ssh_key(public_key("ecdsa-sha2-nistp256")) and cli.ssh_key(public_key("sk-ssh-ed25519@openssh.com"))
    for wrong in (
        "",
        "ssh-ed25519",
        public_key("ssh-dss"),
        public_key(data_kind="ssh-rsa"),
        f'command="rm -rf ~" {key}',
        f"restrict {key}",
        f"{key}\n{public_key(seed=2)}",
        f"{key}\r",
        "ssh-ed25519 not*base64 me",
        "ssh-ed25519 " + base64.b64encode(struct.pack(">I", 11) + b"ssh-ed25519").decode(),
        "ssh-ed25519 " + base64.b64encode(struct.pack(">I", 200) + b"ssh-ed25519").decode(),
    ):
        assert cli.ssh_key(wrong) is None, wrong


def test_authorized_keys_lets_in_its_keys_with_or_without_options_and_nothing_else():
    one, two = public_key(seed=1), public_key("ssh-rsa", seed=2)
    text = f"# my laptop\n{one}\n\nfrom=\"10.0.0.0/8\",no-pty {two}\nssh-ed25519 broken\n#{public_key(seed=3)}\n"
    assert cli.authorized(text) == [bare(one), bare(two)]
    assert cli.authorized("") == [] and cli.authorized("# nothing\n\n") == []


def test_keys_are_added_once_at_the_end_and_the_lines_there_stay_as_they_were():
    one, two = public_key(seed=1), public_key(seed=2)
    existing = f'# mine\nno-pty {one}'
    text, added = cli.with_keys(existing, [two, public_key(seed=1, comment="the same key"), two])
    assert added == [two]
    assert text == f"# mine\nno-pty {one}\n{two}\n"
    assert cli.with_keys(text, [one, two]) == (text, [])
    assert cli.with_keys("", [one]) == (f"{one}\n", [one])


def test_the_drop_in_turns_off_root_passwords_and_keyboard_interactive_logins():
    assert cli.sshd_drop_in(False) == DROP_IN
    assert cli.sshd_drop_in(True) == DROP_IN.replace("PasswordAuthentication no", "PasswordAuthentication yes")


def test_what_sshd_reports_must_match_the_drop_in():
    good = "port 22\npermitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\npermitemptypasswords no\n"
    assert cli.sshd_overruled(good, passwords=False) == []
    assert cli.sshd_overruled(good.replace("passwordauthentication no", "passwordauthentication yes"), passwords=False) == ["passwordauthentication is yes, not no"]
    assert cli.sshd_overruled(good.replace("passwordauthentication no", "passwordauthentication yes"), passwords=True) == []
    assert cli.sshd_overruled(good.replace("permitrootlogin no", "permitrootlogin prohibit-password"), passwords=True) == ["permitrootlogin is prohibit-password, not no"]
    # An older sshd that does not report a setting has not taken it.
    assert cli.sshd_overruled(good.replace("kbdinteractiveauthentication no\n", ""), passwords=False) == ["kbdinteractiveauthentication is not reported, not no"]


# ---------------------------------------------------------------------------------------------
# On.
def test_without_a_key_it_refuses_and_changes_nothing(machine, capsys):
    err = refused(machine, capsys)
    assert "not turning SSH on" in err and "has no SSH key" in err and "Nothing was changed" in err
    assert machine.changes() == [] and not machine.on()
    assert not machine.drop_in.exists() and not machine.ssh.exists()
    assert machine.rules == {"runtime": set(), "permanent": set()}


def test_an_authorized_keys_with_no_usable_key_counts_as_none(machine, capsys):
    machine.ssh.mkdir(mode=0o700)
    machine.keys_file.write_text(f"# {public_key()}\nssh-ed25519 broken\n\n")
    before = machine.keys_file.read_text()
    assert "not turning SSH on" in refused(machine, capsys)
    assert machine.changes() == [] and machine.keys_file.read_text() == before


def test_with_a_key_ssh_is_on_for_keys_only_rate_limited_and_it_says_how_to_reach_it(machine, capsys):
    key = public_key()
    assert machine.setup("--key", key) == 0
    out = capsys.readouterr().out
    assert machine.keys_file.read_text() == f"{key}\n"
    assert stat.S_IMODE(machine.ssh.stat().st_mode) == 0o700
    assert stat.S_IMODE(machine.keys_file.stat().st_mode) == 0o600
    assert machine.drop_in.read_text() == DROP_IN
    assert machine.on()
    assert machine.rules == {"runtime": {RULE}, "permanent": {RULE}}
    assert ["restorecon", "-R", str(machine.ssh)] in machine.changes()
    assert ["restorecon", str(machine.drop_in)] in machine.changes()
    # Root only where it is needed: the home folder is written as the person.
    assert all(root for root, argv in machine.calls if argv in machine.changes())
    assert "keys only, no passwords" in out and "never root" in out
    assert "SHA256:hostkeyfingerprint" in out
    assert "ssh me@192.168.1.20" in out and "ssh me@fd00::20" in out
    assert "4 new connections a minute" in out


def test_a_key_already_in_authorized_keys_is_enough_and_the_file_is_kept_but_tightened(machine):
    machine.ssh.mkdir()
    machine.ssh.chmod(0o755)
    text = f'# work\nfrom="10.0.0.0/8" {public_key()}\n'
    machine.keys_file.write_text(text)
    machine.keys_file.chmod(0o664)
    assert machine.setup() == 0
    assert machine.keys_file.read_text() == text
    assert stat.S_IMODE(machine.ssh.stat().st_mode) == 0o700
    assert stat.S_IMODE(machine.keys_file.stat().st_mode) == 0o600
    assert machine.on()


def test_passwords_only_with_the_explicit_flag_and_never_root_or_keyboard_interactive(machine, capsys):
    assert machine.setup("--passwords") == 0
    drop_in = machine.drop_in.read_text().splitlines()
    assert "PasswordAuthentication yes" in drop_in
    assert {"PermitRootLogin no", "KbdInteractiveAuthentication no", "PermitEmptyPasswords no"} <= set(drop_in)
    assert "keys or the password" in capsys.readouterr().out
    assert not machine.ssh.exists()


def test_running_it_again_changes_nothing_more(machine, capsys):
    key = public_key()
    assert machine.setup("--key", key) == 0
    first = (machine.keys_file.read_text(), machine.drop_in.read_text(), {k: set(v) for k, v in machine.rules.items()})
    capsys.readouterr()
    assert machine.setup("--key", key) == 0
    assert "added" not in capsys.readouterr().out
    assert (machine.keys_file.read_text(), machine.drop_in.read_text(), machine.rules) == first
    assert machine.keys_file.read_text().count(bare(key)) == 1


def test_a_second_key_is_added_beside_the_first(machine):
    one, two = public_key(seed=1), public_key(seed=2)
    machine.setup("--key", one)
    machine.setup(f"--key={two}")
    assert machine.keys_file.read_text() == f"{one}\n{two}\n"


@pytest.mark.parametrize("key", [public_key("ssh-dss"), f"restrict {public_key()}", "ssh-ed25519 AAAA", "not a key", public_key(data_kind="ssh-rsa")])
def test_a_key_that_is_not_one_is_refused_before_anything_changes(machine, capsys, key):
    machine.ssh.mkdir(mode=0o700)
    machine.keys_file.write_text(f"{public_key(seed=9)}\n")
    err = refused(machine, capsys, "--key", key, code=2)
    assert "not an SSH public key" in err and "Nothing was changed" in err
    assert machine.changes() == [] and machine.keys_file.read_text() == f"{public_key(seed=9)}\n"


def test_a_keys_file_gives_its_keys_and_skips_comments(machine, tmp_path, capsys):
    one, two = public_key(seed=1), public_key(seed=2)
    given = tmp_path / "keys"
    given.write_text(f"# from the install\n{one}\n\n  {two}\n")
    assert machine.setup("--keys-file", str(given)) == 0
    assert machine.keys_file.read_text() == f"{one}\n{two}\n"
    given.write_text(f"{one}\nnot a key\n")
    assert "line 2: not an SSH public key" in refused(machine, capsys, "--keys-file", str(given), code=2)


def test_github_keys_are_read_and_marked_and_a_user_without_keys_is_refused(machine, capsys):
    one, two = public_key(comment="", seed=1), public_key(comment="", seed=2)
    machine.github["https://github.com/octocat.keys"] = (f"{one}\n{two}\nssh-dss AAAA\n", 0)
    assert machine.setup("--github", "octocat") == 0
    assert machine.keys_file.read_text() == f"{one} github:octocat\n{two} github:octocat\n"
    capsys.readouterr()
    machine.github["https://github.com/nokeys.keys"] = ("", 0)
    assert "has no SSH keys on GitHub" in refused(machine, capsys, "--github", "nokeys")
    assert "could not read" in refused(machine, capsys, "--github", "missing")
    assert "not a GitHub user name" in refused(machine, capsys, "--github", "../../etc", code=2)


@pytest.mark.parametrize("link", [".ssh", ".ssh/authorized_keys"])
def test_a_link_in_place_of_ssh_or_authorized_keys_is_refused(machine, tmp_path, capsys, link):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "authorized_keys").write_text("")
    if link == ".ssh":
        machine.ssh.symlink_to(elsewhere)
    else:
        machine.ssh.mkdir(mode=0o700)
        machine.keys_file.symlink_to(elsewhere / "authorized_keys")
    err = refused(machine, capsys, "--key", public_key())
    assert "is a link" in err and "Nothing was changed" in err
    assert (elsewhere / "authorized_keys").read_text() == "" and machine.changes() == []


def test_when_an_earlier_sshd_setting_overrules_the_drop_in_it_is_taken_back_and_ssh_stays_off(machine, capsys):
    machine.before_include = ["PasswordAuthentication yes"]
    err = refused(machine, capsys, "--key", public_key())
    assert "passwordauthentication is yes, not no" in err and "SSH stays as it was" in err
    assert not machine.drop_in.exists() and not machine.on()
    assert machine.rules == {"runtime": set(), "permanent": set()}


def test_when_the_drop_in_is_overruled_an_earlier_one_is_put_back(machine, capsys):
    machine.setup("--key", public_key())
    machine.before_include = ["PermitRootLogin yes"]
    refused(machine, capsys, "--passwords")
    assert machine.drop_in.read_text() == DROP_IN


def test_without_firewalld_running_sshd_turns_on_and_it_says_nothing_was_opened(machine, capsys):
    machine.firewalld = False
    assert machine.setup("--key", public_key()) == 0
    assert machine.on() and machine.rules == {"runtime": set(), "permanent": set()}
    assert "no firewall is running" in capsys.readouterr().out


def test_a_zone_that_lets_ssh_in_already_is_pointed_out(machine, capsys):
    machine.services.add("ssh")
    machine.setup("--key", public_key())
    assert "lets SSH in already, without a rate limit" in capsys.readouterr().out


def test_without_sshd_installed_it_says_how_to_get_it(machine, capsys):
    machine.installed.discard("sshd")
    assert "openssh-server" in refused(machine, capsys, "--key", public_key(), code=127)
    assert machine.changes() == []


# ---------------------------------------------------------------------------------------------
# Off and status.
def test_off_takes_back_everything_on_did_and_leaves_the_keys(machine, capsys):
    key = public_key()
    machine.setup("--key", key)
    machine.units["sshd.socket"] = ["enabled", "active"]
    capsys.readouterr()
    assert machine.setup("--off") == 0
    out = capsys.readouterr().out
    assert machine.units == {"sshd.service": ["disabled", "inactive"], "sshd.socket": ["disabled", "inactive"]}
    assert not machine.drop_in.exists()
    assert machine.rules == {"runtime": set(), "permanent": set()}
    assert machine.keys_file.read_text() == f"{key}\n"
    assert "SSH is off" in out and "left as it is" in out
    assert machine.setup("--off") == 0


def test_off_leaves_a_zones_own_ssh_service_and_says_so(machine, capsys):
    machine.services.add("ssh")
    machine.setup("--key", public_key())
    machine.setup("--off")
    assert machine.services == {"ssh"}
    assert "still lets SSH in by itself" in capsys.readouterr().out


def test_off_with_firewalld_stopped_removes_the_saved_rule(machine):
    machine.setup("--key", public_key())
    machine.firewalld = False
    machine.setup("--off")
    assert machine.rules["permanent"] == set()


def test_status_says_whether_ssh_is_on_and_how(machine, capsys):
    assert machine.setup("--status") == 0
    assert capsys.readouterr().out.startswith("SSH: off")
    machine.setup("--key", public_key())
    capsys.readouterr()
    assert machine.setup("--status", "--json") == 0
    state = json.loads(capsys.readouterr().out)
    assert state == {
        "on": True, "enabled": True, "running": True, "socket": False, "dropIn": True, "passwords": False,
        "firewall": {"zone": "herald-os", "rateLimited": True, "open": False}, "user": "me", "keys": 1,
    }
    before = len(machine.calls)
    machine.setup("--status")
    out = capsys.readouterr().out
    assert "SSH: on (running)" in out and "keys only" in out and "rate-limited" in out
    # Status itself changes nothing and needs no root.
    assert machine.calls[before:] and all(looks(argv) and not root for root, argv in machine.calls[before:])


def test_status_says_when_the_firewall_needs_root_to_tell(machine, capsys):
    machine.queries_need_root = True
    machine.setup("--status")
    assert "needs root" in capsys.readouterr().out


# ---------------------------------------------------------------------------------------------
# Arguments, root and the rest of the CLI.
@pytest.mark.parametrize("args", [["--off", "--key", "x"], ["--status", "--passwords"], ["--off", "--status"], ["--json"], ["--key"], ["--bogus"], ["on"]])
def test_arguments_that_do_not_go_together_are_refused(machine, capsys, args):
    refused(machine, capsys, *args, code=2)
    assert machine.calls == []


def test_another_account_is_only_for_root(machine, capsys):
    assert "only root" in refused(machine, capsys, "--user", "someone", "--key", public_key(), code=2)


def test_as_root_it_writes_the_named_accounts_keys_as_that_account_and_runs_the_rest_without_sudo(machine, monkeypatch, tmp_path):
    seen = []
    machine.is_root = True
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli.pwd, "getpwnam", lambda name: machine.account if name == "me" else (_ for _ in ()).throw(KeyError(name)))
    monkeypatch.setattr(cli.os, "getgroups", lambda: [0])
    monkeypatch.setattr(cli.os, "setgroups", lambda groups: seen.append(("groups", groups)))
    monkeypatch.setattr(cli.os, "setegid", lambda gid: seen.append(("gid", gid)))
    monkeypatch.setattr(cli.os, "seteuid", lambda uid: seen.append(("uid", uid)))
    given = tmp_path / "keys"
    given.write_text(public_key() + "\n")
    assert machine.setup("--user", "me", "--keys-file", str(given)) == 0
    assert machine.calls and not any(root for root, _ in machine.calls)
    assert machine.on() and machine.keys_file.read_text() == public_key() + "\n"
    # Every stretch as the account starts with its groups and ids and ends back as root.
    assert seen[:3] == [("groups", []), ("gid", os.getgid()), ("uid", os.getuid())]
    assert seen[3:6] == [("uid", 0), ("gid", 0), ("groups", [0])]


def test_as_root_it_needs_to_be_told_whose_account_and_never_root(machine, monkeypatch, capsys):
    machine.is_root = True
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.delenv("SUDO_USER", raising=False)
    assert "--user <name>" in refused(machine, capsys, "--key", public_key(), code=2)
    assert "--user <name>" in refused(machine, capsys, "--user", "root", "--key", public_key(), code=2)
    # Off and status need no account.
    assert machine.setup("--off") == 0


def test_setup_ssh_is_dispatched_and_its_flags_are_in_the_help(monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(cli, "setup_ssh", lambda args: seen.append(args) or 0)
    assert cli.main(["setup", "ssh", "--status"]) == 0 and seen == [["--status"]]
    for flag in ("--key", "--github", "--keys-file", "--passwords", "--user", "--off", "--status", "--json"):
        assert flag in cli.COMMANDS["setup"], flag


def test_hermes_cannot_turn_ssh_on():
    """The bridge's tools never run `herald-os setup`: SSH is for a person at a terminal (or the first boot)."""
    for path in (ROOT / "plugins" / "herald-os-bridge" / "bridge").rglob("*.py"):
        text = path.read_text()
        assert "setup ssh" not in text and "sshd" not in text, path


# ---------------------------------------------------------------------------------------------
# Mutants: the CLI with one safety check taken out. Each scenario holds for the real CLI, and the
# mutant of its check must break it, so no check here goes untested.
SOURCE = CLI_PATH.read_text()


def mutant(old: str, new: str):
    assert SOURCE.count(old) == 1, f"the CLI no longer has exactly one {old!r}"
    module = types.ModuleType("herald_os_mutant")
    module.__file__ = str(CLI_PATH)
    exec(compile(SOURCE.replace(old, new), str(CLI_PATH), "exec"), module.__dict__)
    return module


def outcome(machine: System, *args: str):
    try:
        return machine.setup(*args)
    except SystemExit as stopped:
        return f"exit {stopped.code}"
    except Exception as error:  # a mutant may fail in ways the real CLI never does
        return f"error {error!r}"


def refuses_without_keys(machine: System, tmp_path: Path) -> bool:
    return outcome(machine) == "exit 1" and not machine.on() and machine.changes() == []


def keys_only_never_root(machine: System, tmp_path: Path) -> bool:
    return outcome(machine, "--key", public_key()) == 0 and machine.drop_in.read_text() == DROP_IN and machine.on()


def overruled_drop_in_stops_it(machine: System, tmp_path: Path) -> bool:
    machine.before_include = ["PasswordAuthentication yes"]
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on() and not machine.drop_in.exists()


def overruled_root_login_stops_it(machine: System, tmp_path: Path) -> bool:
    machine.before_include = ["PermitRootLogin yes"]
    return outcome(machine, "--passwords") == "exit 1" and not machine.on()


def keys_file_is_private(machine: System, tmp_path: Path) -> bool:
    outcome(machine, "--key", public_key())
    return stat.S_IMODE(machine.ssh.stat().st_mode) == 0o700 and stat.S_IMODE(machine.keys_file.stat().st_mode) == 0o600


def links_are_refused(machine: System, tmp_path: Path) -> bool:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    machine.ssh.symlink_to(elsewhere)
    return outcome(machine, "--key", public_key()) == "exit 1" and not (elsewhere / "authorized_keys").exists()


def bad_keys_are_refused(machine: System, tmp_path: Path) -> bool:
    return outcome(machine, "--key", f'command="sh" {public_key()}') == "exit 2" and not machine.ssh.exists()


def mismatched_key_data_is_refused(machine: System, tmp_path: Path) -> bool:
    return outcome(machine, "--key", public_key(data_kind="ssh-rsa")) == "exit 2" and not machine.ssh.exists()


def rate_limited(machine: System, tmp_path: Path) -> bool:
    outcome(machine, "--key", public_key())
    return machine.rules == {"runtime": {RULE}, "permanent": {RULE}}


def off_closes_everything(machine: System, tmp_path: Path) -> bool:
    outcome(machine, "--key", public_key())
    outcome(machine, "--off")
    return machine.units["sshd.service"] == ["disabled", "inactive"] and not machine.drop_in.exists() and machine.rules == {"runtime": set(), "permanent": set()}


def root_only_through_sudo(machine: System, tmp_path: Path) -> bool:
    return outcome(machine, "--key", public_key()) == 0 and machine.on()


MUTANTS = {
    "no refusal without keys": (refuses_without_keys, 'if not authorized(updated) and not opts["passwords"]:', "if False:"),
    "root logins allowed": (keys_only_never_root, '"PermitRootLogin no\\n"', '"PermitRootLogin yes\\n"'),
    "passwords on by default": (keys_only_never_root, "f\"PasswordAuthentication {'yes' if passwords else 'no'}\\n\"", '"PasswordAuthentication yes\\n"'),
    "keyboard-interactive left on": (keys_only_never_root, '"KbdInteractiveAuthentication no\\n"', '""'),
    "empty passwords left to sshd": (keys_only_never_root, '"PermitEmptyPasswords no\\n"', '""'),
    "sshd's word not checked": (overruled_drop_in_stops_it, "problems = sshd_overruled(effective.stdout, passwords) if", "problems = [] if"),
    "root login not checked": (overruled_root_login_stops_it, '{"permitrootlogin": "no", ', "{"),
    "authorized_keys left readable": (keys_file_is_private, "keys_file.chmod(0o600)", "keys_file.chmod(0o644)"),
    ".ssh left open": (keys_file_is_private, "folder.chmod(0o700)", "folder.chmod(0o755)"),
    "links followed": (links_are_refused, "if path.is_symlink():", "if False:"),
    "--key not checked": (bad_keys_are_refused, "        key = ssh_key(text)\n        if not key:", "        key = text\n        if not key:"),
    "key data not checked": (mismatched_key_data_is_refused, "blob[4:4 + size] != fields[0].encode()", "False"),
    "no rate limit": (rate_limited, 'accept limit value="4/m"\'', "accept'"),
    "off keeps the saved rule": (off_closes_everything, 'for permanent in ([], ["--permanent"]) if tool == "firewall-cmd" else ([],):', "for permanent in ([],):"),
    "off keeps the drop-in": (off_closes_everything, "    if SSHD_DROP_IN.exists():\n", "    if False:\n"),
    "off only stops sshd": (off_closes_everything, '["systemctl", "disable", "--now", unit]', '["systemctl", "is-active", unit]'),
    "root without sudo": (root_only_through_sudo, '    return ["sudo", *([] if sys.stdin.isatty() else ["-n"]), *argv]', "    return argv"),
}


@pytest.mark.parametrize("name", MUTANTS)
def test_each_safety_check_is_caught_when_taken_out(name, tmp_path, monkeypatch):
    scenario, old, new = MUTANTS[name]
    (tmp_path / "real").mkdir()
    (tmp_path / "mutant").mkdir()
    assert scenario(System(cli, tmp_path / "real", monkeypatch), tmp_path / "real"), "the real CLI fails the scenario"
    assert not scenario(System(mutant(old, new), tmp_path / "mutant", monkeypatch), tmp_path / "mutant"), f"the mutant ({name}) gets past it"
