"""`herald-os setup ssh` (linux/bin/herald-os): SSH on for keys only and never root, rate-limited per
address, off again, and its status. The commands it runs as root go to a stand-in for systemctl, sshd
(`-T -C` with Match blocks), nft, firewalld, loginctl, sudo and the rest, which keeps their state; the
files in the home folder, sshd's config and the drop-in are real, in a temporary directory, and
`ssh-keygen -lf` is the real one. Each safety check also has a mutant: the CLI with that check taken
out, which the same scenario must catch."""

import base64
import glob
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import pwd
import re
import shlex
import shutil
import signal
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

REAL_RUN = subprocess.run
# How the stand-in sshd reads a setting, written independently of the CLI's parser.
SETTING = re.compile(r"(\S+?)(\s*=\s*|\s+)(.*)$")
REQUIRED_PATHS = cli.SSH_LIMIT_REQUIRED
SSH_KEYGEN = shutil.which("ssh-keygen")
pytestmark = pytest.mark.skipif(not SSH_KEYGEN, reason="ssh-keygen is not installed")

DROP_IN = (
    "# Written by `herald-os setup ssh`; `herald-os setup ssh --off` removes it.\n"
    "PermitRootLogin no\n"
    "PasswordAuthentication no\n"
    "KbdInteractiveAuthentication no\n"
    "PermitEmptyPasswords no\n"
)
RULE = 'rule service name="ssh" accept'
# The whole command, so any change to a limit or a timeout shows.
GITHUB_CURL_EXACT = ["curl", "-fsSL", "--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3",
                     "--max-filesize", "1M", "--connect-timeout", "10", "--max-time", "20"]
CURL_LIMITS = ["--proto", "=https", "--proto-redir", "=https", "--max-redirs", "3", "--max-filesize", "1M"]
# sshd's own defaults for what the drop-in sets.
SSHD_DEFAULTS = {"port": "22", "permitrootlogin": "prohibit-password", "passwordauthentication": "yes", "kbdinteractiveauthentication": "yes", "permitemptypasswords": "no"}
ROOT_PROBE = "user=root,host=x,addr=203.0.113.1"
REMOTE_PROBE = "user=me,host=x,addr=203.0.113.1"

# Key material ssh-keygen reads: the P-256 base point is a valid public point.
P256 = b"\x04" + bytes.fromhex("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296" "4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5")


def _string(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


def _mpint(number: int) -> bytes:
    data = number.to_bytes((number.bit_length() + 7) // 8, "big")
    return _string(b"\0" + data if data[0] & 0x80 else data)


def key_blob(kind: str, seed: int = 1, bits: int = 2048) -> bytes:
    name = _string(kind.encode())
    if kind == "ssh-rsa":
        return name + _mpint(65537) + _mpint((1 << (bits - 1)) | (seed * 2 + 1))
    if kind.startswith("ecdsa-sha2-"):
        return name + _string(b"nistp256") + _string(P256)
    if kind == "sk-ecdsa-sha2-nistp256@openssh.com":
        return name + _string(b"nistp256") + _string(P256) + _string(b"ssh:")
    if kind == "sk-ssh-ed25519@openssh.com":
        return name + _string(bytes([seed]) * 32) + _string(b"ssh:")
    return name + _string(bytes([seed]) * 32)


def public_key(kind: str = "ssh-ed25519", comment: str = "me@laptop", seed: int = 1, data_kind: str | None = None, bits: int = 2048) -> str:
    """A public key line in OpenSSH's format, with made-up key material that ssh-keygen reads."""
    blob = key_blob(data_kind or kind, seed, bits)
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
    if tool == "loginctl":
        return argv[1] in ("list-sessions", "show-session")
    if tool == "nft":
        return argv[1] == "list"
    return tool in ("sshd", "ip", "curl", "cat") or argv[:2] == ["ssh-keygen", "-lf"]


def match_applies(condition: str, probe: str | None) -> bool:
    """Whether a Match line applies to an `sshd -T -C` probe: all, User, Address, Host."""
    if probe is None:
        return False
    spec = dict(part.split("=", 1) for part in probe.split(","))
    words = condition.split()
    if words == ["all"]:
        return True
    for criterion, value in zip(words[::2], words[1::2]):
        criterion = criterion.lower()
        if criterion == "user" and spec["user"] not in value.split(","):
            return False
        if criterion == "host" and spec["host"] not in value.split(","):
            return False
        if criterion == "address" and not any(ipaddress.ip_address(spec["addr"]) in ipaddress.ip_network(net, strict=False) for net in value.split(",")):
            return False
        if criterion not in ("user", "host", "address"):
            return False
    return True


class System:
    """A machine with sshd installed and off, firewalld running with the herald-os zone, nftables, and a
    person whose home is in tmp_path. `module` is the CLI under test (a mutant, sometimes)."""

    def __init__(self, module, tmp_path: Path, monkeypatch):
        self.module = module
        self.home = tmp_path / "home" / "me"
        self.home.mkdir(parents=True)
        self.etc = tmp_path / "etc-ssh"
        (self.etc / "sshd_config.d").mkdir(parents=True)
        (self.etc / "ssh_host_ed25519_key.pub").write_text(public_key(comment="root@host") + "\n")
        self.config = self.etc / "sshd_config"
        self.main_config()
        self.drop_in = self.etc / "sshd_config.d" / "10-herald-os.conf"
        self.limit_rules = tmp_path / "etc-herald-os" / "ssh-limit.nft"
        self.limit_unit = tmp_path / "etc-systemd" / "herald-os-ssh-limit.service"
        # The CLI's own list, moved under tmp_path, so a mutant that drops one is tested as it is.
        self.required = tuple(tmp_path / "etc-systemd" / path.relative_to("/etc/systemd/system") for path in module.SSH_LIMIT_REQUIRED)
        # Files root cannot read either (a broken mount, an SELinux denial), and Include patterns
        # whose listing fails.
        self.unreadable: set[Path] = set()
        self.unlistable: set[str] = set()
        # The limit unit fails when it starts (nft refuses the table, the kernel lacks nf_tables).
        self.limit_fails = False
        # How often systemd restarted sshd because a unit it Requires= was restarted.
        self.sshd_bounced = 0
        # `nft -f` refuses the file (a kernel without a needed nf_tables feature).
        self.nft_fails = False
        # Commands (argv prefixes, without sudo) that hang: a real script that sleeps runs in their
        # place under the caller's own timeout, so TimeoutExpired comes from subprocess itself.
        self.hang: list[list[str]] = []
        self.hanger = tmp_path / "hang"
        # It leaves a mark first, so a test can tell when the command is hanging.
        self.hanger.write_text("#!/bin/sh\n[ -z \"$HANG_MARK\" ] || : >\"$HANG_MARK\"\nexec sleep 30\n")
        self.hanger.chmod(0o755)
        # Commands that take effect and then hang, as a systemctl can after it has enabled or started
        # a unit; and, once one of them has, the queries that hang from then on.
        self.hang_after: list[list[str]] = []
        self.then_hang: list[list[str]] = []
        # The timeout every command was given (None when it had none).
        self.timeouts: list[tuple[list[str], float | None]] = []
        self.calls: list[tuple[bool, list[str]]] = []
        self.units = {name: ["disabled", "inactive"] for name in ("sshd.service", "sshd.socket", "herald-os-ssh-limit.service")}
        self.table: str | None = None
        self.firewalld = True
        self.installed = {"sshd", "firewall-cmd", "firewall-offline-cmd", "restorecon", "curl", "ssh-keygen", "nft"}
        self.zone = "herald-os"
        self.rules = {"runtime": set(), "permanent": set()}
        self.services: set[str] = set()
        self.queries_need_root = False
        self.github: dict[str, tuple[str, int]] = {}
        # Settings a probe gets that no file the CLI reads shows (as from a file it cannot see).
        self.hidden: dict[str, dict[str, str]] = {}
        # logind sessions: id -> service.
        self.sessions: dict[str, str] = {}
        # The CLI runs as root (the first boot), so commands need no sudo to be root's.
        self.is_root = False
        self.account = pwd.struct_passwd(("me", "x", os.getuid(), os.getgid(), "", str(self.home), "/bin/bash"))
        monkeypatch.setattr(module, "SSHD_DROP_IN", self.drop_in)
        monkeypatch.setattr(module, "SSHD_CONFIG", self.config)
        monkeypatch.setattr(module, "SSH_HOST_KEYS", self.etc)
        monkeypatch.setattr(module, "SSH_LIMIT_RULES", self.limit_rules)
        monkeypatch.setattr(module, "SSH_LIMIT_UNIT", self.limit_unit)
        monkeypatch.setattr(module, "SSH_LIMIT_REQUIRED", self.required)
        monkeypatch.setattr(module.os, "geteuid", lambda: 1000)
        monkeypatch.setattr(module.pwd, "getpwuid", lambda uid: self.account)
        monkeypatch.setattr(module.shutil, "which", lambda name, path=None: f"/usr/sbin/{name}" if name in self.installed else None)
        monkeypatch.setattr(module.subprocess, "run", self.run)
        # Every command setup ssh runs goes through ssh_run; here it comes to the stand-in, with the
        # timeout ssh_run itself would use.
        monkeypatch.setattr(module, "ssh_run", lambda argv, timeout=None, input=None: self.run(argv, timeout=module.ssh_limit(timeout), input=input))
        # `sudo -v` in a terminal, which asks for the password.
        monkeypatch.setattr(module.subprocess, "call", lambda argv, **kwargs: self.run(argv).returncode)
        # sudo lets this account in (False: it wants a password nobody can type).
        self.sudo_lets_in = True
        monkeypatch.delenv("XDG_SESSION_ID", raising=False)

    def main_config(self, *before: str) -> None:
        """sshd_config: `before` ahead of its Include line, as Fedora's has its own settings after it."""
        self.config.write_text("".join(f"{line}\n" for line in before) + f"Include {self.etc}/sshd_config.d/*.conf\n")

    # -- the stand-in ----------------------------------------------------------------------------
    def run(self, argv, capture_output=False, text=False, check=False, timeout=None, input=None, **_):
        argv = list(argv)
        root = argv[:1] == ["sudo"]
        if root:
            argv = argv[1:]
            if argv[:1] == ["-n"]:
                argv = argv[1:]
        self.calls.append((root, argv))
        self.timeouts.append((argv, timeout))
        if any(argv[:len(prefix)] == prefix for prefix in self.hang):
            return REAL_RUN([str(self.hanger), *argv], capture_output=True, text=True, timeout=timeout)
        if argv == ["-v"]:
            return subprocess.CompletedProcess(argv, 0 if self.sudo_lets_in else 1, "", "")
        if argv[:3] == ["ssh-keygen", "-lf", "-"]:
            return REAL_RUN([SSH_KEYGEN, "-lf", "-"], input=input, capture_output=True, text=True, check=False)
        out, code = self.answer(argv, root or self.is_root)
        if any(argv[:len(prefix)] == prefix for prefix in self.hang_after):
            self.hang += self.then_hang
            return REAL_RUN([str(self.hanger), *argv], capture_output=True, text=True, timeout=timeout)
        return subprocess.CompletedProcess(argv, code, out, "" if code == 0 else f"{argv[0]}: refused")

    def answer(self, argv: list[str], root: bool) -> tuple[str, int]:
        tool = Path(argv[0]).name
        if tool == "systemctl":
            return self.systemctl(argv[1:], root)
        if tool == "sshd":
            if not root:
                return "", 1  # host keys are root's
            try:
                effective = self.effective(argv[3] if argv[2:3] == ["-C"] else None)
            except ValueError:
                return "", 255
            return ("", 0) if argv[1] == "-t" else (effective, 0)
        if tool == "cat":
            assert argv[1] == "--", argv
            if not root:
                return "", 1
            path = Path(argv[2])
            return (path.read_text(), 0) if path.is_file() and path not in self.unreadable else ("", 1)
        if tool == "env" and argv[1:4] == ["LC_ALL=C", "sh", "-c"]:
            # The root-side Include listing, run for real (the paths are in tmp_path); sshd_config.d
            # is root's alone, as on Fedora.
            if not root or argv[-1] in self.unlistable:
                return "", 1
            listed = REAL_RUN(argv, capture_output=True, text=True)
            return listed.stdout, listed.returncode
        if tool == "ssh-keygen":
            if argv[1] == "-A":
                return "", 0 if root else 1
            return "256 SHA256:hostkeyfingerprint root@host (ED25519)\n", 0
        if tool == "install":
            if not root:
                return "", 1
            Path(argv[-1]).parent.mkdir(parents=True, exist_ok=True)
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
        if tool == "nft":
            if not root:
                return "", 1
            if argv[1:] == ["list", "table", "inet", "herald_os_ssh"]:
                return (self.table or "", 0 if self.table else 1)
            if argv[1] == "-f":
                if self.nft_fails:
                    return "", 1
                self.table = Path(argv[2]).read_text()
                return "", 0
            if argv[1:] == ["delete", "table", "inet", "herald_os_ssh"]:
                code = 0 if self.table else 1
                self.table = None
                return "", code
            raise AssertionError(f"unexpected nft {argv}")
        if tool in ("firewall-cmd", "firewall-offline-cmd"):
            return self.firewall(tool, argv[1:], root)
        if tool == "loginctl":
            return self.loginctl(argv[1:], root)
        if tool == "ip":
            return ("2: enp1s0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic enp1s0\n"
                    "2: enp1s0    inet6 fd00::20/64 scope global dynamic\n"), 0
        if tool == "curl":
            return self.github.get(argv[-1], ("", 22))
        raise AssertionError(f"unexpected command: {argv}")

    def systemctl(self, args: list[str], root: bool) -> tuple[str, int]:
        limit = "herald-os-ssh-limit.service"
        if args[:4] == ["show", "-p", "LoadState", "--value"]:
            loaded = args[4] != limit or self.limit_unit.exists()
            return ("loaded\n" if loaded and args[4] in self.units else "not-found\n"), 0
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
        if args in (["start", "sshd-keygen.target"], ["daemon-reload"]):
            return "", 0
        if args[0] == "enable":
            self.units[args[1]][0] = "enabled"
            return "", 0
        if args == ["reload-or-restart", "sshd.service"]:
            return "", 0 if self.start("sshd.service") else 1
        if args == ["restart", limit]:
            # Requires= passes a restart on: whatever needs the limit and runs is restarted with it.
            bounced = [unit for unit in ("sshd.service", "sshd.socket") if self.units[unit][1] == "active" and limit in self.requires(unit)]
            self.sshd_bounced += len(bounced)
            return "", 0 if self.start(limit) else 1
        if args[0] == "stop":
            self.units[args[1]][1] = "inactive"
            if args[1] == limit:
                self.table = None
                # Requires= passes a stop on.
                for unit in ("sshd.service", "sshd.socket"):
                    if limit in self.requires(unit):
                        self.units[unit][1] = "inactive"
            return "", 0
        if args[0] == "reset-failed":
            if self.units[args[1]][1] == "failed":
                self.units[args[1]][1] = "inactive"
            return "", 0
        if args[0] == "disable" and len(args) == 2:
            self.units[args[1]][0] = "disabled"
            return "", 0
        if args[:2] == ["disable", "--now"]:
            self.units[args[2]] = ["disabled", "inactive"]
            if args[2] == limit:
                self.table = None
            return "", 0
        raise AssertionError(f"unexpected systemctl {args}")

    def requires(self, unit: str) -> list[str]:
        """What a unit's drop-ins in /etc/systemd/system/<unit>.d say it Requires=, read from disk."""
        found = []
        for path in self.required:
            if path.parent.name == f"{unit}.d" and path.is_file() and not path.is_symlink():
                found += [line.split("=", 1)[1] for line in path.read_text().splitlines() if line.startswith("Requires=")]
        return found

    def start(self, unit: str) -> bool:
        """systemd starting a unit: what it Requires= starts first, and a failure leaves it stopped."""
        limit = "herald-os-ssh-limit.service"
        if unit == limit:
            if self.limit_fails or not self.limit_unit.exists():
                self.units[limit][1] = "failed"
                self.table = None
                return False
            self.units[limit][1] = "active"
            self.table = self.limit_rules.read_text()
            return True
        for needed in self.requires(unit):
            if self.units.get(needed, ["", ""])[1] != "active" and not self.start(needed):
                self.units[unit][1] = "inactive"
                return False
        self.units[unit][1] = "active"
        return True

    def boot(self) -> None:
        """A restart: nothing runs, then every enabled unit starts, each after what it needs."""
        self.table = None
        for state in self.units.values():
            state[1] = "inactive"
        for unit in ("herald-os-ssh-limit.service", "sshd.socket", "sshd.service"):
            if self.units[unit][0] == "enabled":
                self.start(unit)

    def connect(self) -> bool:
        """A connection to port 22: sshd.service answers, or sshd.socket starts it."""
        if self.units["sshd.service"][1] == "active":
            return True
        return self.units["sshd.socket"][1] == "active" and self.start("sshd.service")

    def config_lines(self, path: Path, depth: int = 0):
        """sshd's config as sshd reads it: includes in place, and None where an included file ends.
        Like sshd, it gives up on Includes nested too deep."""
        if depth > 32:
            raise ValueError("Include nested too deep")
        for raw in path.read_text().splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parsed = SETTING.match(line)
            if parsed and parsed.group(1).lower() == "include":
                # sshd's own reading: "=" or spaces, quotes, several patterns, relative to /etc/ssh;
                # an unclosed quote makes it refuse the file (ValueError).
                for pattern in shlex.split(parsed.group(3)):
                    full = pattern if pattern.startswith("/") else str(self.etc / pattern)
                    for found in sorted(glob.glob(full)):
                        yield from self.config_lines(Path(found), depth + 1)
                        yield None
            else:
                yield line

    def effective(self, probe: str | None) -> str:
        """`sshd -T [-C probe]`: the first value read wins, and a Match block that applies wins over it."""
        everywhere: dict[str, str] = {}
        matched: dict[str, str] = {}
        applies = None
        for line in self.config_lines(self.config):
            if line is None:
                applies = None
                continue
            parsed = SETTING.match(line)
            key, value = (parsed.group(1), parsed.group(3)) if parsed else (line, "")
            if key.lower() == "match":
                applies = match_applies(value, probe)
            elif applies is None:
                everywhere.setdefault(key.lower(), value.strip().lower())
            elif applies:
                matched.setdefault(key.lower(), value.strip().lower())
        values = {**SSHD_DEFAULTS, **everywhere, **matched, **self.hidden.get(probe or "", {})}
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

    def loginctl(self, args: list[str], root: bool) -> tuple[str, int]:
        if args == ["list-sessions", "--no-legend"]:
            return "".join(f"{session} 1000 me seat0 tty\n" for session in self.sessions), 0
        if args[0] == "show-session":
            return self.sessions.get(args[1], "") + "\n", 0 if args[1] in self.sessions else 1
        if args[0] == "terminate-session" and root:
            self.sessions.pop(args[1], None)
            return "", 0
        return "", 1

    # -- what the tests look at ------------------------------------------------------------------
    @property
    def ssh(self) -> Path:
        return self.home / ".ssh"

    @property
    def keys_file(self) -> Path:
        return self.ssh / "authorized_keys"

    def on(self) -> bool:
        return self.units["sshd.service"] == ["enabled", "active"]

    def limited(self) -> bool:
        return self.units["herald-os-ssh-limit.service"] == ["enabled", "active"] and bool(self.table)

    def sshd_needs_the_limit(self) -> bool:
        return all("herald-os-ssh-limit.service" in self.requires(unit) for unit in ("sshd.service", "sshd.socket"))

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


def test_ssh_keygen_s_listing_says_which_keys_are_strong_enough():
    assert cli.key_weakness("256 SHA256:abc me (ED25519)") is None
    assert cli.key_weakness("521 SHA256:abc me (ECDSA)") is None
    assert cli.key_weakness("256 SHA256:abc me (ED25519-SK)") is None
    assert cli.key_weakness("256 SHA256:abc me (ECDSA-SK)") is None
    assert cli.key_weakness("2048 SHA256:abc me (RSA)") is None
    assert cli.key_weakness("4096 SHA256:abc a comment with spaces (RSA)") is None
    assert "too short" in cli.key_weakness("2047 SHA256:abc me (RSA)")
    assert "too short" in cli.key_weakness("1024 SHA256:abc me (RSA)")
    assert "not taken" in cli.key_weakness("1024 SHA256:abc me (DSA)")
    assert "not taken" in cli.key_weakness("256 SHA256:abc me (XMSS)")
    assert "cannot read" in cli.key_weakness("")
    assert "cannot read" in cli.key_weakness("(stdin) is not a public key file.")


@pytest.mark.parametrize("kind, bits, taken", [
    ("ssh-ed25519", 0, True), ("ecdsa-sha2-nistp256", 0, True), ("sk-ssh-ed25519@openssh.com", 0, True),
    ("sk-ecdsa-sha2-nistp256@openssh.com", 0, True), ("ssh-rsa", 2048, True), ("ssh-rsa", 3072, True),
    ("ssh-rsa", 2047, False), ("ssh-rsa", 1024, False),
])
def test_the_real_ssh_keygen_reads_the_bits_and_type(kind, bits, taken):
    listing, weakness = cli.key_listing(public_key(kind, bits=bits or 2048))
    assert (weakness is None) == taken, (listing, weakness)
    if kind == "ssh-rsa":
        assert listing.startswith(f"{bits} SHA256:")


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


def test_a_match_block_that_lets_in_more_is_found_in_any_file():
    files = [
        ("/etc/ssh/sshd_config", "PasswordAuthentication yes\nMatch User backup\n  # PermitRootLogin yes\n  X11Forwarding no\n"),
        ("/etc/ssh/sshd_config.d/50-x.conf", "Match Address 10.0.0.0/8\n\tPasswordAuthentication yes\n"
                                             "Match User admin\n  KbdInteractiveAuthentication=yes\n  PermitRootLogin prohibit-password\n"
                                             "Match all\n  PermitEmptyPasswords yes\n  AuthenticationMethods publickey,keyboard-interactive:pam\n"),
        ("/etc/ssh/sshd_config.d/60-y.conf", "Match Group ops\n  AuthenticationMethods password\n  ChallengeResponseAuthentication yes\n  PermitRootLogin no\n"),
    ]
    found = cli.match_weakening(files, passwords=False)
    assert found == [
        "/etc/ssh/sshd_config.d/50-x.conf line 2: PasswordAuthentication yes under Match Address 10.0.0.0/8",
        "/etc/ssh/sshd_config.d/50-x.conf line 4: KbdInteractiveAuthentication yes under Match User admin",
        "/etc/ssh/sshd_config.d/50-x.conf line 5: PermitRootLogin prohibit-password under Match User admin",
        "/etc/ssh/sshd_config.d/50-x.conf line 7: PermitEmptyPasswords yes under Match all",
        "/etc/ssh/sshd_config.d/50-x.conf line 8: AuthenticationMethods publickey,keyboard-interactive:pam under Match all",
        "/etc/ssh/sshd_config.d/60-y.conf line 2: AuthenticationMethods password under Match Group ops",
        "/etc/ssh/sshd_config.d/60-y.conf line 3: ChallengeResponseAuthentication yes under Match Group ops",
    ]
    # With passwords asked for, a Match that turns passwords on is no weaker; one that turns on more still is.
    with_passwords = cli.match_weakening(files, passwords=True)
    assert not any("PasswordAuthentication yes" in line or "AuthenticationMethods password" in line for line in with_passwords)
    assert any("KbdInteractiveAuthentication" in line for line in with_passwords)
    assert cli.match_weakening([("x", "Match User a\n  PasswordAuthentication no\n  AuthenticationMethods publickey\n")], passwords=False) == []


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


def test_with_a_key_ssh_is_on_for_keys_only_rate_limited_per_address_and_it_says_how_to_reach_it(machine, capsys):
    key = public_key()
    assert machine.setup("--key", key) == 0
    out = capsys.readouterr().out
    assert machine.keys_file.read_text() == f"{key}\n"
    assert stat.S_IMODE(machine.ssh.stat().st_mode) == 0o700
    assert stat.S_IMODE(machine.keys_file.stat().st_mode) == 0o600
    assert machine.drop_in.read_text() == DROP_IN
    assert machine.on() and machine.limited()
    assert machine.limit_rules.read_text() == cli.ssh_limit_rules(["22"])
    assert machine.limit_unit.read_text() == cli.ssh_limit_unit("/usr/sbin/nft")
    assert machine.rules == {"runtime": {RULE}, "permanent": {RULE}}
    assert ["restorecon", "-R", str(machine.ssh)] in machine.changes()
    assert ["restorecon", str(machine.drop_in)] in machine.changes()
    # Root only where it is needed: the home folder is written as the person.
    assert all(root for root, argv in machine.calls if argv in machine.changes() and argv[0] != "ssh-keygen")
    assert "keys only, no passwords" in out and "never root" in out
    assert "SHA256:hostkeyfingerprint" in out
    assert "ssh me@192.168.1.20" in out and "ssh me@fd00::20" in out
    assert "at most 4 a minute new connections from each address" in out


def test_each_given_key_s_fingerprint_is_shown_before_it_goes_in(machine, capsys):
    one, two = public_key(seed=1, comment="laptop"), public_key("ecdsa-sha2-nistp256", comment="phone")
    machine.setup("--key", one)
    capsys.readouterr()
    assert machine.setup("--key", one, "--key", two) == 0
    out = capsys.readouterr().out
    first = REAL_RUN([SSH_KEYGEN, "-lf", "-"], input=one + "\n", capture_output=True, text=True).stdout.strip()
    second = REAL_RUN([SSH_KEYGEN, "-lf", "-"], input=two + "\n", capture_output=True, text=True).stdout.strip()
    assert f"key {first}: there already" in out and f"key {second}: adding" in out
    assert out.index(second) < out.index("SSH is on")


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
    first = (machine.keys_file.read_text(), machine.drop_in.read_text(), machine.limit_rules.read_text(), {k: set(v) for k, v in machine.rules.items()})
    capsys.readouterr()
    assert machine.setup("--key", key) == 0
    assert "added" not in capsys.readouterr().out
    assert (machine.keys_file.read_text(), machine.drop_in.read_text(), machine.limit_rules.read_text(), machine.rules) == first
    assert machine.keys_file.read_text().count(bare(key)) == 1
    assert machine.limited()


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


@pytest.mark.parametrize("bits", [1024, 2047])
def test_an_rsa_key_under_2048_bits_is_refused(machine, capsys, bits):
    err = refused(machine, capsys, "--key", public_key("ssh-rsa", bits=bits), code=2)
    assert f"an RSA key of {bits} bits is too short (2048 at least)" in err and "Nothing was changed" in err
    assert machine.changes() == [] and not machine.ssh.exists()


@pytest.mark.parametrize("kind", ["ssh-rsa", "ecdsa-sha2-nistp256", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"])
def test_rsa_of_2048_bits_ecdsa_and_security_keys_are_taken(machine, kind):
    assert machine.setup("--key", public_key(kind)) == 0
    assert machine.keys_file.read_text() == public_key(kind) + "\n"


def test_a_keys_file_gives_its_keys_and_skips_comments(machine, tmp_path, capsys):
    one, two = public_key(seed=1), public_key(seed=2)
    given = tmp_path / "keys"
    given.write_text(f"# from the install\n{one}\n\n  {two}\n")
    assert machine.setup("--keys-file", str(given)) == 0
    assert machine.keys_file.read_text() == f"{one}\n{two}\n"
    given.write_text(f"{one}\nnot a key\n")
    assert "line 2: not an SSH public key" in refused(machine, capsys, "--keys-file", str(given), code=2)
    given.write_text(f"{one}\n{public_key('ssh-rsa', bits=1024)}\n")
    assert "line 2: an RSA key of 1024 bits is too short" in refused(machine, capsys, "--keys-file", str(given), code=2)


def test_github_keys_are_read_over_https_only_within_limits_and_marked(machine, capsys):
    one, two = public_key(comment="", seed=1), public_key(comment="", seed=2)
    machine.github["https://github.com/octocat.keys"] = (f"{one}\n{two}\nssh-dss AAAA\n", 0)
    assert machine.setup("--github", "octocat") == 0
    assert machine.keys_file.read_text() == f"{one} github:octocat\n{two} github:octocat\n"
    curl = next(argv for _, argv in machine.calls if argv[0] == "curl")
    assert curl[-1] == "https://github.com/octocat.keys"
    for at in range(0, len(CURL_LIMITS), 2):
        assert curl[curl.index(CURL_LIMITS[at]) + 1] == CURL_LIMITS[at + 1]
    assert "--max-time" in curl and "--connect-timeout" in curl
    out = capsys.readouterr().out
    assert out.count(": adding") == 2 and "github:octocat (ED25519)" in out


def test_a_github_page_over_1_mib_is_refused(machine, capsys):
    machine.github["https://github.com/big.keys"] = (public_key() + "\n" + "#" * (1 << 20), 0)
    assert "larger than a key list can be" in refused(machine, capsys, "--github", "big")
    assert machine.changes() == []


def test_weak_github_keys_are_skipped_and_a_user_with_only_weak_ones_is_refused(machine, capsys):
    weak, good = public_key("ssh-rsa", comment="", bits=1024), public_key(comment="", seed=3)
    machine.github["https://github.com/mixed.keys"] = (f"{weak}\n{good}\n", 0)
    assert machine.setup("--github", "mixed") == 0
    assert machine.keys_file.read_text() == f"{good} github:mixed\n"
    out = capsys.readouterr().out
    assert "skipping a key of type ssh-rsa (1024 bits): an RSA key of 1024 bits is too short" in out
    assert weak.split()[1] not in out and weak.split()[1][:20] not in out
    machine.github["https://github.com/weak.keys"] = (f"{weak}\n", 0)
    assert "none of weak's SSH keys on GitHub" in refused(machine, capsys, "--github", "weak")


def test_a_github_user_without_keys_or_a_page_or_a_good_name_is_refused(machine, capsys):
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


def assert_backed_out(machine: System) -> None:
    assert not machine.drop_in.exists() and not machine.on() and not machine.limited()
    assert machine.rules == {"runtime": set(), "permanent": set()}


def test_when_an_earlier_sshd_setting_overrules_the_drop_in_it_is_taken_back_and_ssh_stays_off(machine, capsys):
    machine.main_config("PasswordAuthentication yes")
    err = refused(machine, capsys, "--key", public_key())
    assert "passwordauthentication is yes, not no by default" in err and "SSH stays as it was" in err
    assert_backed_out(machine)


@pytest.mark.parametrize("block", [
    "Match User alice\n  PasswordAuthentication yes",
    "Match Address 10.0.0.0/8\n  KbdInteractiveAuthentication yes",
    "Match User root\n  PermitRootLogin prohibit-password",
    "Match Group wheel\n  PermitEmptyPasswords yes",
    "Match all\n  AuthenticationMethods keyboard-interactive",
])
def test_a_match_block_that_lets_in_more_stops_it(machine, capsys, block):
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text(block + "\n")
    err = refused(machine, capsys, "--key", public_key())
    assert "under Match" in err and "50-site.conf line 2" in err
    assert_backed_out(machine)


def test_a_match_block_in_sshd_config_itself_stops_it(machine, capsys):
    machine.config.write_text(machine.config.read_text() + "Match Address 203.0.113.0/24\n  PermitRootLogin yes\n")
    err = refused(machine, capsys, "--key", public_key())
    assert "sshd_config line 3: PermitRootLogin yes under Match Address 203.0.113.0/24" in err
    assert f"permitrootlogin is yes, not no for {ROOT_PROBE}" in err
    assert_backed_out(machine)


@pytest.mark.parametrize("probe", [ROOT_PROBE, REMOTE_PROBE, "user=me,host=localhost,addr=127.0.0.1"])
def test_sshd_is_asked_about_root_and_the_account_from_the_internet_and_any_mismatch_backs_out(machine, capsys, probe):
    machine.hidden[probe] = {"passwordauthentication": "yes"}
    err = refused(machine, capsys, "--key", public_key())
    assert f"passwordauthentication is yes, not no for {probe}" in err
    assert_backed_out(machine)
    asked = [argv[3] for _, argv in machine.calls if Path(argv[0]).name == "sshd" and argv[1:3] == ["-T", "-C"]]
    assert {ROOT_PROBE, REMOTE_PROBE} <= set(asked)


def test_when_the_drop_in_is_overruled_an_earlier_one_is_put_back(machine, capsys):
    machine.setup("--key", public_key())
    machine.main_config("PermitRootLogin yes")
    refused(machine, capsys, "--passwords")
    assert machine.drop_in.read_text() == DROP_IN


def test_the_rate_limit_follows_the_port_sshd_listens_on(machine):
    (machine.etc / "sshd_config.d" / "20-port.conf").write_text("Port 2222\n")
    machine.setup("--key", public_key())
    assert "tcp dport { 2222 } ct state new" in machine.limit_rules.read_text()


def test_the_rate_limit_counts_each_address_on_its_own():
    rules = cli.ssh_limit_rules(["22", "2222"])
    assert rules.splitlines()[2:5] == ["table inet herald_os_ssh", "delete table inet herald_os_ssh", "table inet herald_os_ssh {"]
    assert "type filter hook input priority filter - 10; policy accept;" in rules
    assert "flags dynamic,timeout" in rules
    assert "tcp dport { 22, 2222 } ct state new add @sources4 { ip saddr limit rate over 4/minute burst 4 packets } counter drop" in rules
    assert "tcp dport { 22, 2222 } ct state new add @sources6 { ip6 saddr and ffff:ffff:ffff:ffff:: limit rate over 4/minute burst 4 packets } counter drop" in rules
    unit = cli.ssh_limit_unit("/usr/sbin/nft")
    assert "ExecStart=/usr/sbin/nft -f /etc/herald-os/ssh-limit.nft" in unit
    assert "ExecStop=/usr/sbin/nft delete table inet herald_os_ssh" in unit
    assert "Before=network-pre.target sshd.service sshd.socket" in unit and "WantedBy=multi-user.target" in unit
    # firewalld's own rule has no limit of its own: one shared by every address could be used up by anyone.
    assert "limit" not in cli.SSH_RICH_RULE


@pytest.mark.skipif(os.geteuid() != 0 or not shutil.which("nft"), reason="checking an nftables file needs nft and root")
def test_nft_takes_the_rate_limit(tmp_path):
    path = tmp_path / "limit.nft"
    path.write_text(cli.ssh_limit_rules(["22"]))
    assert REAL_RUN(["nft", "-c", "-f", str(path)], capture_output=True, text=True).returncode == 0


def test_without_firewalld_running_it_refuses_unless_told_and_then_warns_loudly(machine, capsys):
    machine.firewalld = False
    err = refused(machine, capsys, "--key", public_key())
    assert "firewalld is not running" in err and "--no-firewall" in err and "Nothing was changed" in err
    assert machine.changes() == [] and not machine.on()
    assert machine.setup("--key", public_key(), "--no-firewall") == 0
    captured = capsys.readouterr()
    assert captured.err.count("WARNING: firewalld is not running") == 2
    assert machine.on() and machine.limited() and machine.rules == {"runtime": set(), "permanent": set()}
    assert "none running (--no-firewall)" in captured.out


def test_without_nft_it_refuses_while_firewalld_runs(machine, capsys):
    machine.installed.discard("nft")
    assert "rate-limited per address" in refused(machine, capsys, "--key", public_key(), code=127)
    assert machine.changes() == []


def test_a_zone_that_lets_ssh_in_already_is_pointed_out(machine, capsys):
    machine.services.add("ssh")
    machine.setup("--key", public_key())
    assert "let SSH in already, by its own ssh service" in capsys.readouterr().out


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
    assert machine.units == {name: ["disabled", "inactive"] for name in machine.units}
    assert not machine.drop_in.exists() and not machine.limit_rules.exists() and not machine.limit_unit.exists()
    assert machine.table is None
    assert machine.rules == {"runtime": set(), "permanent": set()}
    assert machine.keys_file.read_text() == f"{key}\n"
    assert "SSH is off" in out and "left as it is" in out
    assert machine.setup("--off") == 0


def test_off_removes_a_rate_limit_table_left_without_its_unit(machine):
    machine.table = "table inet herald_os_ssh {}"
    machine.setup("--off")
    assert machine.table is None


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


def test_off_without_a_terminal_leaves_ssh_sessions_and_says_how_to_end_them(machine, capsys):
    machine.setup("--key", public_key())
    machine.sessions = {"7": "sshd", "2": "greetd"}
    capsys.readouterr()
    machine.setup("--off")
    out = capsys.readouterr().out
    assert machine.sessions == {"7": "sshd", "2": "greetd"}
    assert "1 SSH session(s) are still open (7)" in out and "--off --end-sessions" in out and "loginctl terminate-session" in out


def test_off_end_sessions_ends_only_ssh_sessions_and_the_caller_s_own_last(machine, monkeypatch, capsys):
    machine.setup("--key", public_key())
    machine.sessions = {"3": "sshd", "4": "sshd", "5": "greetd", "6": "sshd"}
    monkeypatch.setenv("XDG_SESSION_ID", "3")
    machine.setup("--off", "--end-sessions")
    assert machine.sessions == {"5": "greetd"}
    ended = [argv[2] for _, argv in machine.calls if argv[:2] == ["loginctl", "terminate-session"]]
    assert ended == ["4", "6", "3"]
    # Sessions end after everything else, so ending the caller's own cannot stop SSH half turned off.
    last_change = max(at for at, (_, argv) in enumerate(machine.calls) if argv[:1] == ["rm"] or argv[:2] == ["systemctl", "disable"])
    first_end = min(at for at, (_, argv) in enumerate(machine.calls) if argv[:2] == ["loginctl", "terminate-session"])
    assert last_change < first_end


@pytest.mark.parametrize("answer, ended", [("y", True), ("yes", True), ("", False), ("n", False)])
def test_off_in_a_terminal_asks_whether_to_end_ssh_sessions(machine, monkeypatch, capsys, answer, ended):
    machine.setup("--key", public_key())
    machine.sessions = {"9": "sshd"}
    asked = []
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda prompt: asked.append(prompt) or answer)
    machine.setup("--off")
    assert asked == ["End the 1 SSH session(s) open now? [y/N] "]
    assert ("9" not in machine.sessions) == ended


def test_off_does_not_ask_when_no_ssh_session_is_open(machine, monkeypatch):
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda prompt: pytest.fail("asked"))
    machine.sessions = {"2": "greetd"}
    assert machine.setup("--off") == 0


def test_status_says_whether_ssh_is_on_and_how(machine, capsys):
    assert machine.setup("--status") == 0
    assert capsys.readouterr().out.startswith("SSH: off")
    machine.setup("--key", public_key())
    machine.sessions = {"7": "sshd"}
    capsys.readouterr()
    assert machine.setup("--status", "--json") == 0
    state = json.loads(capsys.readouterr().out)
    assert state == {
        "on": True, "enabled": True, "running": True, "socket": False, "dropIn": "present", "passwords": False,
        "firewall": {"zone": "herald-os", "rule": True, "service": False}, "rateLimit": True, "limitRequired": True, "warnings": [], "sessions": 1,
        "user": "me", "keys": 1, "error": None,
    }
    before = len(machine.calls)
    machine.setup("--status")
    out = capsys.readouterr().out
    assert "SSH: on (running)" in out and "keys only" in out and "open (Herald OS's rule)" in out
    assert "rate limit: at most 4 a minute new connections from each address" in out and "sessions: 1 open" in out
    # Status itself changes nothing and needs no root.
    assert machine.calls[before:] and all(looks(argv) and not root for root, argv in machine.calls[before:])


def test_status_says_when_the_firewall_needs_root_to_tell(machine, capsys):
    machine.queries_need_root = True
    machine.setup("--status")
    assert "needs root" in capsys.readouterr().out


# ---------------------------------------------------------------------------------------------
# Arguments, root and the rest of the CLI.
@pytest.mark.parametrize("args", [
    ["--off", "--key", "x"], ["--status", "--passwords"], ["--off", "--status"], ["--json"], ["--key"], ["--bogus"], ["on"],
    ["--end-sessions"], ["--key", "x", "--end-sessions"], ["--off", "--no-firewall"], ["--status", "--end-sessions"], ["--off", "--offline-firewall"],
    ["--key", "x", "--no-firewall", "--offline-firewall"], ["--status", "--status"], ["--off", "--off"], ["--user", "a", "--user", "b", "--status"],
    ["--status", "--user", ""], ["--status", "--user", "root"], ["--status", "--user", "-x"], ["--status", "--user", "a b"],
])
def test_arguments_that_do_not_go_together_are_refused(machine, capsys, args):
    refused(machine, capsys, *args, code=2)
    assert machine.calls == []


def test_another_account_is_only_for_root(machine, capsys):
    assert "only root" in refused(machine, capsys, "--user", "someone", "--key", public_key(), code=2)


@pytest.mark.skipif(os.geteuid() == 0, reason="the account stands in for the tester, who must not be root")
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
    assert machine.on() and machine.limited() and machine.keys_file.read_text() == public_key() + "\n"
    # Every stretch as the account starts with its groups and ids and ends back as root.
    assert seen[:3] == [("groups", []), ("gid", os.getgid()), ("uid", os.getuid())]
    assert seen[3:6] == [("uid", 0), ("gid", 0), ("groups", [0])]


def test_as_root_it_needs_to_be_told_whose_account_and_never_root(machine, monkeypatch, capsys):
    machine.is_root = True
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.delenv("SUDO_USER", raising=False)
    assert "--user <name>" in refused(machine, capsys, "--key", public_key(), code=2)
    assert "root never signs in over SSH" in refused(machine, capsys, "--user", "root", "--key", public_key(), code=2)
    # Off and status need no account.
    assert machine.setup("--off", "--end-sessions") == 0


def test_setup_ssh_is_dispatched_and_its_flags_are_in_the_help(monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(cli, "setup_ssh", lambda args: seen.append(args) or 0)
    assert cli.main(["setup", "ssh", "--status"]) == 0 and seen == [["--status"]]
    for flag in ("--key", "--github", "--keys-file", "--passwords", "--no-firewall", "--offline-firewall", "--user", "--off", "--end-sessions", "--status", "--json"):
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


def refuses_without_keys(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine) == "exit 1" and not machine.on() and machine.changes() == []


def keys_only_never_root(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine, "--key", public_key()) == 0 and machine.drop_in.read_text() == DROP_IN and machine.on()


def overruled_drop_in_stops_it(machine: System, tmp_path: Path, capsys) -> bool:
    machine.main_config("PasswordAuthentication yes")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on() and not machine.drop_in.exists()


def overruled_root_login_stops_it(machine: System, tmp_path: Path, capsys) -> bool:
    machine.main_config("PermitRootLogin yes")
    return outcome(machine, "--passwords") == "exit 1" and not machine.on()


def unseen_match_block_stops_it(machine: System, tmp_path: Path, capsys) -> bool:
    # Only the scan of the files sees it: no probe is alice.
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text("Match User alice\n  PasswordAuthentication yes\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def root_probe_stops_it(machine: System, tmp_path: Path, capsys) -> bool:
    machine.hidden[ROOT_PROBE] = {"permitrootlogin": "yes"}
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def remote_probe_stops_it(machine: System, tmp_path: Path, capsys) -> bool:
    machine.hidden[REMOTE_PROBE] = {"passwordauthentication": "yes"}
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def keys_file_is_private(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    return stat.S_IMODE(machine.ssh.stat().st_mode) == 0o700 and stat.S_IMODE(machine.keys_file.stat().st_mode) == 0o600


def links_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    machine.ssh.symlink_to(elsewhere)
    return outcome(machine, "--key", public_key()) == "exit 1" and not (elsewhere / "authorized_keys").exists()


def bad_keys_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine, "--key", f'command="sh" {public_key()}') == "exit 2" and not machine.ssh.exists()


def mismatched_key_data_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    # ssh-keygen catches it in a given key too; in authorized_keys only this check does.
    machine.ssh.mkdir(mode=0o700)
    machine.keys_file.write_text(public_key(data_kind="ssh-rsa") + "\n")
    return outcome(machine) == "exit 1" and not machine.on()


def short_rsa_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine, "--key", public_key("ssh-rsa", bits=1024)) == "exit 2" and not machine.ssh.exists()


def weak_github_keys_are_skipped(machine: System, tmp_path: Path, capsys) -> bool:
    machine.github["https://github.com/mixed.keys"] = (public_key("ssh-rsa", comment="", bits=1024) + "\n" + public_key(comment="", seed=4) + "\n", 0)
    return outcome(machine, "--github", "mixed") == 0 and "ssh-rsa" not in machine.keys_file.read_text()


def fingerprints_are_shown(machine: System, tmp_path: Path, capsys) -> bool:
    capsys.readouterr()
    outcome(machine, "--key", public_key())
    return "key 256 SHA256:" in capsys.readouterr().out


def github_fetch_is_https_only(machine: System, tmp_path: Path, capsys) -> bool:
    machine.github["https://github.com/octocat.keys"] = (public_key() + "\n", 0)
    outcome(machine, "--github", "octocat")
    curl = next((argv for _, argv in machine.calls if argv[0] == "curl"), [])
    return all(CURL_LIMITS[at] in curl and curl[curl.index(CURL_LIMITS[at]) + 1] == CURL_LIMITS[at + 1] for at in range(0, len(CURL_LIMITS), 2))


def github_page_is_capped(machine: System, tmp_path: Path, capsys) -> bool:
    machine.github["https://github.com/big.keys"] = (public_key() + "\n" + "#" * (1 << 20), 0)
    return outcome(machine, "--github", "big") == "exit 1" and not machine.ssh.exists()


def rate_limited_per_address(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    return machine.limited() and "add @sources4 { ip saddr limit rate over" in (machine.table or "")


def firewall_opened(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    return machine.rules == {"runtime": {RULE}, "permanent": {RULE}}


def refuses_without_firewalld(machine: System, tmp_path: Path, capsys) -> bool:
    machine.firewalld = False
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def warns_without_firewalld(machine: System, tmp_path: Path, capsys) -> bool:
    machine.firewalld = False
    capsys.readouterr()
    outcome(machine, "--key", public_key(), "--no-firewall")
    return "WARNING: firewalld is not running" in capsys.readouterr().err


def off_closes_everything(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    outcome(machine, "--off")
    return (
        machine.units["sshd.service"] == ["disabled", "inactive"] and not machine.drop_in.exists()
        and machine.rules == {"runtime": set(), "permanent": set()} and machine.table is None and not machine.limit_unit.exists()
    )


def off_ends_sessions_when_told(machine: System, tmp_path: Path, capsys) -> bool:
    machine.sessions = {"7": "sshd"}
    outcome(machine, "--off", "--end-sessions")
    return machine.sessions == {}


def off_asks_in_a_terminal(machine: System, tmp_path: Path, capsys) -> bool:
    machine.sessions = {"7": "sshd"}
    original = cli.sys.stdin.isatty
    cli.sys.stdin.isatty = lambda: True
    import builtins
    asked, real_input = [], builtins.input
    builtins.input = lambda prompt: asked.append(prompt) or "y"
    try:
        outcome(machine, "--off")
    finally:
        cli.sys.stdin.isatty = original
        builtins.input = real_input
    return bool(asked) and machine.sessions == {}


def root_only_through_sudo(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine, "--key", public_key()) == 0 and machine.on()


def linked_drop_in(machine: System, tmp_path: Path) -> Path:
    """The drop-in as a link to a file that looks like Herald's, as someone with root might leave it."""
    target = tmp_path / "elsewhere.conf"
    target.write_text(DROP_IN)
    machine.drop_in.symlink_to(target)
    return target


def as_root_without_account(machine: System, monkeypatch) -> None:
    machine.is_root = True
    monkeypatch.setattr(machine.module.os, "geteuid", lambda: 0)
    monkeypatch.delenv("SUDO_USER", raising=False)


def status_sees_a_linked_drop_in(machine: System, tmp_path: Path, capsys) -> bool:
    linked_drop_in(machine, tmp_path)
    capsys.readouterr()
    outcome(machine, "--status", "--json")
    state = json.loads(capsys.readouterr().out)
    return state["dropIn"] == "tampered" and state["passwords"] is None


def reads_do_not_follow_links(machine: System, tmp_path: Path, capsys) -> bool:
    linked_drop_in(machine, tmp_path)
    return machine.module.read_nofollow(machine.drop_in) is None


def on_refuses_a_linked_drop_in(machine: System, tmp_path: Path, capsys) -> bool:
    target = linked_drop_in(machine, tmp_path)
    target.write_text("# someone else's\\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and target.read_text() == "# someone else's\\n" and not machine.on()


def off_removes_a_dangling_link(machine: System, tmp_path: Path, capsys) -> bool:
    machine.drop_in.symlink_to(tmp_path / "gone.conf")
    outcome(machine, "--off")
    return not os.path.lexists(machine.drop_in)


def someone_else_s_ssh_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    machine.ssh.mkdir(mode=0o700)
    machine.account = pwd.struct_passwd(("me", "x", os.getuid() + 4242, os.getgid(), "", str(machine.home), "/bin/bash"))
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.keys_file.exists()


def file_errors_are_said_plainly(machine: System, tmp_path: Path, capsys) -> bool:
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied", str(machine.ssh))
    original = machine.module.tempfile.mkstemp
    machine.module.tempfile.mkstemp = refuse
    try:
        return outcome(machine, "--key", public_key()) == "exit 1"
    finally:
        machine.module.tempfile.mkstemp = original


def json_errors_are_json(machine: System, tmp_path: Path, capsys) -> bool:
    capsys.readouterr()
    result = outcome(machine, "--status", "--json", "--user", "someone-else")
    try:
        state = json.loads(capsys.readouterr().out)
    except ValueError:
        return False
    return result == "exit 2" and "only root" in state["error"]


def offline_rule_is_saved(machine: System, tmp_path: Path, capsys) -> bool:
    machine.firewalld = False
    return outcome(machine, "--key", public_key(), "--offline-firewall") == 0 and machine.rules["permanent"] == {RULE} and machine.limited()


def offline_needs_the_rate_limit(machine: System, tmp_path: Path, capsys) -> bool:
    machine.firewalld = False
    machine.installed.discard("nft")
    return outcome(machine, "--key", public_key(), "--offline-firewall") == "exit 127" and not machine.on()


def skipped_github_lines_are_said(machine: System, tmp_path: Path, capsys) -> bool:
    bad = public_key("ssh-dss", comment="")
    machine.github["https://github.com/octocat.keys"] = (f"{bad}\n{public_key(comment='')}\n", 0)
    capsys.readouterr()
    outcome(machine, "--github", "octocat")
    out = capsys.readouterr().out
    return "line 1: skipping a key of type ssh-dss: not a key type sshd takes" in out and bad.split()[1][:16] not in out


def sshd_waits_for_the_limit_at_boot(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    machine.units["sshd.socket"][0] = "enabled"
    machine.limit_fails = True
    machine.boot()
    return machine.units["sshd.service"][1] != "active" and machine.units["sshd.socket"][1] != "active" and not machine.connect()


def the_socket_waits_for_the_limit_at_boot(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    machine.units["sshd.service"][0] = "disabled"
    machine.units["sshd.socket"][0] = "enabled"
    machine.limit_fails = True
    machine.boot()
    return machine.units["sshd.socket"][1] != "active" and not machine.connect()


def the_requirement_orders_and_requires(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    return all(path.is_file() and path.read_text() == cli.ssh_limit_requirement() for path in machine.required)


def off_removes_the_requirement(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    outcome(machine, "--off")
    return not any(os.path.lexists(path) for path in machine.required)


def include_under_match_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    extra = machine.etc / "extra.conf"
    extra.write_text("PasswordAuthentication yes\n")
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text(f"Match User alice\n  Include {extra}\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def unreadable_files_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    hidden = machine.etc / "sshd_config.d" / "50-hidden.conf"
    hidden.write_text("Match User alice\n  PasswordAuthentication yes\n")
    machine.unreadable.add(hidden)
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def unreadable_main_config_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    machine.unreadable.add(machine.config)
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def unlistable_includes_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    machine.unlistable.add(f"{machine.etc}/sshd_config.d/*.conf")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def includes_are_listed_as_root(machine: System, tmp_path: Path, capsys) -> bool:
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text("Match User alice\n  PasswordAuthentication yes\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and "50-site.conf line 2" in capsys.readouterr().err


def deep_includes_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    # Deeper than this checks, though not too deep for the stand-in sshd, so only this check stops it.
    chain = [machine.etc / f"chain-{level}.conf" for level in range(20)]
    for here, below in zip(chain, chain[1:]):
        here.write_text(f"Include {below}\n")
    chain[-1].write_text("Match User alice\n  PasswordAuthentication yes\n")
    (machine.etc / "sshd_config.d" / "50-chain.conf").write_text(f"Include {chain[0]}\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def off_reloads_systemd(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    machine.calls.clear()
    outcome(machine, "--off")
    changes = machine.changes()
    return ["systemctl", "daemon-reload"] in changes and changes.index(["systemctl", "daemon-reload"]) < changes.index(["systemctl", "disable", "--now", "herald-os-ssh-limit.service"])


WEAK = "Match User alice\n  PasswordAuthentication yes\n"


def include_line_escapes(machine: System, line: str, files: dict[str, str]) -> str:
    """Files under etc, and a line in sshd_config.d that includes them; what turning on says."""
    for name, text in files.items():
        (machine.etc / name).parent.mkdir(parents=True, exist_ok=True)
        (machine.etc / name).write_text(text)
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text(line.replace("@", str(machine.etc)) + "\n")
    return str(outcome(machine, "--key", public_key()))


def equals_includes_are_followed(machine: System, tmp_path: Path, capsys) -> bool:
    return include_line_escapes(machine, "Include=@/weak.conf", {"weak.conf": WEAK}) == "exit 1" and not machine.on()


def every_pattern_is_followed(machine: System, tmp_path: Path, capsys) -> bool:
    return include_line_escapes(machine, "Include @/ok.conf @/weak.conf", {"ok.conf": "X11Forwarding no\n", "weak.conf": WEAK}) == "exit 1"


def relative_includes_are_under_etc_ssh(machine: System, tmp_path: Path, capsys) -> bool:
    return include_line_escapes(machine, "Include site.d/*.conf", {"site.d/weak.conf": WEAK}) == "exit 1"


def quoted_includes_name_something(machine: System, tmp_path: Path, capsys) -> bool:
    return include_line_escapes(machine, 'Include="@/missing.conf"', {}) == "exit 1" and not machine.on()


def unclosed_quotes_in_an_include_are_said(machine: System, tmp_path: Path, capsys) -> bool:
    capsys.readouterr()
    include_line_escapes(machine, 'Include "@/weak.conf', {"weak.conf": WEAK})
    return "never closed" in capsys.readouterr().err and not machine.on()


def unclosed_quotes_anywhere_are_refused(machine: System, tmp_path: Path, capsys) -> bool:
    return include_line_escapes(machine, 'Banner "/etc/issue', {}) == "exit 1" and not machine.on()


def quotes_group_words(machine: System, tmp_path: Path, capsys) -> bool:
    return machine.module.sshd_words('"/etc/ssh/x y.conf" \'/z\'') == ["/etc/ssh/x y.conf", "/z"]


def comments_start_only_a_word(machine: System, tmp_path: Path, capsys) -> bool:
    return machine.module.sshd_words("/etc/ssh/a#b.conf # note") == ["/etc/ssh/a#b.conf"]


def a_rerun_does_not_bounce_sshd(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    outcome(machine, "--key", public_key(seed=2))
    return machine.sshd_bounced == 0 and machine.on() and machine.limited()


def a_failed_limit_is_rolled_back(machine: System, tmp_path: Path, capsys) -> bool:
    machine.limit_fails = True
    outcome(machine, "--key", public_key())
    return not any(os.path.lexists(path) for path in machine.required) and not machine.limit_unit.exists() and not machine.drop_in.exists()


def a_stranded_requirement_is_explained(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    machine.units["herald-os-ssh-limit.service"][1] = "failed"
    capsys.readouterr()
    outcome(machine, "--status", "--json")
    return any("sshd requires the rate limit" in warning for warning in json.loads(capsys.readouterr().out)["warnings"])


def no_limit_is_said_plainly(machine: System, tmp_path: Path, capsys) -> bool:
    machine.firewalld = False
    machine.installed.discard("nft")
    capsys.readouterr()
    outcome(machine, "--key", public_key(), "--no-firewall")
    return capsys.readouterr().err.count("THERE IS NO RATE LIMIT") == 1


def the_two_firewall_flags_exclude_each_other(machine: System, tmp_path: Path, capsys) -> bool:
    return outcome(machine, "--key", public_key(), "--no-firewall", "--offline-firewall") == "exit 2" and machine.calls == []


def json_arguments_are_checked(machine: System, tmp_path: Path, capsys) -> bool:
    # As root, where --user root used to come back as a status with no account and error null.
    machine.is_root = True
    os_module, euid = machine.module.os, machine.module.os.geteuid
    os_module.geteuid = lambda: 0
    capsys.readouterr()
    try:
        result = outcome(machine, "--status", "--json", "--user", "root")
        return result == "exit 2" and json.loads(capsys.readouterr().out)["error"] is not None
    except ValueError:
        return False
    finally:
        os_module.geteuid = euid


def the_github_fetch_is_exactly_this(machine: System, tmp_path: Path, capsys) -> bool:
    machine.github["https://github.com/octocat.keys"] = (public_key() + "\n", 0)
    outcome(machine, "--github", "octocat")
    return [argv for _, argv in machine.calls if argv[0] == "curl"] == [GITHUB_CURL_EXACT + ["https://github.com/octocat.keys"]]


def match_is_found_in_any_case(machine: System, tmp_path: Path, capsys) -> bool:
    return machine.module.match_weakening([("x", "MaTcH User alice\n  PassWordAuthentication YES\n")], passwords=False) == [
        "x line 2: PasswordAuthentication YES under Match User alice"]


def interrupted_after_the_firewall(machine: System, tmp_path: Path, capsys) -> bool:
    """Ctrl+C right after the runtime rule went in, while the saved one is being added."""
    real = machine.firewall
    def interrupt(tool, args, root):
        out = real(tool, args, root)
        if "--permanent" in args and any(arg.startswith("--add-rich-rule") for arg in args):
            raise KeyboardInterrupt
        return out
    machine.firewall = interrupt
    try:
        machine.setup("--key", public_key())
    except (KeyboardInterrupt, SystemExit):
        pass
    else:
        return False
    finally:
        machine.firewall = real
    return machine.rules == {"runtime": set(), "permanent": set()} and not machine.limited() and not machine.drop_in.exists()


def a_live_table_follows_the_restored_file(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    old = machine.table
    (machine.etc / "sshd_config.d" / "20-port.conf").write_text("Port 2222\n")
    real = machine.firewall
    machine.firewall = lambda tool, args, root: ("", 11) if any(arg.startswith("--add-rich-rule") for arg in args) else real(tool, args, root)
    try:
        outcome(machine, "--key", public_key(seed=2))
    finally:
        machine.firewall = real
    return machine.table == old and machine.limit_rules.read_text() == old


def a_tilde_include_is_refused(machine: System, tmp_path: Path, capsys) -> bool:
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text("Include ~/sshd.conf\n")
    return outcome(machine, "--key", public_key()) == "exit 1" and not machine.on()


def second_ctrl_c(machine: System, seen: list) -> None:
    """Ctrl+C once just after the runtime firewall rule goes in, and again while the rollback takes it out."""
    real = machine.firewall

    def interrupt(tool, args, root):
        if any(arg.startswith("--remove-rich-rule") for arg in args):
            seen.append(signal.getsignal(signal.SIGINT))
            os.kill(os.getpid(), signal.SIGINT)
        out = real(tool, args, root)
        if "--permanent" in args and any(arg.startswith("--add-rich-rule") for arg in args):
            raise KeyboardInterrupt
        return out
    machine.firewall = interrupt


def a_second_ctrl_c_does_not_cut_the_rollback_short(machine: System, tmp_path: Path, capsys) -> bool:
    seen: list = []
    second_ctrl_c(machine, seen)
    try:
        machine.setup("--key", public_key())
    except (KeyboardInterrupt, SystemExit):
        pass
    return bool(seen) and machine.rules == {"runtime": set(), "permanent": set()} and not machine.limited()


def every_command_has_a_timeout(machine: System, tmp_path: Path, capsys) -> bool:
    outcome(machine, "--key", public_key())
    outcome(machine, "--status")
    return bool(machine.timeouts) and all(timeout is not None for _, timeout in machine.timeouts)


def a_hang_in_the_rollback_is_passed_over(machine: System, tmp_path: Path, capsys) -> bool:
    module, saved = machine.module, machine.module.SSH_TIMEOUT
    module.SSH_TIMEOUT = 1
    real = machine.firewall

    def refuse_then_hang(tool, args, root):
        if any(arg.startswith("--add-rich-rule") for arg in args):
            machine.hang = [["systemctl", "daemon-reload"]]
            return "", 11
        return real(tool, args, root)
    machine.firewall = refuse_then_hang
    try:
        result = outcome(machine, "--key", public_key())
    finally:
        module.SSH_TIMEOUT, machine.firewall, machine.hang = saved, real, []
    return result == "exit 1" and not machine.drop_in.exists() and not machine.limited() and not any(os.path.lexists(path) for path in machine.required)


def signal_partway(machine: System, signum: int, seen: list | None = None) -> None:
    """The signal arrives while the limit unit is being started and, with `seen`, once more while the
    rollback disables that unit again."""
    real = machine.systemctl

    def systemctl(args, root):
        if args == ["restart", "herald-os-ssh-limit.service"]:
            os.kill(os.getpid(), signum)
        if seen is not None and args == ["disable", "herald-os-ssh-limit.service"]:
            seen.append(signal.getsignal(signum))
            os.kill(os.getpid(), signum)
        return real(args, root)
    machine.systemctl = systemctl


class Unhandled(Exception):
    """A signal the CLI left to whatever handler was there before it."""


def guarded(machine: System, signum: int) -> str:
    """Run `on` with `signum` arriving partway, under a guard handler that the CLI must replace with
    its own: a mutant that does not leaves the guard to raise Unhandled, rather than the signal's
    default action ending the test run."""
    def guard(number, frame):
        raise Unhandled(number)
    previous = signal.signal(signum, guard)
    signal_partway(machine, signum)
    try:
        return str(outcome(machine, "--key", public_key()))
    finally:
        signal.signal(signum, previous)


def sigterm_rolls_back(machine: System, tmp_path: Path, capsys) -> bool:
    result = guarded(machine, signal.SIGTERM)
    return result == "exit 143" and not machine.drop_in.exists() and not any(os.path.lexists(path) for path in machine.required) and not machine.ssh.exists()


def sighup_rolls_back(machine: System, tmp_path: Path, capsys) -> bool:
    result = guarded(machine, signal.SIGHUP)
    return result == "exit 129" and not machine.drop_in.exists()


def handlers_come_back(machine: System, tmp_path: Path, capsys) -> bool:
    before = {signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    outcome(machine, "--key", public_key())
    after = {signum: signal.getsignal(signum) for signum in before}
    for signum, handler in before.items():
        signal.signal(signum, handler)
    return after == before


def keys_never_written_are_not_taken_out(machine: System, tmp_path: Path, capsys) -> bool:
    # Writing into ~/.ssh fails (as for a read-only folder, also when this runs as root).
    machine.ssh.mkdir(mode=0o700)
    machine.keys_file.write_text(public_key(seed=9) + "\n")
    machine.keys_file.chmod(0o600)
    real = machine.module.tempfile.mkstemp

    def refuse(*args, **kwargs):
        if kwargs.get("dir") == machine.ssh:
            raise PermissionError(13, "Permission denied", str(machine.ssh))
        return real(*args, **kwargs)
    machine.module.tempfile.mkstemp = refuse
    capsys.readouterr()
    try:
        outcome(machine, "--key", public_key())
    finally:
        machine.module.tempfile.mkstemp = real
    return "could not take the added keys back out" not in capsys.readouterr().err


def a_hung_start_leaves_sshd_closed(machine: System, tmp_path: Path, capsys) -> bool:
    # The limit is running from an earlier `on`, and sshd was stopped and disabled by hand since: the
    # rollback leaves the limit alone, so nothing but sshd's own stop can close it again.
    outcome(machine, "--key", public_key())
    machine.units["sshd.service"] = ["disabled", "inactive"]
    return a_hung_step_leaves_sshd_closed(machine, ["systemctl", "reload-or-restart", "sshd.service"])


def a_hung_enable_leaves_sshd_closed(machine: System, tmp_path: Path, capsys) -> bool:
    return a_hung_step_leaves_sshd_closed(machine, ["systemctl", "enable", "sshd.service"])


def a_hung_step_leaves_sshd_closed(machine: System, step: list[str]) -> bool:
    module, saved = machine.module, machine.module.SSH_TIMEOUT
    module.SSH_TIMEOUT = 1
    machine.hang_after = [step]
    machine.then_hang = [["systemctl", "is-enabled", "sshd.service"], ["systemctl", "is-active", "sshd.service"]]
    try:
        outcome(machine, "--key", public_key())
    finally:
        module.SSH_TIMEOUT, machine.hang, machine.hang_after = saved, [], []
    return machine.units["sshd.service"] == ["disabled", "inactive"]


def keys_are_taken_out_when_restorecon_hangs(machine: System, tmp_path: Path, capsys) -> bool:
    module, saved = machine.module, machine.module.SSH_TIMEOUT
    module.SSH_TIMEOUT = 1
    machine.hang = [["restorecon", "-R"]]
    try:
        outcome(machine, "--key", public_key())
    finally:
        module.SSH_TIMEOUT, machine.hang = saved, []
    return not machine.keys_file.exists()


def a_late_firewall_add_is_taken_out(machine: System, tmp_path: Path, capsys) -> bool:
    late_firewall_add(machine)
    outcome(machine, "--key", public_key())
    machine.firewall = machine.real_firewall
    return machine.rules == {"runtime": set(), "permanent": set()}


def late_firewall_add(machine: System) -> None:
    """firewall-cmd --permanent --add fails, and a runtime add left behind by a killed command lands
    only while the rollback asks about the saved rule: after it has dealt with the runtime one."""
    real = machine.real_firewall = machine.firewall
    armed, landed = [], []

    def firewall(tool, args, root):
        if "--permanent" in args and any(arg.startswith("--add-rich-rule") for arg in args):
            armed.append(True)
            return "", 11
        if armed and not landed and "--permanent" in args and any(arg.startswith("--query-rich-rule") for arg in args):
            landed.append(True)
            machine.rules["runtime"].add(RULE)
        return real(tool, args, root)
    machine.firewall = firewall


def the_budget_keeps_sshd_closing(machine: System, tmp_path: Path, capsys) -> bool:
    module, saved = machine.module, (machine.module.SSH_TIMEOUT, machine.module.SSH_ROLLBACK_BUDGET)
    module.SSH_TIMEOUT, module.SSH_ROLLBACK_BUDGET = 1, 0
    machine.hang_after = [["systemctl", "reload-or-restart", "sshd.service"]]
    try:
        outcome(machine, "--key", public_key())
    finally:
        (module.SSH_TIMEOUT, module.SSH_ROLLBACK_BUDGET), machine.hang_after = saved, []
    return machine.units["sshd.service"] == ["disabled", "inactive"]


MUTANTS = {
    "no refusal without keys": (refuses_without_keys, 'if not authorized(updated) and not opts["passwords"]:', "if False:"),
    "root logins allowed": (keys_only_never_root, '"PermitRootLogin no\\n"', '"PermitRootLogin yes\\n"'),
    "passwords on by default": (keys_only_never_root, "f\"PasswordAuthentication {'yes' if passwords else 'no'}\\n\"", '"PasswordAuthentication yes\\n"'),
    "keyboard-interactive left on": (keys_only_never_root, '"KbdInteractiveAuthentication no\\n"', '""'),
    "empty passwords left to sshd": (keys_only_never_root, '"PermitEmptyPasswords no\\n"', '""'),
    "sshd's word not checked": (overruled_drop_in_stops_it, 'problems += [f"{problem} {where}" for problem in sshd_overruled(effective.stdout, passwords)]', "problems += []"),
    "root login not checked": (overruled_root_login_stops_it, '{"permitrootlogin": "no", ', "{"),
    "Match blocks not read": (unseen_match_block_stops_it, "    problems, ports = problems + match_weakening(files, passwords), []", "    ports = []"),
    "root not probed": (root_probe_stops_it, '        f"user=root,host=x,addr={SSH_PROBE_ADDRESS}",\n', ""),
    "the account from outside not probed": (remote_probe_stops_it, '        f"user={account.pw_name},host=x,addr={SSH_PROBE_ADDRESS}",\n', ""),
    "authorized_keys left readable": (keys_file_is_private, "keys_file.chmod(0o600)", "keys_file.chmod(0o644)"),
    ".ssh left open": (keys_file_is_private, "folder.chmod(0o700)", "folder.chmod(0o755)"),
    "links followed": (links_are_refused, "if stat.S_ISLNK(info.st_mode):", "if False:"),
    "--key not checked": (bad_keys_are_refused, "        key = ssh_key(text)\n        if not key:", "        key = text\n        if not key:"),
    "key data not checked": (mismatched_key_data_is_refused, "blob[4:4 + size] != fields[0].encode()", "False"),
    "short RSA taken": (short_rsa_is_refused, 'if kind == "RSA" and int(fields[0]) < RSA_MIN_BITS:', "if False:"),
    "weak GitHub keys taken": (weak_github_keys_are_skipped, "            if weakness:\n                bits =", "            if False:\n                bits ="),
    "fingerprints not shown": (fingerprints_are_shown, "        print(f\"    key {listing}: {'adding' if key in added else 'there already'}\")", "        pass"),
    "GitHub over any protocol": (github_fetch_is_https_only, '"--proto", "=https", "--proto-redir", "=https", ', ""),
    "GitHub redirects unbounded": (github_fetch_is_https_only, '"--max-redirs", "3",', ""),
    "GitHub page size unbounded": (github_page_is_capped, "if len(result.stdout.encode()) > GITHUB_MAX_BYTES:", "if False:"),
    "one limit for every address": (rate_limited_per_address, "add @sources4 {{ ip saddr {over} }}", "{over}"),
    "no rate limit": (rate_limited_per_address, "            if nft:\n                ssh_limit_on(ports)", "            if False:\n                ssh_limit_on(ports)"),
    "firewall not opened": (firewall_opened, 'opened = firewall_open() if firewall else firewall_save() if offline else "none running (--no-firewall)"', 'opened = "none"'),
    "no refusal without firewalld": (refuses_without_firewalld, 'if not firewall and not offline and not opts["no_firewall"]:', "if False:"),
    "offline rule not saved": (offline_rule_is_saved, '    root_step(["firewall-offline-cmd", f"--zone={name}", f"--add-rich-rule={SSH_RICH_RULE}"], "Saving SSH\'s firewall rule")\n', ""),
    "offline without the rate limit": (offline_needs_the_rate_limit, "    if (firewall or offline) and not nft:", "    if firewall and not nft:"),
    "skipped GitHub lines not said": (skipped_github_lines_are_said, '            print(f"    {url} line {number}: skipping a key of type {ssh_key_type(line)}: {problem}")', "            pass"),
    "the whole key logged": (skipped_github_lines_are_said, '    return first if re.fullmatch(r"[A-Za-z0-9@._-]{1,48}", first) else "unknown"', "    return text"),
    "no warning without firewalld": (warns_without_firewalld, "def warn(message: str) -> None:\n    print(", "def warn(message: str) -> None:\n    return\n    print("),
    "off keeps the saved rule": (off_closes_everything, '    for permanent in ([], ["--permanent"]) if tool == "firewall-cmd" else ([],):\n        root_step([tool, *permanent, f"--zone={zone}", f"--remove-rich-rule={SSH_RICH_RULE}"]', '    for permanent in ([],):\n        root_step([tool, *permanent, f"--zone={zone}", f"--remove-rich-rule={SSH_RICH_RULE}"]'),
    "off keeps the drop-in": (off_closes_everything, "    if os.path.lexists(SSHD_DROP_IN):\n", "    if False:\n"),
    "off only stops sshd": (off_closes_everything, '["systemctl", "disable", "--now", unit]', '["systemctl", "is-active", unit]'),
    "off keeps the rate limit": (off_closes_everything, "    ssh_limit_off()\n    firewall = firewall_close()", "    firewall = firewall_close()"),
    "off ends no session": (off_ends_sessions_when_told, '        if root_run(["loginctl", "terminate-session", session]).returncode != 0:', "        if False:"),
    "off never asks": (off_asks_in_a_terminal, "    if sessions and not end and sys.stdin.isatty():", "    if False:"),
    "root without sudo": (root_only_through_sudo, '    return ["sudo", *([] if sys.stdin.isatty() else ["-n"]), *argv]', "    return argv"),
    "status follows a linked drop-in": (status_sees_a_linked_drop_in, "    drop_in_state = file_state(SSHD_DROP_IN)\n", '    drop_in_state = "present" if SSHD_DROP_IN.is_file() else "absent"\n'),
    "reads follow links": (reads_do_not_follow_links, "os.O_RDONLY | os.O_NOFOLLOW", "os.O_RDONLY"),
    "on writes through a linked drop-in": (on_refuses_a_linked_drop_in, '        if file_state(path) == "tampered":', "        if False:"),
    "off keeps a dangling linked drop-in": (off_removes_a_dangling_link, "    if os.path.lexists(SSHD_DROP_IN):", "    if SSHD_DROP_IN.exists():"),
    "someone else's .ssh taken": (someone_else_s_ssh_is_refused, "            if info.st_uid != account.pw_uid:", "            if False:"),
    "a traceback for a file error": (file_errors_are_said_plainly, "    except OSError as exc:\n        # Anything", "    except ZeroDivisionError as exc:\n        # Anything"),
    "sshd not tied to the limit": (sshd_waits_for_the_limit_at_boot, "    for path in SSH_LIMIT_REQUIRED:\n        install_file(ssh_limit_requirement(), path)\n", ""),
    "the socket not tied to the limit": (the_socket_waits_for_the_limit_at_boot, '    Path("/etc/systemd/system/sshd.socket.d/10-herald-os-limit.conf"),\n', ""),
    "the requirement only wants the limit": (sshd_waits_for_the_limit_at_boot, '        f"Requires={SSH_LIMIT_UNIT.name}\\n"', '        f"Wants={SSH_LIMIT_UNIT.name}\\n"'),
    "the requirement not ordered after the limit": (the_requirement_orders_and_requires, '        f"After={SSH_LIMIT_UNIT.name}\\n"\n', ""),
    "off does not reload systemd": (off_reloads_systemd, "    if required:\n        root_run([\"systemctl\", \"daemon-reload\"])\n", ""),
    "off keeps the requirement": (off_removes_the_requirement, "    for path in required:\n        root_step([\"rm\", \"-f\", str(path)], f\"Removing {path}\")\n", ""),
    "an Include under Match let through": (include_under_match_is_refused, '            elif match is not None and keyword == "include":', "            elif False:"),
    "an unreadable file skipped": (unreadable_files_are_refused, '        return [], [f"cannot read {path}: {(result.stderr or \'\').strip() or \'exit \' + str(result.returncode)}"]', "        return [], []"),
    "an unreadable sshd_config skipped": (unreadable_main_config_is_refused, "    files, problems = sshd_files()\n", "    files, problems = sshd_files()\n    problems = []\n"),
    "an unlistable Include skipped": (unlistable_includes_are_refused, "            if problem:\n                problems.append(problem)\n            elif", "            if False:\n                pass\n            elif"),
    "Includes listed as the caller": (includes_are_listed_as_root, '    result = root_run(["env", "LC_ALL=C", "sh", "-c", SSHD_GLOB, "sh", full])', '    result = subprocess.run(["env", "LC_ALL=C", "sh", "-c", SSHD_GLOB, "sh", full], capture_output=True, text=True)'),
    "deep Includes cut short": (deep_includes_are_refused, '            problems.append(f"{path}: Includes nest deeper than 16 files")\n            break\n', "            break\n"),
    "Include= not read as an Include": (equals_includes_are_followed, 'SSHD_KEYWORD = re.compile(r"(\\S+?)(\\s*=\\s*|\\s+)(.*)$")', 'SSHD_KEYWORD = re.compile(r"(\\S+?)(\\s+)(.*)$")'),
    "only an Include's first pattern": (every_pattern_is_followed, "        for pattern in args:\n", "        for pattern in args[:1]:\n"),
    "relative Includes from the current folder": (relative_includes_are_under_etc_ssh, '    full = pattern if pattern.startswith("/") else str(SSHD_CONFIG.parent / pattern)', "    full = pattern"),
    "a quoted Include may name nothing": (quoted_includes_name_something, "            elif not names and strict:", "            elif False:"),
    "an unclosed quote in an Include not said": (unclosed_quotes_in_an_include_are_said, '            problems.append(f"{path} line {number}: an Include with a quote that is never closed, which cannot be followed")', "            pass"),
    "an unclosed quote elsewhere let through": (unclosed_quotes_anywhere_are_refused, '                    found.append(f"{name} line {number}: {keyword} has a quote that is never closed, so it cannot be read the way sshd reads it")', "                    pass"),
    "quotes not grouping": (quotes_group_words, """        elif char in "'\\"" and quote in ("", char):""", "        elif False:"),
    "# inside a word a comment": (comments_start_only_a_word, '        elif not quote and char == "#" and not started:', '        elif not quote and char == "#":'),
    "a re-run restarts the limit": (a_rerun_does_not_bounce_sshd, "    if running:\n        # Restarting", "    if False:\n        # Restarting"),
    "a failed limit left in place": (a_failed_limit_is_rolled_back, "        undone = ssh_rollback(before)\n", "        undone = []\n"),
    "a stranded requirement unexplained": (a_stranded_requirement_is_explained, "    if required and limit_active != \"active\":", "    if False:"),
    "no rate limit said softly": (no_limit_is_said_plainly, "def warn(message: str) -> None:\n    print(", "def warn(message: str) -> None:\n    if \"NO RATE LIMIT\" in message:\n        return\n    print("),
    "both firewall flags taken": (the_two_firewall_flags_exclude_each_other, '    if opts["no_firewall"] and opts["offline_firewall"]:', "    if False:"),
    "--user root taken by --status": (json_arguments_are_checked, '                if value == "root":', "                if False:"),
    "a longer GitHub timeout": (the_github_fetch_is_exactly_this, '"--connect-timeout", "10", "--max-time", "20",', '"--connect-timeout", "10", "--max-time", "200",'),
    "match only in lower case": (match_is_found_in_any_case, "        settings.append((number, keyword.lower(),", "        settings.append((number, keyword,"),
    "Ctrl+C skips the rollback": (interrupted_after_the_firewall, "        except BaseException:\n            # Whatever stopped it", "        except SystemExit:\n            # Whatever stopped it"),
    "the live table left as the failed run made it": (a_live_table_follows_the_restored_file, '        attempt([nft, "-f", str(SSH_LIMIT_RULES)], f"the table inet {SSH_LIMIT_TABLE} loaded again from {SSH_LIMIT_RULES}")', "        pass"),
    "an Include starting with ~ followed": (a_tilde_include_is_refused, '            if pattern.startswith("~"):', "            if False:"),
    "a second Ctrl+C cuts the rollback short": (a_second_ctrl_c_does_not_cut_the_rollback_short, "            ignored = ssh_signals({signum: signal.SIG_IGN for signum in (signal.SIGINT, *SSH_STOPS)})", "            ignored = {}"),
    "commands without a timeout": (every_command_has_a_timeout, "    return timeout or SSH_TIMEOUT\n", "    return timeout\n"),
    "a hang stops the rollback": (a_hang_in_the_rollback_is_passed_over, "        except (subprocess.TimeoutExpired, OSError) as exc:\n            why =", "        except ZeroDivisionError as exc:\n            why ="),
    "SIGTERM not handled": (sigterm_rolls_back, "SSH_STOPS = (signal.SIGTERM, signal.SIGHUP)", "SSH_STOPS = (signal.SIGHUP,)"),
    "SIGHUP not handled": (sighup_rolls_back, "SSH_STOPS = (signal.SIGTERM, signal.SIGHUP)", "SSH_STOPS = (signal.SIGTERM,)"),
    "a signal exits with the wrong code": (sigterm_rolls_back, "    raise SystemExit(128 + signum)", "    raise SystemExit(1)"),
    "the handlers not put back": (handlers_come_back, "    finally:\n        ssh_signals(stops)\n", "    finally:\n        pass\n"),
    "keys never written taken out": (keys_never_written_are_not_taken_out, "                if wrote_keys:\n", "                if added:\n"),
    "only an exact active or enabled closed again": (a_hung_start_leaves_sshd_closed, "        if active in SSH_CLOSED_ACTIVE and now_active not in SSH_CLOSED_ACTIVE:\n", "        if active != \"active\" and now_active == \"active\":\n"),
    "a unit's enabled state taken at its word": (a_hung_enable_leaves_sshd_closed, "        if enabled in SSH_CLOSED_ENABLED and now_enabled not in SSH_CLOSED_ENABLED:\n", "        if enabled != \"enabled\" and now_enabled == \"enabled\":\n"),
    "keys marked written only after restorecon": (keys_are_taken_out_when_restorecon_hangs, "            if written is not None:\n                written.append(keys_file)\n", ""),
    "a late firewall add left in place": (a_late_firewall_add_is_taken_out, "    for final in (False, True):\n", "    for final in (False,):\n"),
    "sshd skipped once time runs out": (the_budget_keeps_sshd_closing, "            return last if essential else None\n", "            return None\n"),
    "--json errors in plain text": (json_errors_are_json, '    if "--json" not in args:\n        return setup_ssh_run(args)', "    if True:\n        return setup_ssh_run(args)"),
}


@pytest.mark.parametrize("name", MUTANTS)
def test_each_safety_check_is_caught_when_taken_out(name, tmp_path, monkeypatch, capsys):
    scenario, old, new = MUTANTS[name]
    (tmp_path / "real").mkdir()
    (tmp_path / "mutant").mkdir()
    assert scenario(System(cli, tmp_path / "real", monkeypatch), tmp_path / "real", capsys), "the real CLI fails the scenario"
    assert not scenario(System(mutant(old, new), tmp_path / "mutant", monkeypatch), tmp_path / "mutant", capsys), f"the mutant ({name}) gets past it"



# ---------------------------------------------------------------------------------------------
# QA findings from a live run: a linked drop-in, someone else's ~/.ssh, --json errors.
@pytest.mark.parametrize("as_root", [False, True])
def test_status_reports_a_linked_drop_in_as_tampered_without_reading_it(machine, monkeypatch, tmp_path, capsys, as_root):
    linked_drop_in(machine, tmp_path)
    if as_root:
        as_root_without_account(machine, monkeypatch)
    machine.setup("--status", "--json")
    state = json.loads(capsys.readouterr().out)
    assert state["dropIn"] == "tampered" and state["passwords"] is None and state["error"] is None
    machine.setup("--status")
    out = capsys.readouterr().out
    assert "is a link or not a regular file" in out and "keys only" not in out


def test_status_tells_present_from_absent(machine, capsys):
    machine.setup("--status", "--json")
    assert json.loads(capsys.readouterr().out)["dropIn"] == "absent"
    machine.drop_in.write_text(DROP_IN)
    machine.setup("--status", "--json")
    assert json.loads(capsys.readouterr().out)["dropIn"] == "present"


def test_a_folder_in_place_of_the_drop_in_is_tampered_too(machine, capsys):
    machine.drop_in.mkdir()
    machine.setup("--status", "--json")
    assert json.loads(capsys.readouterr().out)["dropIn"] == "tampered"


def test_files_are_read_without_following_links(tmp_path):
    target = tmp_path / "target"
    target.write_text("secret")
    (tmp_path / "link").symlink_to(target)
    assert cli.read_nofollow(target) == "secret"
    assert cli.read_nofollow(tmp_path / "link") is None
    assert cli.read_nofollow(tmp_path / "missing") is None
    assert cli.read_nofollow(tmp_path) is None
    assert cli.file_state(tmp_path / "link") == "tampered" and cli.file_state(target) == "present"
    assert cli.file_state(tmp_path / "missing") == "absent" and cli.file_state(tmp_path) == "tampered"


@pytest.mark.parametrize("which", ["drop_in", "limit_rules", "limit_unit"])
def test_on_refuses_when_a_file_it_writes_is_a_link_and_writes_nothing_through_it(machine, tmp_path, capsys, which):
    target = tmp_path / "target"
    target.write_text("someone else's\n")
    path = getattr(machine, which)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(target)
    err = refused(machine, capsys, "--key", public_key())
    assert "is a link or not a regular file" in err and "Nothing was changed" in err
    assert target.read_text() == "someone else's\n" and machine.changes() == []


def test_off_removes_links_in_place_of_its_files_even_dangling_ones(machine, tmp_path):
    machine.drop_in.symlink_to(tmp_path / "gone")
    machine.limit_rules.parent.mkdir(parents=True)
    machine.limit_rules.symlink_to(tmp_path / "gone-too")
    machine.setup("--off")
    assert not os.path.lexists(machine.drop_in) and not os.path.lexists(machine.limit_rules)


def test_an_ssh_folder_owned_by_someone_else_is_refused_plainly(machine, capsys):
    # As a root-owned ~/.ssh is: the account is not its owner (made-up uid; chown would need root).
    machine.ssh.mkdir(mode=0o700)
    machine.keys_file.write_text(public_key() + "\n")
    machine.account = pwd.struct_passwd(("me", "x", os.getuid() + 4242, os.getgid(), "", str(machine.home), "/bin/bash"))
    err = refused(machine, capsys, "--key", public_key(seed=2))
    assert f"{machine.ssh} belongs to" in err and "not me" in err and "sudo chown -R me:" in err and "Nothing was changed" in err
    assert "Traceback" not in err and machine.changes() == []


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any folder")
def test_an_ssh_folder_it_cannot_look_into_is_refused_plainly(machine, capsys):
    machine.ssh.mkdir(mode=0o700)
    machine.ssh.chmod(0)
    try:
        err = refused(machine, capsys, "--key", public_key())
    finally:
        machine.ssh.chmod(0o700)
    assert f"cannot look at {machine.keys_file}: Permission denied" in err and "Nothing was changed" in err
    assert machine.changes() == []


def test_a_file_error_nothing_foresaw_is_said_plainly_with_a_non_zero_exit(machine, monkeypatch, capsys):
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Permission denied", str(machine.ssh))
    monkeypatch.setattr(cli.tempfile, "mkstemp", refuse)
    err = refused(machine, capsys, "--key", public_key())
    assert f"setup ssh stopped: Permission denied ({machine.ssh})" in err and "Traceback" not in err


SCHEMA = {"on", "enabled", "running", "socket", "dropIn", "passwords", "firewall", "rateLimit", "limitRequired", "warnings", "sessions", "user", "keys", "error"}


def json_error(machine: System, capsys, *args: str) -> tuple[dict, int]:
    with pytest.raises(SystemExit) as stopped:
        machine.setup(*args)
    captured = capsys.readouterr()
    state = json.loads(captured.out)
    assert set(state) == SCHEMA and captured.err == ""
    assert all(state[key] is None for key in SCHEMA - {"error"})
    return state, stopped.value.code


def test_status_json_for_an_account_that_does_not_exist_is_json_with_an_error(machine, monkeypatch, capsys):
    as_root_without_account(machine, monkeypatch)
    monkeypatch.setattr(cli.pwd, "getpwnam", lambda name: (_ for _ in ()).throw(KeyError(name)))
    state, code = json_error(machine, capsys, "--status", "--json", "--user", "nobody-here")
    assert code == 1 and state["error"] == "there is no account named nobody-here"


@pytest.mark.parametrize("args, code, words", [
    (["--status", "--json", "--user", "someone-else"], 2, "only root"),
    (["--json"], 2, "do not go together"),
    (["--status", "--json", "--bogus"], 2, "unknown argument"),
    (["--status", "--json", "--user"], 2, "--user needs a value"),
    (["--status", "--json", "--user", "root"], 2, "root never signs in over SSH"),
    (["--status", "--json", "--user", ""], 2, "--user '' is not an account name"),
    (["--status", "--json", "--user=", "--status"], 2, "is not an account name"),
    (["--status", "--status", "--json"], 2, "--status given twice"),
    (["--status", "--json", "--json"], 2, "--json given twice"),
])
def test_every_json_error_is_json_with_the_same_keys(machine, capsys, args, code, words):
    state, exit_code = json_error(machine, capsys, *args)
    assert exit_code == code and words in state["error"]


def test_a_file_error_while_reading_the_status_is_json_too(machine, monkeypatch, capsys):
    monkeypatch.setattr(cli, "ssh_state", lambda account: (_ for _ in ()).throw(PermissionError(13, "Permission denied", "/etc/ssh")))
    state, code = json_error(machine, capsys, "--status", "--json")
    assert code == 1 and state["error"].startswith("setup ssh stopped: Permission denied (/etc/ssh)")


def test_status_json_has_the_same_keys_when_it_works(machine, capsys):
    machine.setup("--status", "--json")
    state = json.loads(capsys.readouterr().out)
    assert set(state) == SCHEMA and state["error"] is None and set(cli.SSH_STATE_KEYS) | {"error"} == SCHEMA



# ---------------------------------------------------------------------------------------------
# The first boot (--offline-firewall), and what is said about GitHub lines that are skipped.
def test_the_reasons_a_line_is_not_a_key_and_its_type_never_its_key():
    assert cli.ssh_key_problem(public_key()) is None
    assert cli.ssh_key_problem(public_key("ssh-dss")) == "not a key type sshd takes"
    assert cli.ssh_key_problem("ssh-ed25519") == "not a type and a key"
    assert cli.ssh_key_problem("ssh-ed25519 ***") == "the key is not base64"
    assert cli.ssh_key_problem(public_key(data_kind="ssh-rsa")) == "the key's data is of another type"
    assert cli.ssh_key_problem(f"{public_key()}\n{public_key(seed=2)}") == "more than one line"
    assert cli.ssh_key_type(public_key("ssh-dss")) == "ssh-dss"
    assert cli.ssh_key_type("sk-ssh-ed25519@openssh.com AAAA") == "sk-ssh-ed25519@openssh.com"
    for odd in ("", "   ", "$(reboot) AAAA", "x" * 49 + " AAAA", "type\x1b[31m AAAA"):
        assert cli.ssh_key_type(odd) == "unknown", odd


def test_every_skipped_github_line_is_said_with_its_type_and_reason_and_never_its_key(machine, capsys):
    dss, mismatched, short = public_key("ssh-dss", comment=""), public_key(data_kind="ssh-rsa", comment=""), public_key("ssh-rsa", comment="", bits=1024)
    good = public_key(comment="", seed=7)
    machine.github["https://github.com/octocat.keys"] = (f"{dss}\n\n{mismatched}\nnot-a-key\n{short}\n{good}\n", 0)
    assert machine.setup("--github", "octocat") == 0
    out = capsys.readouterr().out
    url = "https://github.com/octocat.keys"
    assert f"{url} line 1: skipping a key of type ssh-dss: not a key type sshd takes" in out
    assert f"{url} line 3: skipping a key of type ssh-ed25519: the key's data is of another type" in out
    assert f"{url} line 4: skipping a key of type not-a-key: not a type and a key" in out
    assert "skipping a key of type ssh-rsa (1024 bits): an RSA key of 1024 bits is too short" in out
    assert out.count("skipping") == 4
    for key in (dss, mismatched, short, good):
        assert key.split()[1][:16] not in out


def test_the_first_boot_saves_the_rule_offline_when_firewalld_is_not_up_and_limits_before_sshd(machine, capsys):
    machine.firewalld = False
    assert machine.setup("--key", public_key(), "--offline-firewall") == 0
    captured = capsys.readouterr()
    assert machine.rules == {"runtime": set(), "permanent": {RULE}} and machine.limited() and machine.on()
    assert "saved in the firewall zone herald-os for when firewalld starts" in captured.out
    assert "WARNING: firewalld is not running yet" in captured.err and "--no-firewall" not in captured.err
    order = [argv for _, argv in machine.calls if not looks(argv)]
    assert order.index(["systemctl", "restart", "herald-os-ssh-limit.service"]) < order.index(["systemctl", "reload-or-restart", "sshd.service"])


def test_with_firewalld_up_offline_changes_nothing(machine):
    assert machine.setup("--key", public_key(), "--offline-firewall") == 0
    assert machine.rules == {"runtime": {RULE}, "permanent": {RULE}}


def test_offline_without_firewall_offline_cmd_or_nft_leaves_ssh_off(machine, capsys):
    machine.firewalld = False
    machine.installed.discard("firewall-offline-cmd")
    err = refused(machine, capsys, "--key", public_key(), "--offline-firewall")
    assert "firewalld is not running and firewall-offline-cmd is not installed" in err and not machine.on()
    machine.installed.add("firewall-offline-cmd")
    machine.installed.discard("nft")
    assert "rate-limited per address" in refused(machine, capsys, "--key", public_key(), "--offline-firewall", code=127)
    assert not machine.on() and machine.changes() == []


def test_sshd_never_starts_when_the_rate_limit_does_not_load(machine, capsys, monkeypatch):
    machine.firewalld = False
    real = machine.systemctl
    def no_table(args, root):
        out = real(args, root)
        if args[:1] == ["restart"]:
            machine.table = None
        return out
    monkeypatch.setattr(machine, "systemctl", no_table)
    assert "the rate limit did not load" in refused(machine, capsys, "--key", public_key(), "--offline-firewall")
    assert not machine.on()



# ---------------------------------------------------------------------------------------------
# Round 3: sshd needs the rate limit; Includes under Match; sshd's files read as root, failing closed.
def test_sshd_and_its_socket_require_the_limit_and_start_after_it(machine, capsys):
    assert cli.ssh_limit_requirement().splitlines()[2:] == ["[Unit]", "Requires=herald-os-ssh-limit.service", "After=herald-os-ssh-limit.service"]
    machine.setup("--key", public_key())
    assert [path.read_text() for path in machine.required] == [cli.ssh_limit_requirement()] * 2
    assert [path.parent.name for path in machine.required] == ["sshd.service.d", "sshd.socket.d"]
    assert REQUIRED_PATHS == (Path("/etc/systemd/system/sshd.service.d/10-herald-os-limit.conf"),
                              Path("/etc/systemd/system/sshd.socket.d/10-herald-os-limit.conf"))
    assert machine.sshd_needs_the_limit()
    # Written before systemd reloads and before the limit starts.
    changes = machine.changes()
    written = max(next(at for at, argv in enumerate(changes) if argv[0] == "install" and argv[-1] == str(path)) for path in machine.required)
    assert written < changes.index(["systemctl", "daemon-reload"]) < changes.index(["systemctl", "restart", "herald-os-ssh-limit.service"])
    capsys.readouterr()
    machine.setup("--status", "--json")
    assert json.loads(capsys.readouterr().out)["limitRequired"] is True


@pytest.mark.parametrize("enabled", [("sshd.service",), ("sshd.socket",), ("sshd.service", "sshd.socket")])
def test_when_the_limit_fails_at_boot_sshd_stays_stopped_socket_activation_included(machine, enabled):
    machine.setup("--key", public_key())
    for unit in ("sshd.service", "sshd.socket"):
        machine.units[unit][0] = "enabled" if unit in enabled else "disabled"
    machine.limit_fails = True
    machine.boot()
    assert machine.units["herald-os-ssh-limit.service"][1] == "failed" and machine.table is None
    assert machine.units["sshd.service"][1] != "active" and machine.units["sshd.socket"][1] != "active"
    assert not machine.connect()


@pytest.mark.parametrize("enabled", [("sshd.service",), ("sshd.socket",)])
def test_when_the_limit_loads_at_boot_sshd_comes_up_after_it(machine, enabled):
    machine.setup("--key", public_key())
    for unit in ("sshd.service", "sshd.socket"):
        machine.units[unit][0] = "enabled" if unit in enabled else "disabled"
    machine.boot()
    assert machine.limited() and machine.connect() and machine.units["sshd.service"][1] == "active"


def test_when_the_limit_fails_while_turning_on_sshd_is_not_started(machine, capsys):
    machine.limit_fails = True
    assert "Loading the SSH rate limit failed" in refused(machine, capsys, "--key", public_key())
    assert not machine.on()


def test_off_removes_the_requirement_before_stopping_the_limit(machine, tmp_path):
    machine.setup("--key", public_key())
    machine.calls.clear()
    machine.setup("--off")
    assert not any(os.path.lexists(path) for path in machine.required)
    changes = machine.changes()
    removed = max(changes.index(["rm", "-f", str(path)]) for path in machine.required)
    assert removed < changes.index(["systemctl", "daemon-reload"]) < changes.index(["systemctl", "disable", "--now", "herald-os-ssh-limit.service"])
    machine.required[0].symlink_to(tmp_path / "gone")
    machine.setup("--off")
    assert not os.path.lexists(machine.required[0])


def test_without_nft_a_requirement_left_from_before_is_removed_so_sshd_can_start(machine, capsys):
    machine.setup("--key", public_key())
    machine.installed.discard("nft")
    machine.firewalld = False
    assert machine.setup("--key", public_key(), "--no-firewall") == 0
    assert not any(os.path.lexists(path) for path in machine.required) and machine.on()


def test_on_refuses_a_link_in_place_of_the_requirement(machine, tmp_path, capsys):
    machine.required[1].parent.mkdir(parents=True)
    machine.required[1].symlink_to(tmp_path / "elsewhere")
    assert "is a link or not a regular file" in refused(machine, capsys, "--key", public_key())
    assert not (tmp_path / "elsewhere").exists()


def test_an_include_under_a_match_block_is_refused():
    files = [("/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\nMatch User backup\n  Include /etc/ssh/backup.conf\n")]
    assert cli.match_weakening(files, passwords=False) == [
        "/etc/ssh/sshd_config line 3: Include /etc/ssh/backup.conf under Match User backup, which setup ssh does not check (move the Include above the first Match)",
    ]
    assert cli.match_weakening([("x", "Include /a.conf\nMatch all\n  X11Forwarding no\n")], passwords=False) == []


def test_turning_on_with_an_include_under_match_backs_out(machine, capsys):
    extra = machine.etc / "extra.conf"
    extra.write_text("X11Forwarding no\n")
    machine.config.write_text(machine.config.read_text() + f"Match Address 10.0.0.0/8\n  Include {extra}\n")
    err = refused(machine, capsys, "--key", public_key())
    assert f"Include {extra} under Match Address 10.0.0.0/8" in err and "SSH stays as it was" in err
    assert_backed_out(machine)


@pytest.mark.parametrize("which", ["main", "included"])
def test_a_file_root_cannot_read_stops_it(machine, capsys, which):
    path = machine.config if which == "main" else machine.etc / "sshd_config.d" / "50-site.conf"
    path.write_text(path.read_text() if which == "main" else "X11Forwarding no\n")
    machine.unreadable.add(path)
    err = refused(machine, capsys, "--key", public_key())
    assert f"cannot read {path}" in err and "SSH stays as it was" in err
    assert_backed_out(machine)


def test_an_include_root_cannot_list_stops_it(machine, capsys):
    pattern = f"{machine.etc}/sshd_config.d/*.conf"
    machine.unlistable.add(pattern)
    err = refused(machine, capsys, "--key", public_key())
    assert f"cannot list Include {pattern}" in err
    assert_backed_out(machine)


def test_includes_are_listed_as_root_without_the_names_running_anything(machine, tmp_path, capsys):
    odd = ["50 two words.conf", "51-$(touch PWNED).conf", "52-`touch PWNED2`.conf", "53-new\nline.conf", "-54.conf"]
    for name in odd:
        (machine.etc / "sshd_config.d" / name).write_text("X11Forwarding no\n")
    (machine.etc / "sshd_config.d" / "55-$(id).conf").write_text("Match User alice\n  PasswordAuthentication yes\n")
    err = refused(machine, capsys, "--key", public_key())
    assert f"{machine.etc}/sshd_config.d/55-$(id).conf line 2: PasswordAuthentication yes under Match User alice" in err
    assert not list(tmp_path.rglob("PWNED*")) and not list(Path.cwd().glob("PWNED*"))
    listings = [(root, argv) for root, argv in machine.calls if argv[:4] == ["env", "LC_ALL=C", "sh", "-c"]]
    assert listings and all(root and argv[4] == cli.SSHD_GLOB and argv[5] == "sh" for root, argv in listings)
    read = [argv[2] for _, argv in machine.calls if argv[:2] == ["cat", "--"]]
    assert {str(machine.etc / "sshd_config.d" / name) for name in odd} <= set(read)


def test_a_relative_include_is_listed_under_etc_ssh(machine, monkeypatch, capsys):
    machine.config.write_text("Include sshd_config.d/*.conf\n")
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text("Match User alice\n  PermitRootLogin yes\n")
    err = refused(machine, capsys, "--key", public_key())
    assert "50-site.conf line 2: PermitRootLogin yes under Match User alice" in err


def test_includes_that_nest_without_end_are_refused(machine, capsys):
    loop = machine.etc / "sshd_config.d" / "50-loop.conf"
    loop.write_text(f"Include {loop}\n")
    assert "Includes nest deeper than 16 files" in refused(machine, capsys, "--key", public_key())
    assert_backed_out(machine)


def test_the_include_listing_script_expands_globs_and_nothing_else(tmp_path):
    for name in ("a.conf", "b c.conf", "$(touch PWNED).conf"):
        (tmp_path / name).write_text("")
    listed = REAL_RUN(["sh", "-c", cli.SSHD_GLOB, "sh", f"{tmp_path}/*.conf"], capture_output=True, text=True, cwd=tmp_path)
    assert sorted(listed.stdout.split("\0")[:-1]) == sorted(str(tmp_path / name) for name in ("a.conf", "b c.conf", "$(touch PWNED).conf"))
    for pattern in (f"{tmp_path}/none-*.conf", "$(touch PWNED2)", f"{tmp_path}/a.conf; touch PWNED3"):
        assert REAL_RUN(["sh", "-c", cli.SSHD_GLOB, "sh", pattern], capture_output=True, text=True, cwd=tmp_path).stdout == ""
    assert not list(tmp_path.glob("PWNED"))
    assert not (tmp_path / "PWNED2").exists() and not (tmp_path / "PWNED3").exists()



# ---------------------------------------------------------------------------------------------
# Round 4: Include lines are read as sshd reads them.
def test_words_are_split_the_way_sshd_splits_them():
    words = cli.sshd_words
    assert words("/a.conf /b.conf") == ["/a.conf", "/b.conf"]
    assert words('"/x y.conf" /b') == ["/x y.conf", "/b"]
    assert words("'/x y.conf'") == ["/x y.conf"]
    assert words('"it\'s"') == ["it's"] and words("'say \"hi\"'") == ['say "hi"']
    assert words("/a\\ b.conf") == ["/a b.conf"] and words('"a\\"b"') == ['a"b'] and words("a\\nb") == ["a\\nb"]
    assert words("/a#b.conf # a note") == ["/a#b.conf"] and words("#all of it") == [] and words('"#kept"') == ["#kept"]
    assert words("  \t ") == [] and words('""') == [""]
    assert words('"/unclosed') is None and words("'/unclosed") is None and words('"a" "b') is None


def test_settings_are_read_with_any_case_and_either_separator():
    text = (
        "# a comment\n"
        "Include /etc/ssh/a.conf\n"
        "Include=/etc/ssh/b.conf\n"
        "include = /etc/ssh/c.conf\n"
        "  INCLUDE   \"/etc/ssh/d e.conf\"   /etc/ssh/f.conf  # two of them\n"
        "Include sshd_config.d/*.conf\n"
        "Include \"/never/closed\n"
        "Match=User alice\n"
        "Port\n"
    )
    assert cli.sshd_settings(text) == [
        (2, "include", ["/etc/ssh/a.conf"], False),
        (3, "include", ["/etc/ssh/b.conf"], True),
        (4, "include", ["/etc/ssh/c.conf"], True),
        (5, "include", ["/etc/ssh/d e.conf", "/etc/ssh/f.conf"], True),
        (6, "include", ["sshd_config.d/*.conf"], False),
        (7, "include", None, True),
        (8, "match", ["User", "alice"], True),
        (9, "port", [], False),
    ]


def test_match_and_include_are_found_in_every_form():
    files = [("/etc/ssh/x.conf", "match=User alice\n  passwordauthentication = yes\nMATCH Address 10.0.0.0/8\n  include=\"/etc/ssh/y.conf\"\n")]
    assert cli.match_weakening(files, passwords=False) == [
        "/etc/ssh/x.conf line 2: PasswordAuthentication yes under Match User alice",
        "/etc/ssh/x.conf line 4: Include /etc/ssh/y.conf under Match Address 10.0.0.0/8, which setup ssh does not check (move the Include above the first Match)",
    ]
    # A line whose quote is never closed cannot be vouched for; an Include's is sshd_files's to say.
    assert cli.match_weakening([("x", 'Banner "/etc/issue\nInclude "/a\n')], passwords=False) == [
        "x line 1: banner has a quote that is never closed, so it cannot be read the way sshd reads it",
    ]


@pytest.mark.parametrize("line, files, words", [
    ("Include=@/weak.conf", {"weak.conf": WEAK}, "weak.conf line 2"),
    ("include = @/weak.conf", {"weak.conf": WEAK}, "weak.conf line 2"),
    ("INCLUDE\t@/weak.conf", {"weak.conf": WEAK}, "weak.conf line 2"),
    ('Include "@/weak one.conf"', {"weak one.conf": WEAK}, "weak one.conf line 2"),
    ("Include '@/weak one.conf'", {"weak one.conf": WEAK}, "weak one.conf line 2"),
    ('Include @/ok.conf "@/weak two.conf"', {"ok.conf": "X11Forwarding no\n", "weak two.conf": WEAK}, "weak two.conf line 2"),
    ("Include site.d/*.conf", {"site.d/weak.conf": WEAK}, "site.d/weak.conf line 2"),
    ("Include=site.d/weak.conf # the site's own", {"site.d/weak.conf": WEAK}, "site.d/weak.conf line 2"),
])
def test_a_match_block_in_a_file_included_any_way_sshd_accepts_is_found(machine, capsys, line, files, words):
    assert include_line_escapes(machine, line, files) == "exit 1"
    err = capsys.readouterr().err
    assert words in err and "PasswordAuthentication yes under Match User alice" in err
    assert_backed_out(machine)


@pytest.mark.parametrize("line", ['Include="@/missing.conf"', "Include=@/missing.conf", 'Include "@/missing.conf"', "include = @/missing-*.conf"])
def test_an_include_written_with_equals_or_quotes_that_matches_nothing_stops_it(machine, capsys, line):
    assert include_line_escapes(machine, line, {}) == "exit 1"
    assert "matches no file" in capsys.readouterr().err
    assert_backed_out(machine)


def test_a_plain_include_that_matches_nothing_is_fine_as_it_is_for_sshd(machine):
    assert include_line_escapes(machine, "Include @/none-*.conf", {}) == "0"
    assert machine.on()


@pytest.mark.parametrize("line, words", [
    ('Include "@/weak.conf', "an Include with a quote that is never closed"),
    ("Include '@/weak.conf", "an Include with a quote that is never closed"),
    ('Banner "/etc/issue', "banner has a quote that is never closed"),
    ("Include", "an Include that names no file"),
])
def test_a_line_that_cannot_be_read_the_way_sshd_reads_it_stops_it(machine, capsys, line, words):
    assert include_line_escapes(machine, line, {"weak.conf": WEAK}) == "exit 1"
    assert words in capsys.readouterr().err
    assert_backed_out(machine)


def test_quoted_include_names_reach_the_root_side_listing_whole(machine):
    include_line_escapes(machine, 'Include "@/two words.conf" @/plain.conf', {"two words.conf": "X11Forwarding no\n", "plain.conf": "X11Forwarding no\n"})
    listed = [argv[-1] for root, argv in machine.calls if argv[:4] == ["env", "LC_ALL=C", "sh", "-c"]]
    assert f"{machine.etc}/two words.conf" in listed and f"{machine.etc}/plain.conf" in listed
    read = [argv[2] for _, argv in machine.calls if argv[:2] == ["cat", "--"]]
    assert f"{machine.etc}/two words.conf" in read



def test_running_it_again_while_on_swaps_the_table_in_place_and_does_not_restart_sshd(machine):
    machine.setup("--key", public_key())
    assert machine.on() and machine.limited()
    (machine.etc / "sshd_config.d" / "20-port.conf").write_text("Port 2222\n")
    machine.calls.clear()
    assert machine.setup("--key", public_key(seed=2)) == 0
    changes = machine.changes()
    assert ["systemctl", "restart", "herald-os-ssh-limit.service"] not in changes
    assert ["/usr/sbin/nft", "-f", str(machine.limit_rules)] in changes
    assert machine.sshd_bounced == 0 and machine.on() and machine.limited()
    assert "tcp dport { 2222 }" in machine.table
    # sshd itself gets a reload for its own settings, which keeps the sessions it has.
    assert ["systemctl", "reload-or-restart", "sshd.service"] in changes


def test_the_first_time_the_unit_is_started_and_a_stopped_limit_is_started_again(machine):
    machine.setup("--key", public_key())
    assert ["systemctl", "restart", "herald-os-ssh-limit.service"] in machine.changes()
    machine.units["herald-os-ssh-limit.service"][1] = "failed"
    machine.table = None
    machine.calls.clear()
    machine.setup("--key", public_key())
    assert ["systemctl", "restart", "herald-os-ssh-limit.service"] in machine.changes() and machine.limited()


def test_restarting_the_limit_while_sshd_runs_would_bounce_it(machine):
    """The stand-in passes a restart on as Requires= does, so the test above means something."""
    machine.setup("--key", public_key())
    machine.units["sshd.socket"] = ["enabled", "active"]
    assert machine.systemctl(["restart", "herald-os-ssh-limit.service"], True) == ("", 0)
    assert machine.sshd_bounced == 2



# ---------------------------------------------------------------------------------------------
# Round 4 QA: a failed `on` rolls back, no-nft says so plainly, arguments are checked, and the
# mutants that survived (curl timeout, keyword case) are caught.
def snapshot(machine: System) -> tuple:
    files = (machine.drop_in, machine.limit_rules, machine.limit_unit, *machine.required, machine.keys_file)
    return ({str(path): path.read_text() if path.is_file() else None for path in files}, machine.ssh.exists(),
            {unit: list(state) for unit, state in machine.units.items()}, machine.table, {k: set(v) for k, v in machine.rules.items()})


def test_a_limit_that_fails_to_load_takes_back_everything_this_run_did(machine, capsys):
    before = snapshot(machine)
    machine.limit_fails = True
    err = refused(machine, capsys, "--key", public_key())
    assert "Loading the SSH rate limit failed" in err and "SSH is as it was before this run; put back:" in err
    assert snapshot(machine) == before
    machine.setup("--status", "--json")
    state = json.loads(capsys.readouterr().out)
    assert state["limitRequired"] is False and state["enabled"] is False and state["warnings"] == []


def test_a_limit_whose_table_does_not_appear_is_rolled_back_too(machine, capsys, monkeypatch):
    before = snapshot(machine)
    real = machine.systemctl
    def no_table(args, root):
        out = real(args, root)
        if args[:1] == ["restart"]:
            machine.table = None
        return out
    monkeypatch.setattr(machine, "systemctl", no_table)
    assert "the rate limit did not load" in refused(machine, capsys, "--key", public_key())
    assert snapshot(machine) == before


def test_a_failed_rerun_keeps_what_was_working(machine, capsys):
    one = public_key(seed=1)
    machine.setup("--key", one)
    before = snapshot(machine)
    machine.nft_fails = True
    err = refused(machine, capsys, "--key", public_key(seed=2))
    assert "Reloading the SSH rate limit failed" in err
    assert snapshot(machine) == before and machine.on() and machine.limited()
    assert machine.keys_file.read_text() == f"{one}\n"


def test_a_failed_firewall_step_rolls_back_the_limit_and_the_drop_in(machine, capsys, monkeypatch):
    before = snapshot(machine)
    real = machine.firewall
    monkeypatch.setattr(machine, "firewall", lambda tool, args, root: ("", 11) if any(arg.startswith("--add-rich-rule") for arg in args) else real(tool, args, root))
    assert "Opening SSH in the firewall failed" in refused(machine, capsys, "--key", public_key())
    assert snapshot(machine) == before


def test_status_explains_a_requirement_on_a_limit_that_is_not_running(machine, capsys):
    machine.setup("--key", public_key())
    machine.units["herald-os-ssh-limit.service"][1] = "failed"
    machine.units["sshd.service"][1] = "inactive"
    capsys.readouterr()
    machine.setup("--status", "--json")
    state = json.loads(capsys.readouterr().out)
    assert state["limitRequired"] is True and state["rateLimit"] is False
    assert state["warnings"] == ["sshd requires the rate limit (herald-os-ssh-limit.service), which is failed, so sshd cannot start "
                                 "until it loads: herald-os setup ssh loads it again, herald-os setup ssh --off removes SSH's settings"]
    machine.setup("--status")
    assert "WARNING: sshd requires the rate limit" in capsys.readouterr().out


@pytest.mark.parametrize("args", [[], ["--offline-firewall"]])
def test_without_nft_the_default_and_offline_paths_refuse_and_leave_sshd_down(machine, capsys, args):
    machine.installed.discard("nft")
    if args:
        machine.firewalld = False
    assert "cannot be rate-limited per address" in refused(machine, capsys, "--key", public_key(), *args, code=127)
    assert not machine.on() and machine.changes() == []


def test_without_nft_no_firewall_only_with_firewalld_stopped_and_it_says_there_is_no_rate_limit(machine, capsys):
    machine.installed.discard("nft")
    # firewalld running: --no-firewall does not apply, and there is no limit to be had, so it refuses.
    assert "cannot be rate-limited per address" in refused(machine, capsys, "--key", public_key(), "--no-firewall", code=127)
    machine.firewalld = False
    assert machine.setup("--key", public_key(), "--no-firewall") == 0
    captured = capsys.readouterr()
    # Said once, at the end, with the result.
    assert captured.err.count("WARNING: THERE IS NO RATE LIMIT: nft is not installed") == 1
    assert captured.err.rstrip().splitlines()[-1].startswith("herald-os: WARNING: THERE IS NO RATE LIMIT")
    assert "NO RATE LIMIT (nft is not installed)" in captured.out and machine.on() and not machine.limited()
    machine.setup("--status", "--json")
    assert "sshd is running without the per-address rate limit" in json.loads(capsys.readouterr().out)["warnings"]


def test_the_github_fetch_is_this_exact_command(machine):
    assert cli.GITHUB_CURL == GITHUB_CURL_EXACT
    machine.github["https://github.com/octocat.keys"] = (public_key() + "\n", 0)
    machine.setup("--github", "octocat")
    assert [argv for _, argv in machine.calls if argv[0] == "curl"] == [GITHUB_CURL_EXACT + ["https://github.com/octocat.keys"]]


def test_keywords_are_found_in_any_case():
    assert [keyword for _, keyword, _, _ in cli.sshd_settings("match all\nMaTcH User a\nMATCH=Group b\nInClUdE /x\n")] == ["match", "match", "match", "include"]
    files = [("x", "mAtCh User alice\n  PERMITROOTLOGIN yes\nmatch Group ops\n  permitemptypasswords yes\nMATCH Address 10.0.0.0/8\n  iNcLuDe /etc/ssh/y.conf\n")]
    assert cli.match_weakening(files, passwords=False) == [
        "x line 2: PermitRootLogin yes under Match User alice",
        "x line 4: PermitEmptyPasswords yes under Match Group ops",
        "x line 6: Include /etc/ssh/y.conf under Match Address 10.0.0.0/8, which setup ssh does not check (move the Include above the first Match)",
    ]



@pytest.mark.parametrize("args, words", [
    (["--status", "--json", "--user", "root"], "root never signs in over SSH"),
    (["--status", "--json", "--user", ""], "is not an account name"),
    (["--status", "--json", "--status"], "--status given twice"),
])
def test_status_json_as_root_checks_its_arguments_too(machine, monkeypatch, capsys, args, words):
    as_root_without_account(machine, monkeypatch)
    state, code = json_error(machine, capsys, *args)
    assert code == 2 and words in state["error"]



# ---------------------------------------------------------------------------------------------
# Round 5: anything that stops `on` rolls back; a table that was there is loaded again; ~ is refused.
def test_ctrl_c_partway_puts_everything_back_and_exits_130_without_a_traceback(machine, monkeypatch, capsys):
    before = snapshot(machine)
    real = machine.firewall
    def interrupt(tool, args, root):
        out = real(tool, args, root)
        if "--permanent" in args and any(arg.startswith("--add-rich-rule") for arg in args):
            raise KeyboardInterrupt
        return out
    monkeypatch.setattr(machine, "firewall", interrupt)
    err = refused(machine, capsys, "--key", public_key(), code=130)
    assert snapshot(machine) == before
    assert "SSH is as it was before this run; put back:" in err and "the firewall rule in herald-os removed" in err
    assert "Traceback" not in err and "KeyboardInterrupt" not in err
    assert err.rstrip().splitlines()[-1].startswith("herald-os: SSH is as it was before this run")


def test_a_file_error_partway_puts_everything_back_and_is_said_plainly(machine, monkeypatch, capsys):
    before = snapshot(machine)
    real = cli.tempfile.mkstemp
    def refuse(*args, **kwargs):
        if kwargs.get("suffix") == ".service":
            raise PermissionError(13, "Permission denied", "/tmp")
        return real(*args, **kwargs)
    monkeypatch.setattr(cli.tempfile, "mkstemp", refuse)
    err = refused(machine, capsys, "--key", public_key())
    assert "SSH is as it was before this run; put back:" in err and "setup ssh stopped: Permission denied (/tmp)" in err
    assert "Traceback" not in err and snapshot(machine) == before


def test_a_command_that_times_out_partway_puts_everything_back_and_says_so(machine, monkeypatch, capsys):
    before = snapshot(machine)
    real = machine.systemctl
    def slow(args, root):
        if args == ["reload-or-restart", "sshd.service"]:
            raise subprocess.TimeoutExpired(["systemctl", *args], 60)
        return real(args, root)
    monkeypatch.setattr(machine, "systemctl", slow)
    err = refused(machine, capsys, "--key", public_key(), code=124)
    assert "`systemctl reload-or-restart sshd.service` did not finish within 60 s" in err and "Traceback" not in err
    assert snapshot(machine) == before


def test_a_failed_rerun_loads_the_table_that_was_there_again(machine, monkeypatch, capsys):
    machine.setup("--key", public_key())
    old = machine.table
    (machine.etc / "sshd_config.d" / "20-port.conf").write_text("Port 2222\n")
    real = machine.firewall
    # The re-run swaps in a table for port 2222, then the firewall step fails.
    monkeypatch.setattr(machine, "firewall", lambda tool, args, root: ("", 11) if any(arg.startswith("--add-rich-rule") for arg in args) else real(tool, args, root))
    err = refused(machine, capsys, "--key", public_key(seed=2))
    assert machine.table == old and machine.limit_rules.read_text() == old and "tcp dport { 22 }" in machine.table
    assert f"the table inet herald_os_ssh loaded again from {machine.limit_rules}" in err
    reloads = [argv for _, argv in machine.calls if argv[:2] == ["/usr/sbin/nft", "-f"]]
    assert len(reloads) == 2 and machine.on() and machine.limited()


def test_a_rollback_with_no_table_before_does_not_load_one(machine, monkeypatch, capsys):
    real = machine.firewall
    monkeypatch.setattr(machine, "firewall", lambda tool, args, root: ("", 11) if any(arg.startswith("--add-rich-rule") for arg in args) else real(tool, args, root))
    refused(machine, capsys, "--key", public_key())
    assert machine.table is None and not any(argv[:2] == ["/usr/sbin/nft", "-f"] for _, argv in machine.calls)


@pytest.mark.parametrize("line", ["Include ~/sshd.conf", "Include=~root/x.conf", 'Include /etc/ssh/a.conf "~/b.conf"'])
def test_an_include_starting_with_a_tilde_is_refused(machine, capsys, line):
    (machine.etc / "a.conf").write_text("X11Forwarding no\n")
    (machine.etc / "sshd_config.d" / "50-site.conf").write_text(line.replace("/etc/ssh", str(machine.etc)) + "\n")
    err = refused(machine, capsys, "--key", public_key())
    assert "starts with ~, which sshd does not expand in sshd_config" in err
    assert_backed_out(machine)



# ---------------------------------------------------------------------------------------------
# Round 6: a second Ctrl+C while the rollback runs is ignored, and the handler comes back after.
def test_a_second_ctrl_c_during_the_rollback_is_ignored_and_the_handler_comes_back(machine, capsys):
    before, handler, seen = snapshot(machine), signal.getsignal(signal.SIGINT), []
    second_ctrl_c(machine, seen)
    with pytest.raises(SystemExit) as stopped:
        machine.setup("--key", public_key())
    assert stopped.value.code == 130
    # The rollback ran with SIGINT ignored, so the real SIGINT sent in the middle of it changed nothing.
    assert seen and all(state is signal.SIG_IGN for state in seen)
    assert snapshot(machine) == before
    assert signal.getsignal(signal.SIGINT) is handler
    assert "SSH is as it was before this run; put back:" in capsys.readouterr().err


def test_the_handler_comes_back_even_when_the_rollback_itself_fails(machine, monkeypatch, capsys):
    handler = signal.getsignal(signal.SIGINT)
    machine.limit_fails = True
    monkeypatch.setattr(cli, "ssh_rollback", lambda before: (_ for _ in ()).throw(RuntimeError("rollback broke")))
    with pytest.raises(RuntimeError):
        machine.setup("--key", public_key())
    assert signal.getsignal(signal.SIGINT) is handler


def test_a_rollback_outside_the_main_thread_still_runs(machine, capsys):
    import threading
    machine.limit_fails = True
    before, done = snapshot(machine), []

    def run():
        try:
            machine.setup("--key", public_key())
        except SystemExit as stopped:
            done.append(stopped.code)
    thread = threading.Thread(target=run)
    thread.start()
    thread.join()
    assert done == [1] and snapshot(machine) == before



# ---------------------------------------------------------------------------------------------
# Round 7: every command has a timeout, and one that hangs for real triggers the whole rollback.
def test_every_command_setup_ssh_runs_has_a_timeout(machine, capsys):
    machine.github["https://github.com/octocat.keys"] = (public_key(comment="") + "\n", 0)
    machine.setup("--github", "octocat")
    machine.setup("--key", public_key(seed=2))
    machine.setup("--status")
    machine.setup("--status", "--json")
    machine.sessions = {"7": "sshd"}
    machine.setup("--off", "--end-sessions")
    untimed = [argv for argv, timeout in machine.timeouts if timeout is None]
    assert machine.timeouts and untimed == []
    assert all(0 < timeout <= cli.SSH_TIMEOUT for _, timeout in machine.timeouts)
    tools = {Path(argv[0]).name for argv, _ in machine.timeouts}
    assert {"nft", "firewall-cmd", "sshd", "systemctl", "curl", "ssh-keygen", "loginctl", "cat", "env", "install"} <= tools


HANGS = {
    "systemctl restart of the limit": ["systemctl", "restart", "herald-os-ssh-limit.service"],
    "nft listing the table": ["/usr/sbin/nft", "list", "table"],
    "firewall-cmd adding the rule": ["firewall-cmd", "--permanent"],
    "sshd -t": ["/usr/sbin/sshd", "-t"],
    "sshd -T for root": ["/usr/sbin/sshd", "-T", "-C", "user=root,host=x,addr=203.0.113.1"],
    "systemctl starting sshd": ["systemctl", "reload-or-restart", "sshd.service"],
    "cat of an included file": ["cat", "--"],
}


@pytest.mark.parametrize("name", HANGS)
def test_a_command_that_hangs_is_stopped_and_everything_is_put_back(machine, monkeypatch, capsys, name):
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    before = snapshot(machine)
    machine.hang = [HANGS[name]]
    err = refused(machine, capsys, "--key", public_key(), code=124)
    assert "did not finish within 1 s" in err and "Traceback" not in err
    assert snapshot(machine) == before and not machine.on()


def test_a_rerun_whose_nft_reload_hangs_keeps_what_was_working(machine, monkeypatch, capsys):
    machine.setup("--key", public_key())
    before = snapshot(machine)
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    machine.hang = [["/usr/sbin/nft", "-f"]]
    refused(machine, capsys, "--key", public_key(seed=2), code=124)
    machine.hang = []
    assert snapshot(machine) == before and machine.on() and machine.limited()


def test_a_github_fetch_that_hangs_is_stopped_and_nothing_changes(machine, monkeypatch, capsys):
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    machine.hang = [["curl"]]
    assert "curl timed out after 1s" in refused(machine, capsys, "--github", "octocat", code=124)
    assert [argv for _, argv in machine.calls if argv[0] == "curl"] == [GITHUB_CURL_EXACT + ["https://github.com/octocat.keys"]]
    assert machine.changes() == []


def test_a_command_that_hangs_during_the_rollback_is_passed_over(machine, monkeypatch, capsys):
    before = snapshot(machine)
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    real = machine.firewall

    def refuse_then_hang(tool, args, root):
        if any(arg.startswith("--add-rich-rule") for arg in args):
            # From here on (the rollback), daemon-reload hangs; it is reported and the steps after it run.
            machine.hang = [["systemctl", "daemon-reload"]]
            return "", 11
        return real(tool, args, root)
    monkeypatch.setattr(machine, "firewall", refuse_then_hang)
    err = refused(machine, capsys, "--key", public_key())
    assert "`systemctl daemon-reload` did not finish within 1 s while putting things back" in err
    machine.hang = []
    # Only daemon-reload's own effect is missing; every file, unit, table and rule is as it was.
    assert snapshot(machine) == before



# ---------------------------------------------------------------------------------------------
# Round 7: SIGTERM and SIGHUP go through the rollback and exit 143 and 129.
@pytest.mark.parametrize("signum, code", [(signal.SIGTERM, 143), (signal.SIGHUP, 129)])
def test_a_real_signal_partway_puts_everything_back_and_exits_with_its_code(machine, capsys, signum, code):
    before = snapshot(machine)
    handlers = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    seen: list = []
    signal_partway(machine, signum, seen)
    err = refused(machine, capsys, "--key", public_key(), code=code)
    assert f"stopped by {signal.Signals(signum).name}; putting back what this run changed" in err
    assert "SSH is as it was before this run; put back:" in err and "Traceback" not in err
    assert snapshot(machine) == before
    # The same signal sent again during the rollback was ignored, and every handler is back.
    assert seen and all(state is signal.SIG_IGN for state in seen)
    assert {s: signal.getsignal(s) for s in handlers} == handlers


def test_signals_are_handled_only_while_on_changes_things(machine, capsys):
    handlers = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGHUP)}
    seen = {}
    real = machine.systemctl

    def look(args, root):
        if args == ["restart", "herald-os-ssh-limit.service"]:
            seen.update({s: signal.getsignal(s) for s in handlers})
        return real(args, root)
    machine.systemctl = look
    machine.setup("--key", public_key())
    assert all(seen[s] is cli.ssh_stopped for s in handlers)
    assert {s: signal.getsignal(s) for s in handlers} == handlers


DRIVER = """
import json, os, sys
from pathlib import Path
sys.path.insert(0, {tests!r})
import pytest
import test_ssh

machine = test_ssh.System(test_ssh.cli, Path({tmp!r}), pytest.MonkeyPatch())
machine.hang = [["systemctl", "restart", "herald-os-ssh-limit.service"]]
os.environ["HANG_MARK"] = {mark!r}

def state():
    files, ssh, units, table, rules = test_ssh.snapshot(machine)
    return {{"files": files, "ssh": ssh, "units": units, "table": table, "rules": {{k: sorted(v) for k, v in rules.items()}}}}

before = state()
code = 0
try:
    machine.setup("--key", test_ssh.public_key())
except SystemExit as stopped:
    code = stopped.code
print(json.dumps({{"code": code, "same": state() == before}}))
sys.exit(code)
"""


@pytest.mark.parametrize("signum, code", [(signal.SIGTERM, 143), (signal.SIGHUP, 129)])
def test_setup_ssh_killed_while_a_command_hangs_puts_everything_back(tmp_path, signum, code):
    """A separate process runs `on`; while it waits on a command that hangs for real, it gets the signal."""
    import sys
    import time
    mark, work = tmp_path / "hanging", tmp_path / "machine"
    work.mkdir()
    script = tmp_path / "driver.py"
    script.write_text(DRIVER.format(tests=str(Path(__file__).parent), tmp=str(work), mark=str(mark)))
    child = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        for _ in range(200):
            if mark.exists() or child.poll() is not None:
                break
            time.sleep(0.1)
        assert mark.exists(), child.communicate(timeout=10)
        child.send_signal(signum)
        out, err = child.communicate(timeout=30)
    finally:
        if child.poll() is None:
            child.kill()
    assert child.returncode == code, err
    result = json.loads(out.strip().splitlines()[-1])
    assert result == {"code": code, "same": True}, err
    assert f"stopped by {signal.Signals(signum).name}" in err and "SSH is as it was before this run" in err
    assert "Traceback" not in err



@pytest.mark.skipif(os.geteuid() == 0, reason="root writes into a read-only folder")
@pytest.mark.parametrize("existing", [False, True])
def test_keys_that_were_never_written_are_not_reported_as_left_behind(machine, capsys, existing):
    machine.ssh.mkdir(mode=0o700)
    if existing:
        machine.keys_file.write_text(public_key(seed=9) + "\n")
        machine.keys_file.chmod(0o600)
    machine.ssh.chmod(0o500)
    try:
        err = refused(machine, capsys, "--key", public_key())
    finally:
        machine.ssh.chmod(0o700)
    assert "setup ssh stopped: Permission denied" in err and "SSH is as it was before this run" in err
    assert "could not take the added keys back out" not in err and "taken out" not in err
    assert (machine.keys_file.read_text() if existing else machine.keys_file.exists()) == (public_key(seed=9) + "\n" if existing else False)



def test_the_github_fetch_gives_up_after_exactly_20_seconds():
    curl = cli.GITHUB_CURL
    assert curl.count("--max-time") == 1 and curl[curl.index("--max-time") + 1] == "20"
    assert curl.count("--connect-timeout") == 1 and curl[curl.index("--connect-timeout") + 1] == "10"



# ---------------------------------------------------------------------------------------------
# Round 8: the rollback fails closed, whatever systemctl reports or fails to report.
SSHD_QUERIES = [["systemctl", "is-enabled", "sshd.service"], ["systemctl", "is-active", "sshd.service"],
                ["systemctl", "is-enabled", "sshd.socket"], ["systemctl", "is-active", "sshd.socket"]]


@pytest.mark.parametrize("step", [["systemctl", "enable", "sshd.service"], ["systemctl", "reload-or-restart", "sshd.service"]])
def test_a_systemctl_that_hangs_after_acting_leaves_sshd_stopped_and_disabled(machine, monkeypatch, capsys, step):
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    before = snapshot(machine)
    # The step takes effect, then hangs; from then on systemctl cannot say how sshd is either.
    machine.hang_after = [step]
    machine.then_hang = SSHD_QUERIES
    err = refused(machine, capsys, "--key", public_key(), code=124)
    machine.hang, machine.hang_after = [], []
    changes = machine.changes()
    assert ["systemctl", "stop", "sshd.service"] in changes and ["systemctl", "disable", "sshd.service"] in changes
    assert machine.units["sshd.service"] == ["disabled", "inactive"] and machine.units["sshd.socket"] == ["disabled", "inactive"]
    assert snapshot(machine) == before
    assert "SSH is as it was before this run" in err


@pytest.mark.parametrize("state", ["activating", "reloading", "failed", "deactivating", "something-new"])
def test_sshd_left_in_any_state_but_inactive_is_stopped_again(machine, monkeypatch, capsys, state):
    before = snapshot(machine)
    real = machine.systemctl

    def odd(args, root):
        if args == ["reload-or-restart", "sshd.service"]:
            machine.units["sshd.service"][1] = state
            return "", 1
        return real(args, root)
    monkeypatch.setattr(machine, "systemctl", odd)
    refused(machine, capsys, "--key", public_key())
    assert ["systemctl", "stop", "sshd.service"] in machine.changes()
    assert machine.units["sshd.service"][1] in ("inactive",) and machine.units["sshd.service"][0] == "disabled"
    assert snapshot(machine)[0] == before[0]


@pytest.mark.parametrize("state", ["enabled-runtime", "linked", "indirect", "alias", "unknown"])
def test_sshd_left_enabled_in_any_way_is_disabled_again(machine, monkeypatch, capsys, state):
    real = machine.systemctl

    def odd(args, root):
        if args == ["enable", "sshd.service"]:
            machine.units["sshd.service"][0] = state
            return "", 1
        return real(args, root)
    monkeypatch.setattr(machine, "systemctl", odd)
    refused(machine, capsys, "--key", public_key())
    assert ["systemctl", "disable", "sshd.service"] in machine.changes()
    assert machine.units["sshd.service"][0] == "disabled"


def test_a_unit_that_was_on_before_is_left_on(machine, monkeypatch, capsys):
    machine.setup("--key", public_key())
    machine.calls.clear()
    real = machine.firewall
    monkeypatch.setattr(machine, "firewall", lambda tool, args, root: ("", 11) if any(arg.startswith("--add-rich-rule") for arg in args) else real(tool, args, root))
    machine.rules = {"runtime": set(), "permanent": set()}
    refused(machine, capsys, "--key", public_key(seed=2))
    assert ["systemctl", "stop", "sshd.service"] not in machine.changes() and ["systemctl", "disable", "sshd.service"] not in machine.changes()
    assert machine.on()



@pytest.mark.parametrize("existing", [False, True])
def test_keys_are_taken_back_out_when_restorecon_hangs_after_they_were_written(machine, monkeypatch, capsys, existing):
    if existing:
        machine.ssh.mkdir(mode=0o700)
        machine.keys_file.write_text(public_key(seed=9) + "\n")
        machine.keys_file.chmod(0o600)
    before = snapshot(machine)
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    machine.hang = [["restorecon", "-R"]]
    err = refused(machine, capsys, "--key", public_key(), code=124)
    assert "restorecon -R" in err and "the 1 key(s) added to" in err
    assert snapshot(machine) == before



# ---------------------------------------------------------------------------------------------
# Round 8: commands in a process group of their own, sudo first, and a rollback with a time budget.
@pytest.fixture
def quick(monkeypatch):
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    monkeypatch.setattr(cli, "SSH_KILL_GRACE", 1)


def test_a_command_that_times_out_takes_its_whole_group_with_it(tmp_path, quick):
    mark = tmp_path / "late"
    with pytest.raises(subprocess.TimeoutExpired) as stopped:
        cli.ssh_run(["sh", "-c", f"(sleep 2; touch {mark}) & exec sleep 30"])
    assert stopped.value.timeout == 1
    import time
    time.sleep(2.5)
    assert not mark.exists()


def test_a_command_that_times_out_gets_sigterm_first(tmp_path, quick):
    mark = tmp_path / "term"
    with pytest.raises(subprocess.TimeoutExpired):
        cli.ssh_run(["sh", "-c", f"trap 'touch {mark}; exit 0' TERM; while :; do sleep 0.1; done"])
    assert mark.exists()


def test_a_command_that_ignores_sigterm_is_killed_after_the_grace(tmp_path, quick):
    import time
    pid_file = tmp_path / "pid"
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        cli.ssh_run(["sh", "-c", f"trap '' TERM; echo $$ >{pid_file}; while :; do sleep 0.1; done"])
    assert time.monotonic() - started < 6
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_file.read_text()), 0)


def test_commands_keep_the_terminal_s_session_but_have_a_group_of_their_own():
    import sys
    out = cli.ssh_run([sys.executable, "-c", "import os; print(os.getsid(0), os.getpgid(0), os.getpid())"]).stdout.split()
    session, group, pid = map(int, out)
    assert session == os.getsid(0) and group == pid and group != os.getpgid(0)


def test_ssh_run_passes_input_and_returns_output():
    done = cli.ssh_run(["sh", "-c", "cat; echo err >&2; exit 3"], input="hello\n")
    assert (done.returncode, done.stdout, done.stderr) == (3, "hello\n", "err\n")


def test_a_firewall_add_that_lands_late_is_still_taken_out(machine, capsys):
    before = snapshot(machine)
    late_firewall_add(machine)
    err = refused(machine, capsys, "--key", public_key())
    assert "the firewall rule in herald-os removed (it came late)" in err
    machine.firewall = machine.real_firewall
    assert snapshot(machine) == before


def test_a_rule_whose_query_does_not_answer_is_removed_anyway(machine, monkeypatch, capsys):
    real = machine.firewall
    def firewall(tool, args, root):
        if "--permanent" in args and any(arg.startswith("--add-rich-rule") for arg in args):
            return "", 11
        if any(arg.startswith("--query-rich-rule") for arg in args):
            return "", 11
        return real(tool, args, root)
    monkeypatch.setattr(machine, "firewall", firewall)
    refused(machine, capsys, "--key", public_key())
    assert machine.rules["runtime"] == set()


def test_sudo_is_asked_first_untimed_in_a_terminal_and_nothing_changes_when_it_refuses(machine, monkeypatch, capsys):
    machine.setup("--key", public_key())
    first = next(at for at, (_, argv) in enumerate(machine.calls) if not looks(argv) and argv != ["-v"])
    assert machine.calls.index((True, ["-v"])) < first
    machine.calls.clear()
    machine.sudo_lets_in = False
    err = refused(machine, capsys, "--key", public_key(seed=2))
    assert "needs root through sudo" in err and "Nothing was changed" in err
    assert [argv for _, argv in machine.calls if not looks(argv)] == [["-v"]]
    # In a terminal, `sudo -v` asks for the password; that is not timed.
    machine.sudo_lets_in = True
    machine.calls.clear()
    machine.timeouts.clear()
    monkeypatch.setattr(cli.sys.stdin, "isatty", lambda: True)
    machine.setup("--key", public_key(seed=3))
    assert (["-v"], None) in machine.timeouts


def test_as_root_there_is_no_sudo(machine, monkeypatch, tmp_path):
    machine.is_root = True
    monkeypatch.setattr(cli.os, "geteuid", lambda: 0)
    monkeypatch.setattr(cli.pwd, "getpwnam", lambda name: machine.account)
    for name in ("getgroups", "setgroups", "setegid", "seteuid"):
        monkeypatch.setattr(cli.os, name, (lambda *a: [0]) if name == "getgroups" else (lambda *a: None))
    given = tmp_path / "keys"
    given.write_text(public_key() + "\n")
    machine.setup("--user", "me", "--keys-file", str(given))
    assert not any(argv in (["-v"], ["sudo", "-v"]) for _, argv in machine.calls)


def test_the_rollback_keeps_to_its_time_budget_and_still_closes_sshd(machine, monkeypatch, capsys):
    import time
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    monkeypatch.setattr(cli, "SSH_ROLLBACK_BUDGET", 2)
    monkeypatch.setattr(cli, "SSH_ROLLBACK_LAST", 1)
    # sshd starts and systemctl hangs; then every command hangs, save stopping and disabling sshd.
    machine.hang_after = [["systemctl", "reload-or-restart", "sshd.service"]]
    machine.then_hang = [[]]
    real_run = machine.run
    def run(argv, **kwargs):
        stripped = argv[2:] if argv[:2] == ["sudo", "-n"] else argv[1:] if argv[:1] == ["sudo"] else argv
        if stripped in (["systemctl", "stop", "sshd.service"], ["systemctl", "disable", "sshd.service"]):
            saved, machine.hang = machine.hang, []
            try:
                return real_run(argv, **kwargs)
            finally:
                machine.hang = saved
        return real_run(argv, **kwargs)
    monkeypatch.setattr(machine, "run", run)
    started = time.monotonic()
    err = refused(machine, capsys, "--key", public_key(), code=124)
    elapsed = time.monotonic() - started
    machine.hang = []
    assert machine.units["sshd.service"] == ["disabled", "inactive"]
    assert "ran out of time (2 s) putting things back; skipped:" in err
    assert elapsed < 20


def test_once_the_budget_is_gone_stopping_and_disabling_sshd_are_still_tried(machine, monkeypatch, capsys):
    monkeypatch.setattr(cli, "SSH_TIMEOUT", 1)
    monkeypatch.setattr(cli, "SSH_ROLLBACK_BUDGET", 0)
    machine.hang_after = [["systemctl", "reload-or-restart", "sshd.service"]]
    err = refused(machine, capsys, "--key", public_key(), code=124)
    machine.hang_after = []
    changes = machine.changes()
    assert ["systemctl", "stop", "sshd.service"] in changes and ["systemctl", "disable", "sshd.service"] in changes
    assert ["systemctl", "stop", "sshd.socket"] in changes and ["systemctl", "disable", "sshd.socket"] in changes
    assert machine.units["sshd.service"] == ["disabled", "inactive"]
    assert "skipped:" in err and "rm -f" in err
