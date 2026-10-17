"""linux/image/firstboot.sh and Hermes Agent: found in any layout, given its voice extras the way that
layout takes them, and installed once the network is back when the first boot had none. Its
functions run in bash against a home folder in a temporary directory, with stand-ins for git, curl,
sleep, Hermes's installer and the parts of herald-os that change things; the real herald-os finds
Hermes."""

import re

import pytest
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIRSTBOOT = ROOT / "linux" / "image" / "firstboot.sh"
PENDING = "/var/lib/herald-os/hermes-pending"


def functions(*names: str) -> str:
    """The named functions, as firstboot.sh has them."""
    script = FIRSTBOOT.read_text()
    found = []
    for name in names:
        match = re.search(rf"^{name}\(\) \{{ [^\n]*\}}$", script, re.M) or re.search(rf"^{name}\(\) \{{\n.*?^\}}$", script, re.M | re.S)
        assert match, f"firstboot.sh has no {name}()"
        found.append(match.group(0))
    return "\n".join(found) + "\n"


def executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


class Machine:
    """A session user's home, the image's state folder, and a log of what the stand-ins were asked."""

    def __init__(self, tmp_path: Path, offline: int = 0, failed_clones: int = 0):
        self.root = tmp_path
        self.home = tmp_path / "home"
        self.state = tmp_path / "state"
        self.unit = tmp_path / "herald-os-hermes.service"
        self.agent = self.home / ".hermes" / "hermes-agent"
        self.calls = tmp_path / "calls"
        for folder in (self.home, self.state, tmp_path / "bridge"):
            folder.mkdir()
        self.calls.write_text("")
        (tmp_path / "offline").write_text(f"{offline}\n")
        (tmp_path / "failed-clones").write_text(f"{failed_clones}\n")
        bin_dir = tmp_path / "bin"
        # GitHub, answering once the offline count has run down.
        executable(bin_dir / "curl", 'n=$(cat "$WORLD/offline"); [ "$n" -eq 0 ] && exit 0; echo $((n - 1)) >"$WORLD/offline"; exit 6')
        executable(bin_dir / "sleep", 'echo "sleep $1: $(cat "$PENDING" 2>/dev/null || echo no note)" >>"$CALLS"')
        executable(bin_dir / "getent", 'echo "me:x:1000:1000::$HOME_FOR_TEST:/bin/bash"')
        executable(bin_dir / "uv", 'echo "uv $*" >>"$CALLS"')
        # The real herald-os finds Hermes; what it would change is only written down.
        executable(bin_dir / "herald-os", '[ "$1" = hermes-command ] && exec "$PYTHON" "$CLI" "$@"; echo "herald-os $*" >>"$CALLS"')
        # A clone that finishes has a HEAD; the checkout carries today's installer.
        executable(
            bin_dir / "git",
            'echo "git $*" >>"$CALLS"\n'
            'case "$1" in\n'
            '  clone)\n'
            '    n=$(cat "$WORLD/failed-clones"); [ "$n" -gt 0 ] && { echo $((n - 1)) >"$WORLD/failed-clones"; exit 128; }\n'
            '    for target; do :; done\n'
            '    mkdir -p "$target/.git" && : >"$target/.git/HEAD" && cp "$WORLD/setup-hermes.sh" "$target/" ;;\n'
            '  -C) [ -f "$2/.git/HEAD" ] ;;\n'
            "esac",
        )
        # Hermes Agent's setup-hermes.sh today: no venv, the launcher in the checkout's .hermes/bin.
        executable(
            tmp_path / "setup-hermes.sh",
            'echo setup-hermes.sh >>"$CALLS"\n'
            "mkdir -p hermes_cli/subcommands && : >hermes_cli/subcommands/dashboard.py\n"
            "mkdir -p .hermes/bin && printf '#!/bin/sh\\necho \"hermes $*\" >>\"$CALLS\"\\n' >.hermes/bin/hermes && chmod +x .hermes/bin/hermes",
        )
        self.env = {
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "WORLD": str(tmp_path),
            "CALLS": str(self.calls),
            "PENDING": str(self.state / "hermes-pending"),
            "HOME_FOR_TEST": str(self.home),
            "PYTHON": sys.executable,
            "CLI": str(ROOT / "linux" / "bin" / "herald-os"),
            "HOME": str(self.home),
        }

    def checkout(self, executables: list[str]) -> Path:
        """Hermes installed already, by an installer that left these executables in the checkout."""
        (self.agent / "hermes_cli" / "subcommands").mkdir(parents=True)
        (self.agent / "hermes_cli" / "subcommands" / "dashboard.py").write_text("")
        for name in executables:
            executable(self.agent / name, 'echo "hermes $*" >>"$CALLS"')
        return self.agent

    def run(self, call: str) -> subprocess.CompletedProcess:
        quote = shlex.quote
        script = (
            "set -euo pipefail\n"
            f"HERMES_USER=me STATE={quote(str(self.state))} HOME_DIR={quote(str(self.home))}\n"
            f"PENDING={quote(str(self.state / 'hermes-pending'))} HERMES_UNIT={quote(str(self.unit))} BRIDGE={quote(str(self.root / 'bridge'))}\n"
            "OFFLINE_WAIT=0 RETRY_WAIT=0\n"
            + functions("step", "online", "note", "hermes_step", "hermes_later", "hermes_phase")
            # firstboot.sh runs as root and becomes the session user through sudo.
            + 'as_user() { HOME="$HOME_DIR" "$@"; }\n'
            + call
            + "\n"
        )
        return subprocess.run(["bash", "-c", script], env=self.env, capture_output=True, text=True, timeout=60, check=False)

    def log(self) -> str:
        return self.calls.read_text()

    def note(self) -> str | None:
        path = self.state / "hermes-pending"
        return path.read_text() if path.exists() else None


def test_a_fresh_install_in_today_s_layout_gets_the_voice_extras_through_hermes_and_setup(tmp_path):
    machine = Machine(tmp_path)
    result = machine.run("hermes_step")
    assert result.returncode == 0, result.stderr
    log = machine.log()
    assert f"git clone --filter=blob:none https://github.com/NousResearch/hermes-agent {machine.agent}" in log and "setup-hermes.sh" in log
    assert "hermes pm install --extra voice --extra edge-tts --extra wake-openwakeword" in log
    assert "uv pip" not in log and "herald-os setup --yes" in log


def test_an_earlier_installer_s_venv_still_gets_its_voice_extras_through_uv(tmp_path):
    machine = Machine(tmp_path)
    agent = machine.checkout(["venv/bin/python", "venv/bin/hermes"])
    result = machine.run("hermes_step")
    assert result.returncode == 0, result.stderr
    assert f"already installed: {agent}/venv/bin/hermes" in result.stdout
    log = machine.log()
    assert "git clone" not in log and "uv pip install --python venv/bin/python -q -e .[voice,edge-tts,wake-openwakeword]" in log
    assert "herald-os setup --yes" in log


def test_today_s_launcher_wins_over_the_venv_an_update_left_behind(tmp_path):
    machine = Machine(tmp_path)
    machine.checkout(["venv/bin/python", "venv/bin/hermes", ".hermes/bin/hermes"])
    assert machine.run("hermes_step").returncode == 0
    log = machine.log()
    assert "hermes pm install --extra voice" in log and "uv pip" not in log


def test_a_hermes_from_another_installer_is_set_up_and_not_installed_again(tmp_path):
    machine = Machine(tmp_path)
    executable(machine.home / ".local" / "bin" / "hermes", 'echo "hermes $*" >>"$CALLS"')
    result = machine.run("hermes_step")
    assert result.returncode == 0, result.stderr
    assert "came from another installer" in result.stdout and "voice extras failed" not in result.stdout
    log = machine.log()
    assert "git clone" not in log and "pm install" not in log and "uv pip" not in log
    assert "herald-os setup --yes" in log


def test_a_clone_the_network_cut_off_starts_over(tmp_path):
    machine = Machine(tmp_path)
    (machine.agent / ".git").mkdir(parents=True)
    (machine.agent / "half-a-pack").write_text("")
    assert machine.run("hermes_step").returncode == 0
    assert "git clone" in machine.log() and not (machine.agent / "half-a-pack").exists()


def test_offline_the_first_boot_leaves_hermes_to_the_service_and_says_so(tmp_path):
    machine = Machine(tmp_path, offline=99, failed_clones=99)
    machine.unit.write_text("")
    result = machine.run("hermes_step || hermes_later")
    assert result.returncode == 0, result.stderr
    assert machine.note() == "offline\n"
    assert "herald-os-hermes.service installs it once this computer is online, and Herald OS starts it then" in result.stdout
    assert "herald-os setup" not in machine.log()


def test_the_development_vm_has_no_service_so_it_says_how_to_finish(tmp_path):
    machine = Machine(tmp_path, offline=99, failed_clones=99)
    result = machine.run("hermes_step || hermes_later")
    assert result.returncode == 0, result.stderr
    assert machine.note() is None and "hermes as root once this computer is online" in result.stdout


def test_the_service_waits_for_the_network_tries_again_and_clears_the_note(tmp_path):
    machine = Machine(tmp_path, offline=3, failed_clones=1)
    (machine.state / "hermes-pending").write_text("offline\n")
    result = machine.run("hermes_phase")
    assert result.returncode == 0, result.stderr
    assert machine.note() is None
    log = machine.log()
    # It waited for the network saying so, then after the failed install saying it would try again.
    assert log.index("sleep 0: offline") < log.index("git clone") < log.index("sleep 0: retrying")
    assert log.count("git clone") == 2 and log.count("herald-os setup --yes") == 1
    assert "waiting for the network" in result.stdout and "trying again in 0 minutes" in result.stdout


def test_the_note_is_one_path_for_firstboot_the_service_the_cli_and_the_shell():
    unit = (ROOT / "linux" / "image" / "herald-os-hermes.service").read_text()
    script = FIRSTBOOT.read_text()
    assert f"ConditionPathExists={PENDING}" in unit and "ExecStart=/usr/libexec/herald-os/firstboot.sh hermes" in unit
    assert "STATE=/var/lib/herald-os" in script and 'PENDING="$STATE/hermes-pending"' in script
    assert "HERMES_UNIT=/usr/lib/systemd/system/herald-os-hermes.service" in script
    assert f'HERMES_PENDING = Path("{PENDING}")' in (ROOT / "linux" / "bin" / "herald-os").read_text()
    assert f"HERMES_PENDING = '{PENDING}'" in (ROOT / "apps" / "desktop" / "electron" / "backend" / "resolve.ts").read_text()
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    assert "/usr/lib/systemd/system/herald-os-hermes.service" in packages
    assert re.search(r"^  systemctl enable .*herald-os-hermes\.service", packages, re.M)
    assert '"$STATE/hermes-pending"' in (ROOT / "linux" / "image" / "reset-helper").read_text()


# The session account and the login screen: an install from the image, and a system switched to
# Herald OS from another bootc system (Silverblue, Bazzite), which brings accounts of its own. The
# stand-ins rewrite files with awk, not sed -i, which BSD sed reads differently (macOS CI).
SYSTEM_ACCOUNTS = "root:x:0:0:root:/root:/bin/bash\ngreetd:x:976:976::/var/lib/greetd:/sbin/nologin\nnobody:x:65534:65534::/:/sbin/nologin\n"
AUTOLOGIN = (ROOT / "linux" / "session" / "greetd-config.toml").read_text()
LOGIN_SCREEN = (ROOT / "linux" / "session" / "greetd-login.toml").read_text()
NOLOGIN = "/usr/sbin/nologin"
# Field $f of user $u's line in file $file becomes $v.
SET_FIELD = 'awk -F: -v OFS=: -v u="$u" -v f="$f" -v v="$v" \'$1 == u { $f = v } { print }\' "$file" >"$file.new" && mv "$file.new" "$file"'
# User $u joins (or, with del=1, leaves) group $g in $WORLD/group.
MEMBER = (
    'awk -F: -v OFS=: -v u="$u" -v g="$g" -v del="$del" \'$1 == g { n = split($4, m, ","); $4 = ""; '
    'for (i = 1; i <= n; i++) if (m[i] != u && m[i] != "") $4 = $4 (length($4) ? "," : "") m[i]; '
    'if (!del) $4 = $4 (length($4) ? "," : "") u } { print }\' "$WORLD/group" >"$WORLD/group.new" && mv "$WORLD/group.new" "$WORLD/group"'
)


class Accounts:
    """/etc/passwd, /etc/shadow, login.defs, /var/home and greetd's config in a temporary directory, with
    stand-ins for the tools that read and change accounts."""

    def __init__(self, tmp_path: Path, passwd: str = "", shadow: str = "", greetd: str = AUTOLOGIN, homes: dict[str, str] | None = None, remote: str = "", wheel: str = "", files: tuple[str, ...] = ()):
        self.root = tmp_path
        self.passwd = tmp_path / "passwd"
        self.shadow = tmp_path / "shadow"
        self.greetd = tmp_path / "greetd.toml"
        self.state = tmp_path / "state"
        self.homes = tmp_path / "var-home"
        self.calls = tmp_path / "calls"
        for folder in (self.state, self.homes):
            folder.mkdir()
        # A home folder and who owns it, as stat -c %U says.
        for name, owner in (homes or {}).items():
            (self.homes / name).mkdir()
            (self.homes / name / ".owner").write_text(owner)
        # Files in /home, such as systemd-homed's LUKS images (<name>.home).
        for name in files:
            (self.homes / name).write_text("")
        (tmp_path / "group").write_text(f"wheel:x:10:{wheel}\nvideo:x:39:\n")
        self.passwd.write_text(SYSTEM_ACCOUNTS + passwd)
        # Accounts getent finds by name but does not list, and /etc/passwd does not have (SSSD, LDAP).
        (tmp_path / "remote").write_text(remote)
        self.shadow.write_text("".join(f"{line.split(':')[0]}:*:::::::\n" for line in SYSTEM_ACCOUNTS.splitlines()) + shadow)
        self.greetd.write_text(greetd)
        (tmp_path / "login.defs").write_text("UID_MIN                  1000\nUID_MAX                 60000\n")
        self.calls.write_text("")
        bin_dir = tmp_path / "bin"
        executable(
            bin_dir / "getent",
            # getent-fails: listing every account fails (an NSS module that cannot enumerate); lookups work.
            '[ -f "$WORLD/getent-fails" ] && [ "$1" = passwd ] && [ -z "$2" ] && exit 2\n'
            'case "$1" in\n'
            '  passwd) if [ -n "$2" ]; then grep "^$2:" "$WORLD/passwd" || grep "^$2:" "$WORLD/remote"; else cat "$WORLD/passwd"; fi ;;\n'
            '  shadow) grep "^$2:" "$WORLD/shadow" ;;\n'
            '  group) grep "^$2:" "$WORLD/group" ;;\n'
            "esac",
        )
        executable(
            bin_dir / "id",
            'if [ "$1" = -u ]; then line=$(grep "^$2:" "$WORLD/passwd") || exit 1; echo "$line" | cut -d: -f3; else grep -q "^$1:" "$WORLD/passwd"; fi',
        )
        executable(bin_dir / "stat", 'for path; do :; done; cat "$path/.owner"')
        executable(bin_dir / "date", "echo 2026-10-14T08:00:00+00:00")
        executable(bin_dir / "loginctl", 'echo "loginctl $*" >>"$CALLS"')
        executable(bin_dir / "install", 'echo "install $*" >>"$CALLS"; exec /usr/bin/install "$@"')
        # useradd: the next free UID from 1000, and a password no one can sign in with, as shadow-utils does.
        executable(
            bin_dir / "useradd",
            '[ "$1" = -D ] && { echo GROUP=100; echo SHELL=/bin/zsh; exit 0; }\n'
            'echo "useradd $*" >>"$CALLS"; shell=/bin/zsh; for arg; do [ "$prev" = -s ] && shell="$arg"; prev="$arg"; name="$arg"; done\n'
            'uid=$(awk -F: \'$3 >= 1000 && $3 < 60000 && $3 >= n { n = $3 + 1 } END { print n ? n : 1000 }\' n=1000 "$WORLD/passwd")\n'
            'echo "$name:x:$uid:$uid::/home/$name:$shell" >>"$WORLD/passwd"; echo "$name:!:::::::" >>"$WORLD/shadow"\n'
            f'case " $* " in *" -G wheel "*) u="$name" g=wheel del=; {MEMBER} ;; esac',
        )
        # usermod -L (lock: a ! before the hash) and -s (the shell), together or alone; the user comes last.
        executable(
            bin_dir / "usermod",
            'echo "usermod $*" >>"$CALLS"; lock=; shell=; groups=; for arg; do [ "$prev" = -s ] && shell="$arg"; [ "$prev" = -aG ] && groups="$arg"; [ "$arg" = -L ] && lock=1; prev="$arg"; u="$arg"; done\n'
            f'case ",$groups," in *,wheel,*) g=wheel del=; {MEMBER} ;; esac\n'
            f'if [ -n "$lock" ]; then file="$WORLD/shadow" f=2 v="!$(grep "^$u:" "$WORLD/shadow" | cut -d: -f2)"; {SET_FIELD}; fi\n'
            f'if [ -n "$shell" ]; then file="$WORLD/passwd" f=7 v="$shell"; {SET_FIELD}; fi\n'
            "exit 0",
        )
        executable(bin_dir / "gpasswd", f'echo "gpasswd $*" >>"$CALLS"; [ "$1" = -d ] && {{ u="$2" g="$3" del=1; {MEMBER}; }}; exit 0')
        executable(bin_dir / "passwd", f'echo "passwd $*" >>"$CALLS"; if [ "$1" = -d ]; then u="$2" file="$WORLD/shadow" f=2 v=""; {SET_FIELD}; fi; exit 0')
        self.env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "WORLD": str(tmp_path), "CALLS": str(self.calls)}
        # What firstboot.sh reads when getent cannot list the accounts.
        self.passwd_file = self.passwd

    def run(self, call: str, phase: str = "system") -> subprocess.CompletedProcess:
        quote = shlex.quote
        script = (
            "set -euo pipefail\n"
            f"HERMES_USER=hermes STATE={quote(str(self.state))} SWITCHED={quote(str(self.state / 'switched'))}\n"
            f"PHASE={phase} FIRSTBOOT_DONE={quote(str(self.state / 'firstboot-done'))}\n"
            f"LOGIN_SCREEN={quote(str(self.state / 'login-screen'))} PASSWD={quote(str(self.passwd_file))}\n"
            f"IMAGE_INSTALL={quote(str(self.state / 'image-install'))} SAVED_SHELL={quote(str(self.state / 'hermes-shell'))}\n"
            f"ADMIN_PENDING={quote(str(self.state / 'hermes-admin-pending'))}\n"
            f"GREETD={quote(str(self.greetd))} LOGIN_DEFS={quote(str(self.root / 'login.defs'))} SHARE={quote(str(ROOT / 'linux'))}\n"
            f"NOLOGIN={NOLOGIN} HOMES=({quote(str(self.homes))}/*)\n"
            + 'LOGIN_SCREEN_DUE="" SWITCHED_NOW=""\n'
            + functions("earlier_accounts", "switched", "has_password", "sign_in_accounts", "login_screen_due", "session_account", "login_screen", "hermes_admin", "hermes_linger", "login_phase", "greeter")
            + call
            + "\n"
        )
        return subprocess.run(["bash", "-c", script], env=self.env, capture_output=True, text=True, timeout=60, check=False)

    def boot(self, firstboot_done: bool = True) -> subprocess.CompletedProcess:
        """herald-os-login.service: firstboot.sh login, by default once first-boot setup has finished."""
        if firstboot_done:
            (self.state / "firstboot-done").write_text("")
        result = self.run("login_phase", phase="login")
        assert result.returncode == 0, result.stderr
        return result

    def field(self, file: Path, user: str, index: int) -> str:
        return next(line.split(":")[index] for line in file.read_text().splitlines() if line.startswith(f"{user}:"))

    def password(self, user: str) -> str:
        return self.field(self.shadow, user, 1)

    def shell(self, user: str) -> str:
        return self.field(self.passwd, user, 6)

    def switched(self) -> bool:
        return (self.state / "switched").exists()

    def in_wheel(self, user: str = "hermes") -> bool:
        line = next(line for line in (self.root / "group").read_text().splitlines() if line.startswith("wheel:"))
        return user in line.split(":")[3].split(",")

    def set_password(self, user: str, hash_: str = "$y$theirs") -> None:
        """passwd as the user (the shell's setup) or sudo passwd: a hash in place of what was there."""
        lines = [f"{user}:{hash_}:" + line.split(":", 2)[2] if line.startswith(f"{user}:") else line for line in self.shadow.read_text().splitlines()]
        self.shadow.write_text("\n".join(lines) + "\n")

    def login_screen(self) -> bool:
        """What the shell's setup reads: the account signed in at a login screen."""
        return (self.state / "login-screen").exists()


def first_boot(accounts: Accounts) -> subprocess.CompletedProcess:
    """What system_phase does about the account and greetd."""
    result = accounts.run("session_account\ngreeter\nif switched; then hermes_admin; hermes_linger; fi")
    assert result.returncode == 0, result.stderr
    return result


def reset(accounts: Accounts) -> None:
    """reset-helper apply: the session user's account goes; the state folder's markers stay."""
    for file in (accounts.passwd, accounts.shadow):
        file.write_text("".join(line + "\n" for line in file.read_text().splitlines() if not line.startswith("hermes:")))


def assert_never_in_wheel(accounts: Accounts) -> None:
    """hermes was made outside wheel, so nothing had to take it out."""
    made = [line for line in accounts.calls.read_text().splitlines() if line.startswith("useradd ") and line.endswith(" hermes")]
    assert made and all("wheel" not in line for line in made), made
    assert "gpasswd -d hermes wheel" not in accounts.calls.read_text()


def assert_switched_and_closed(accounts: Accounts) -> None:
    """A login screen, and a session user no one can sign in to, which is no administrator."""
    assert accounts.switched() and accounts.login_screen()
    assert not accounts.in_wheel()
    assert accounts.password("hermes").startswith("!") and accounts.shell("hermes") == NOLOGIN
    assert accounts.greetd.read_text() == LOGIN_SCREEN


def test_an_install_from_the_image_signs_its_new_account_in_and_setup_asks_for_a_password(tmp_path):
    accounts = Accounts(tmp_path)
    first_boot(accounts)
    assert "useradd -m -G wheel hermes" in accounts.calls.read_text() and accounts.in_wheel()
    assert accounts.password("hermes") == "" and accounts.shell("hermes") == "/bin/zsh"
    assert not accounts.switched() and not accounts.login_screen()
    assert accounts.greetd.read_text() == AUTOLOGIN
    # The boot unit, which runs on every boot, changes nothing on such a system.
    (accounts.homes / "hermes").mkdir()
    (accounts.homes / "hermes" / ".owner").write_text("hermes")
    accounts.boot()
    assert accounts.greetd.read_text() == AUTOLOGIN and accounts.password("hermes") == ""


def test_a_switched_system_gets_a_locked_hermes_outside_wheel_with_no_shell_and_a_login_screen(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n", homes={"me": "me"})
    result = first_boot(accounts)
    assert "switched from another system, which has these accounts:" in result.stdout and " me " in result.stdout
    assert "passwd -d" not in accounts.calls.read_text()
    assert_switched_and_closed(accounts)
    assert_never_in_wheel(accounts)
    assert accounts.password("me") == "$y$secret" and accounts.shell("me") == "/bin/bash"
    assert 'command = "herald-os-compositor"' not in accounts.greetd.read_text()


def test_a_systemd_homed_account_makes_it_a_switched_system(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:60200:60200:Me:/home/me:/bin/bash\n")
    first_boot(accounts)
    assert_switched_and_closed(accounts)


def test_a_home_folder_of_an_account_getent_does_not_list_makes_it_a_switched_system(tmp_path):
    # SSSD and LDAP accounts are not enumerated, but they have a home folder.
    accounts = Accounts(tmp_path, homes={"me@corp.example": "me@corp.example"}, remote="me@corp.example:*:1234567:1234567::/home/me@corp.example:/bin/bash\n")
    result = first_boot(accounts)
    assert "var-home/me@corp.example (me@corp.example)" in result.stdout
    assert_switched_and_closed(accounts)


def test_an_account_list_that_cannot_be_read_counts_as_switched_but_keeps_setup_s_password_prompt(tmp_path):
    # In doubt it is switched, but with no account known to sign in a login screen would lock everyone out.
    accounts = Accounts(tmp_path)
    (tmp_path / "getent-fails").write_text("")
    result = accounts.run("session_account\ngreeter")
    assert result.returncode == 0, result.stderr
    assert "the account list could not be read" in result.stdout and "WARNING: switched from another system, but none of its accounts can sign in" in result.stdout
    assert accounts.switched() and not accounts.login_screen()
    assert accounts.password("hermes") == "" and accounts.greetd.read_text() == AUTOLOGIN
    assert not accounts.in_wheel()


def test_the_session_user_s_own_home_and_lost_and_found_are_not_another_account(tmp_path):
    # hermes's folder even when userdel -r could not remove it (its owner is gone), and ext4's lost+found.
    accounts = Accounts(tmp_path, homes={"hermes": "1000", "lost+found": "root"})
    first_boot(accounts)
    assert not accounts.switched() and accounts.password("hermes") == ""


def test_a_system_switched_by_an_earlier_image_is_put_right_at_the_next_boot(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:$y$secret:::::::\nhermes::::::::\n",
        wheel="me,hermes",
    )
    result = accounts.boot()
    assert_switched_and_closed(accounts)
    assert "locked until someone gives it one (sudo passwd hermes)" in result.stdout
    # Lock first, then greetd's config.
    log = accounts.calls.read_text()
    assert log.index(f"usermod -L -s {NOLOGIN} hermes") < log.index("greetd-login.toml")


def test_a_session_user_given_a_password_gets_its_shell_back(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n")
    first_boot(accounts)
    assert accounts.shell("hermes") == NOLOGIN
    # sudo passwd hermes, then the next boot.
    shadow = accounts.shadow.read_text().replace("hermes:!!", "hermes:$y$theirs").replace("hermes:!", "hermes:$y$theirs")
    accounts.shadow.write_text(shadow)
    result = accounts.boot()
    # The shell useradd would have given it, saved when it was locked.
    assert accounts.shell("hermes") == "/bin/zsh" and accounts.password("hermes") == "$y$theirs"
    assert "has a password now, and its shell back (/bin/zsh)" in result.stdout
    assert "loginctl enable-linger hermes" in accounts.calls.read_text()
    assert accounts.in_wheel() and "joins wheel" in result.stdout
    assert not (accounts.state / "hermes-shell").exists()
    assert accounts.greetd.read_text() == LOGIN_SCREEN


def test_a_session_user_that_has_a_password_keeps_it_and_meets_the_login_screen(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:$y$secret:::::::\nhermes:$y$theirs:::::::\n",
        wheel="hermes",
    )
    accounts.boot()
    assert accounts.password("hermes") == "$y$theirs" and accounts.shell("hermes") == "/bin/bash"
    assert "usermod" not in accounts.calls.read_text() and "gpasswd" not in accounts.calls.read_text()
    assert accounts.in_wheel()
    assert accounts.greetd.read_text() == LOGIN_SCREEN


def test_any_other_greetd_config_on_a_switched_system_becomes_the_login_screen(tmp_path):
    # An autologin with another command line, or into another account, is replaced; the login screen stays.
    edited = AUTOLOGIN.replace('command = "herald-os-compositor"', 'command = "env FOO=1 herald-os-compositor"')
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n", greetd=edited)
    accounts.boot()
    assert accounts.greetd.read_text() == LOGIN_SCREEN
    accounts.boot()
    assert accounts.greetd.read_text() == LOGIN_SCREEN and "greetd shows a login screen" not in accounts.boot().stdout


def test_an_account_added_after_an_image_install_does_not_make_it_a_switched_system(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="hermes:x:1000:1000::/var/home/hermes:/bin/bash\nfriend:x:1001:1001::/var/home/friend:/bin/bash\n",
        shadow="hermes::::::::\nfriend:$y$friend:::::::\n",
    )
    accounts.boot()
    assert not accounts.switched() and accounts.greetd.read_text() == AUTOLOGIN


def test_accounts_outside_the_ranges_people_sign_in_with_are_not_people(tmp_path):
    accounts = Accounts(tmp_path, passwd="container:x:70000:70000::/:/sbin/nologin\ndynamic:x:61200:61200::/:/sbin/nologin\n")
    first_boot(accounts)
    assert not accounts.switched() and accounts.password("hermes") == ""


def test_a_reset_on_a_switched_system_makes_the_account_locked_again(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n")
    (accounts.state / "switched").write_text("2026-10-14T08:00:00+00:00\n")
    first_boot(accounts)
    assert_switched_and_closed(accounts)


def test_the_login_screen_is_greetd_s_own_and_greetd_waits_for_it_on_the_image():
    assert 'command = "agreety --cmd herald-os-compositor"' in LOGIN_SCREEN and 'user = "greetd"' in LOGIN_SCREEN
    assert "agreety" not in AUTOLOGIN
    unit = (ROOT / "linux" / "image" / "herald-os-login.service").read_text()
    assert "ExecStart=/usr/libexec/herald-os/firstboot.sh login" in unit and "RemainAfterExit=yes" in unit
    assert "After=herald-os-reset.service herald-os-firstboot.service" in unit and "Before=greetd.service" in unit
    # It runs on the first boot too, after first-boot setup, whether or not that finished.
    assert "ConditionPathExists" not in unit
    dropin = (ROOT / "linux" / "image" / "greetd-herald-os-login.conf").read_text()
    assert "Requires=herald-os-login.service" in dropin and "After=herald-os-login.service" in dropin
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    image = packages[packages.index('if [[ "$MODE" == "--image" ]]; then') :]
    assert "/usr/lib/systemd/system/herald-os-login.service" in image
    assert '"$LINUX/image/greetd-herald-os-login.conf" /usr/lib/systemd/system/greetd.service.d/herald-os-login.conf' in image
    assert packages.count("greetd-herald-os-login.conf") == 1
    assert re.search(r"^  systemctl enable .*herald-os-login\.service", packages, re.M)
    script = FIRSTBOOT.read_text()
    assert 'SWITCHED="$STATE/switched"' in script and 'LOGIN_SCREEN="$STATE/login-screen"' in script and "PASSWD=/etc/passwd" in script
    assert "  login) login_phase ;;" in script
    assert '"$SHARE/session/greetd-login.toml"' in script
    assert "HOMES=(/var/home/* /home/*)" in script and "NOLOGIN=/usr/sbin/nologin" in script
    assert "LOGIN_SCREEN = '/var/lib/herald-os/login-screen'" in (ROOT / "apps" / "desktop" / "electron" / "ipc" / "setup.ts").read_text()


def fallback(accounts: Accounts) -> subprocess.CompletedProcess:
    """A switched system none of whose accounts can sign in: as from the image, with a warning."""
    result = first_boot(accounts)
    assert "WARNING: switched from another system, but none of its accounts can sign in" in result.stdout
    assert accounts.switched() and not accounts.login_screen()
    assert accounts.password("hermes") == "" and accounts.shell("hermes") == "/bin/zsh"
    assert accounts.greetd.read_text() == AUTOLOGIN
    assert "disable-linger" not in accounts.calls.read_text()
    # Never a passwordless administrator on a switched system, not even for a moment.
    assert not accounts.in_wheel() and (accounts.state / "hermes-admin-pending").exists()
    assert_never_in_wheel(accounts)
    return result


def test_a_switched_system_whose_only_account_has_no_shell_keeps_setup_s_password_prompt(tmp_path):
    accounts = Accounts(tmp_path, passwd=f"svc:x:1000:1000::/var/home/svc:{NOLOGIN}\n", shadow="svc:$y$secret:::::::\n", homes={"svc": "svc"})
    fallback(accounts)


def test_a_switched_system_whose_only_account_has_no_usable_password_keeps_setup_s_password_prompt(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="locked:x:1000:1000::/var/home/locked:/bin/bash\nempty:x:1001:1001::/var/home/empty:/bin/bash\nnever:x:1002:1002::/var/home/never:/bin/bash\n",
        shadow="locked:!$y$old:::::::\nempty::::::::\nnever:*:::::::\n",
    )
    fallback(accounts)
    # Later boots warn again and change nothing.
    result = accounts.boot()
    assert "WARNING" in result.stdout and accounts.greetd.read_text() == AUTOLOGIN and accounts.password("hermes") == ""


def test_a_home_folder_whose_owner_no_one_can_resolve_counts_as_someone_who_can_sign_in(tmp_path):
    # A UID nothing resolves now: SSSD or LDAP offline, or an account gone. Fail closed.
    accounts = Accounts(tmp_path, homes={"gone": "1234"})
    result = first_boot(accounts)
    assert "an owner that cannot be looked up" in result.stdout
    assert_switched_and_closed(accounts)
    assert_never_in_wheel(accounts)


def test_a_switched_system_whose_account_gets_a_password_later_gets_the_login_screen_at_the_next_boot(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:!:::::::\n")
    fallback(accounts)
    accounts.shadow.write_text(accounts.shadow.read_text().replace("me:!:", "me:$y$secret:"))
    accounts.boot()
    assert_switched_and_closed(accounts)


def test_a_login_screen_stays_even_when_its_last_account_goes(tmp_path):
    # Never back to a passwordless administrator that signs in by itself: rescue.target is the way out.
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n")
    first_boot(accounts)
    assert_switched_and_closed(accounts)
    accounts.passwd.write_text(SYSTEM_ACCOUNTS + "".join(line + "\n" for line in accounts.passwd.read_text().splitlines() if line.startswith("hermes:")))
    accounts.boot()
    assert_switched_and_closed(accounts)


def test_a_text_console_is_there_when_greetd_is_not():
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    assert re.search(r"^systemctl enable .*getty@tty2\.service", packages, re.M)


def test_a_locked_session_user_has_no_user_manager_until_it_has_a_password(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n")
    first_boot(accounts)
    assert "loginctl disable-linger hermes" in accounts.calls.read_text()
    accounts.calls.write_text("")
    accounts.boot()
    assert "loginctl disable-linger hermes" in accounts.calls.read_text()


def test_a_session_user_locked_by_the_repair_gets_its_own_shell_back(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/usr/bin/fish\n",
        shadow="me:$y$secret:::::::\nhermes::::::::\n",
    )
    accounts.boot()
    assert accounts.shell("hermes") == NOLOGIN and (accounts.state / "hermes-shell").read_text().strip() == "/usr/bin/fish"
    # A second boot before the password does not save nologin over it.
    accounts.boot()
    assert (accounts.state / "hermes-shell").read_text().strip() == "/usr/bin/fish"
    accounts.shadow.write_text(accounts.shadow.read_text().replace("hermes:!:", "hermes:$y$theirs:"))
    accounts.boot()
    assert accounts.shell("hermes") == "/usr/bin/fish"


def test_a_reset_after_adding_an_account_to_an_image_install_keeps_it_one(tmp_path):
    accounts = Accounts(tmp_path)
    first_boot(accounts)
    assert (accounts.state / "image-install").exists()
    # Someone adds an account with a password and a home, then runs herald-os reset.
    accounts.passwd.write_text(accounts.passwd.read_text() + "friend:x:1001:1001::/var/home/friend:/bin/bash\n")
    accounts.shadow.write_text(accounts.shadow.read_text() + "friend:$y$friend:::::::\n")
    (accounts.homes / "friend").mkdir()
    (accounts.homes / "friend" / ".owner").write_text("friend")
    reset(accounts)
    accounts.calls.write_text("")
    result = first_boot(accounts)
    assert "switched" not in result.stdout and "WARNING" not in result.stdout
    assert not accounts.switched() and not accounts.login_screen()
    assert accounts.password("hermes") == "" and accounts.greetd.read_text() == AUTOLOGIN
    assert "disable-linger" not in accounts.calls.read_text() and accounts.in_wheel()


def test_a_stray_folder_in_home_is_no_one_s_account(tmp_path):
    # A folder root (or another system account) owns, like one left by a script or an image.
    accounts = Accounts(tmp_path, homes={"backup": "root", "share": "greetd"})
    result = first_boot(accounts)
    assert "WARNING" not in result.stdout
    assert not accounts.switched() and not accounts.login_screen()
    assert accounts.password("hermes") == "" and accounts.greetd.read_text() == AUTOLOGIN
    # Nor at a later boot.
    accounts.boot()
    assert not accounts.switched() and accounts.greetd.read_text() == AUTOLOGIN


def test_a_stray_folder_on_a_switched_system_does_not_stand_in_for_an_account_that_can_sign_in(tmp_path):
    accounts = Accounts(tmp_path, passwd=f"svc:x:1000:1000::/var/home/svc:{NOLOGIN}\n", homes={"backup": "root", "svc": "svc"})
    fallback(accounts)


def image_packages() -> list[str]:
    """packages.txt as packages.sh reads it: one package per line, # comments and blank lines dropped."""
    lines = (ROOT / "linux" / "image" / "packages.txt").read_text().splitlines()
    return [line.split("#", 1)[0].strip() for line in lines if line.split("#", 1)[0].strip()]


def test_the_image_packages_are_one_per_line():
    assert all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", package) for package in image_packages())


def test_the_image_has_cmp():
    packages = image_packages()
    assert "diffutils" in packages
    assert "cmp -s" in FIRSTBOOT.read_text()


def test_the_image_has_intel_wi_fi_firmware_and_exfat():
    # Fedora ships Intel CNVi firmware apart from linux-firmware; without it most laptops have no Wi-Fi,
    # and first boot needs the network for Hermes.
    packages = image_packages()
    assert "iwlwifi-mvm-firmware" in packages and "NetworkManager-wifi" in packages
    assert "exfatprogs" in packages


def test_the_image_names_the_firmware_linux_firmware_only_recommends():
    # packages.sh installs without weak dependencies, and Fedora's linux-firmware only recommends the
    # Wi-Fi, GPU and audio firmware: each must be listed, or laptops lose Wi-Fi and sound.
    packages = image_packages()
    for firmware in ("linux-firmware", "atheros-firmware", "brcmfmac-firmware", "mt7xxx-firmware", "realtek-firmware",
                     "amd-gpu-firmware", "intel-gpu-firmware", "nvidia-gpu-firmware", "intel-audio-firmware"):
        assert firmware in packages, firmware
    assert "--setopt=install_weak_deps=False" in (ROOT / "linux" / "image" / "packages.sh").read_text()


def test_the_image_has_sound_open_firmware_and_its_profiles():
    # Most Intel laptops since 2019 have no speakers or built-in microphone without SOF and UCM.
    packages = image_packages()
    assert "alsa-sof-firmware" in packages and "alsa-ucm" in packages


def test_the_image_lists_the_system_voice_the_shell_falls_back_to():
    # ffmpeg-free (and the omakase apps' WebKitGTK) pull flite in today; the voice must not depend on that.
    assert "flite" in image_packages()
    assert "command: 'flite'" in (ROOT / "apps" / "desktop" / "electron" / "platform" / "system-voice.ts").read_text()


DOWNLOAD = r"\b(?:curl|wget)\b"
SHELL = r"(?:/\S*/)?(?:(?:busybox\s+)?(?:ba|z|da|k)?sh|python(?:3(?:\.\d+)?)?|perl|ruby|node)\b"
SUDO = r"(?:sudo\b(?:\s+-\S+)*\s+)?(?:env\b(?:\s+\S+=\S*)*\s+)?"
# A download piped into a shell or interpreter: curl ... | sh, wget -qO- ... | sudo -E bash, ... | python3 -,
# ... | xargs bash -c.
PIPED_TO_SHELL = re.compile(rf"{DOWNLOAD}[^\n]*(?<!\|)\|(?!\|)\s*{SUDO}(?:xargs\b[^\n|]*?\s+{SUDO})?{SHELL}")
# A shell, interpreter, eval or source reading a download: bash <(curl ...), sh -c "$(wget ...)", . <(curl ...).
SHELL_READS_DOWNLOAD = re.compile(rf"(?:\b{SHELL}|\beval\b|\bsource\b|(?:^|[\s;&|(])\.\s)[^\n]*?(?:<\(|\$\(|`)\s*{SUDO}{DOWNLOAD}", re.M)


def runs_a_download(script: str) -> bool:
    # A line at a time, with backslash-continued lines joined first. Not caught: a download run through
    # a variable (x=$(curl ...); bash -c "$x") or saved to a file and run (curl ... > /tmp/i.sh && bash
    # /tmp/i.sh). The URL check catches those only when the URL is written out literally.
    script = re.sub(r"\\\n", " ", script)
    return bool(PIPED_TO_SHELL.search(script) or SHELL_READS_DOWNLOAD.search(script))


@pytest.mark.parametrize("line", [
    "curl -fsSL https://bun.sh/install | bash",
    "curl -fsSL https://example.com/x.sh | sh",
    "curl -s https://example.com/x.sh | sudo bash",
    "curl -s https://example.com/x.sh | sudo -E bash",
    "curl -s https://example.com/x.sh | sudo -E env FOO=1 bash -s -- --yes",
    "curl -s https://example.com/x.sh | /bin/bash",
    "curl -s https://example.com/x.sh | tee /tmp/x.sh | zsh",
    "wget -qO- https://example.com/x.sh | sh",
    "wget -O - https://example.com/x.sh | sudo -E bash",
    "bash <(curl -fsSL https://example.com/x.sh)",
    'bash <(curl -fsSL "$U")',
    "bash <(curl -fsSL ${URL})",
    'bash < <(curl -fsSL "$U")',
    'curl -fsSL "$U" | bash',
    'sh -c "$(curl -fsSL "$U")"',
    "sudo -E bash <(wget -qO- https://example.com/x.sh)",
    'sh -c "$(curl -fsSL https://example.com/x.sh)"',
    'bash -c "$(wget -qO- https://example.com/x.sh)"',
    "sh -c \"`curl -fsSL https://example.com/x.sh`\"",
    'eval "$(curl -fsSL https://example.com/env)"',
    "source <(curl -fsSL https://example.com/env)",
    ". <(wget -qO- https://example.com/env)",
    "  as_user bash -c 'bash <(curl -fsSL https://example.com/x.sh)'",
    "curl -fsSL https://example.com/x.sh \\\n  | bash",
    "curl -fsSL \\\n  https://example.com/x.sh \\\n  | sudo -E bash -s",
    "bash <(curl \\\n  -fsSL https://example.com/x.sh)",
    'sh -c "$(curl -fsSL \\\n  "$U")"',
    'curl -fsSL "$U" \\\n| bash',
    'curl -fsSL \\\n"$U" | sh',
    'bash <(\\\ncurl -s "$U")',
    'curl -fsSL "$U" | xargs bash -c',
    "curl -fsSL \"$U\" | xargs -0 -I{} sh -c '{}'",
    'wget -qO- "$U" | sudo xargs -n 1 bash -c',
    "curl -fsSL https://example.com/x.py | python3 -",
    "curl -fsSL https://example.com/x.py | python",
    "curl -fsSL https://example.com/x.py | /usr/bin/python3.12",
    "wget -qO- https://example.com/x.py | sudo python3",
    'python3 -c "$(curl -fsSL "$U")"',
    "python3 <(curl -fsSL https://example.com/x.py)",
    "curl -fsSL https://example.com/x.pl | perl",
    'perl -e "$(wget -qO- "$U")"',
    "curl -fsSL https://example.com/x.rb | ruby",
    'ruby -e "$(curl -fsSL https://example.com/install)"',
    "curl -fsSL https://example.com/x.js | node",
    'node -e "$(curl -fsSL "$U")"',
    "wget -qO- https://example.com/x.sh | busybox sh",
    "busybox sh <(curl -fsSL https://example.com/x.sh)",
    'busybox sh -c "$(wget -qO- "$U")"',
])
def test_a_download_run_by_a_shell_is_caught(line):
    assert runs_a_download(line)


@pytest.mark.parametrize("line", [
    "curl -fsI --connect-timeout 10 -o /dev/null https://github.com/NousResearch/hermes-agent",
    "curl -fsSL -o /tmp/x.tar.gz https://example.com/x.tar.gz && sha256sum -c sums",
    "printf 'n\\nn\\n' | bash ./setup-hermes.sh",
    "bash ./setup.sh",
    'version="$(curl -fsS https://example.com/version)"',
    "wget -q https://example.com/x.tar.gz",
    "curl -fsI https://example.com || bash ./offline.sh",
    "curl -fsSL -o /tmp/x.tar.gz \\\n  https://example.com/x.tar.gz",
    "python3 -c 'import sys; print(sys.version)'",
    "node --version && npm --version",
    'curl -fsSL "$U" | xargs -n 1 echo',
])
def test_a_download_that_no_shell_runs_is_not_caught(line):
    assert not runs_a_download(line)


def fetches_more_than_hermes_agent(script: str) -> bool:
    urls = set(re.findall(r"https?://[^\s'\";)]+", script))
    return urls != {"https://github.com/NousResearch/hermes-agent"} or runs_a_download(script)


def test_first_boot_fetches_hermes_agent_and_nothing_else():
    # Third-party code is never fetched and run by default at first boot: no other sources, and no
    # installer from the network handed to a shell.
    assert not fetches_more_than_hermes_agent(FIRSTBOOT.read_text())


@pytest.mark.parametrize("line", [
    'bash <(curl -fsSL "$U")',
    "  as_user bash -c 'bash <(curl -fsSL \"$U\")' || true",
    'curl -fsSL "$U" | sudo -E bash',
])
def test_a_download_from_a_variable_added_to_first_boot_is_caught(line):
    # The URL is in a variable, so only the shell patterns can see it.
    assert fetches_more_than_hermes_agent(FIRSTBOOT.read_text() + f'U="$1"\n{line}\n')


def test_a_switched_system_where_no_one_can_sign_in_never_has_a_passwordless_hermes_in_wheel(tmp_path):
    # Key-only, smartcard or fingerprint accounts: a locked password, so no login screen for them.
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nkeys:x:1001:1001::/var/home/keys:/bin/bash\n",
        shadow="me:!$y$fingerprint:::::::\nkeys:*:::::::\n",
        wheel="me",
    )
    fallback(accounts)
    for _ in range(2):
        accounts.boot()
        assert accounts.password("hermes") == "" and not accounts.in_wheel()
    assert accounts.greetd.read_text() == AUTOLOGIN
    # The shell's setup sets the password; at the next start hermes is an administrator.
    accounts.set_password("hermes")
    result = accounts.boot()
    assert accounts.in_wheel() and "has a password now, and joins wheel" in result.stdout
    assert not (accounts.state / "hermes-admin-pending").exists()
    assert "loginctl enable-linger hermes" in accounts.calls.read_text()


def test_an_earlier_image_s_passwordless_hermes_leaves_wheel_where_no_one_can_sign_in(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:!:::::::\nhermes::::::::\n",
        wheel="hermes",
    )
    result = accounts.boot()
    assert "gpasswd -d hermes wheel" in accounts.calls.read_text() and "out of wheel until it has one" in result.stdout
    assert not accounts.in_wheel() and accounts.password("hermes") == "" and accounts.greetd.read_text() == AUTOLOGIN


def test_a_hermes_someone_took_out_of_wheel_stays_out(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:$y$secret:::::::\nhermes:$y$theirs:::::::\n",
    )
    accounts.boot()
    assert not accounts.in_wheel() and "usermod -aG wheel" not in accounts.calls.read_text()


def test_a_systemd_homed_luks_image_in_home_is_an_account_that_can_sign_in(tmp_path):
    accounts = Accounts(tmp_path, files=("me.home",))
    result = first_boot(accounts)
    assert "me.home (systemd-homed)" in result.stdout and "the login screen is for: me" in result.stdout
    assert_switched_and_closed(accounts)


def test_folders_of_accounts_newer_than_hermes_are_not_from_before_herald_os(tmp_path):
    # An image install from before first boots wrote down what they found, with an account added since.
    accounts = Accounts(
        tmp_path,
        passwd="hermes:x:1000:1000::/var/home/hermes:/bin/bash\nfriend:x:1001:1001::/var/home/friend:/bin/bash\n",
        shadow="hermes:$y$theirs:::::::\nfriend:$y$friend:::::::\n",
        homes={"hermes": "hermes", "friend": "friend"},
        wheel="hermes",
    )
    accounts.boot()
    assert not accounts.switched() and (accounts.state / "image-install").exists()
    assert accounts.greetd.read_text() == AUTOLOGIN and accounts.in_wheel()


def test_a_session_user_with_a_password_keeps_its_user_manager_whatever_its_shell(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd=f"me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:{NOLOGIN}\n",
        shadow="me:$y$secret:::::::\nhermes:$y$theirs:::::::\n",
    )
    (accounts.state / "login-screen").write_text("")
    accounts.boot()
    assert "loginctl enable-linger hermes" in accounts.calls.read_text() and "disable-linger" not in accounts.calls.read_text()


def test_first_boot_and_the_login_check_wait_for_homed_userdbd_and_sssd():
    for unit in ("herald-os-firstboot.service", "herald-os-login.service"):
        text = (ROOT / "linux" / "image" / unit).read_text()
        wants = next(line for line in text.splitlines() if line.startswith("Wants="))
        after = next(line for line in text.splitlines() if line.startswith("After="))
        for service in ("systemd-homed.service", "systemd-userdbd.service", "sssd.service"):
            assert service in wants and service in after, (unit, service)


def test_sssd_offline_at_first_boot_its_users_home_folder_still_means_a_login_screen(tmp_path):
    # stat -c %U says UNKNOWN when the owner's UID resolves to no name.
    accounts = Accounts(tmp_path, homes={"carol": "UNKNOWN"})
    result = first_boot(accounts)
    assert "carol (an owner that cannot be looked up)" in result.stdout
    assert_switched_and_closed(accounts)
    assert_never_in_wheel(accounts)


def test_an_account_list_getent_cannot_give_is_read_from_etc_passwd(tmp_path):
    accounts = Accounts(tmp_path, passwd="alice:x:1000:1000::/var/home/alice:/bin/bash\n", shadow="alice:$y$secret:::::::\n")
    (tmp_path / "getent-fails").write_text("")
    result = first_boot(accounts)
    assert "the login screen is for: alice" in result.stdout
    assert_switched_and_closed(accounts)


def test_an_account_list_no_one_can_read_means_a_login_screen(tmp_path):
    accounts = Accounts(tmp_path, passwd="alice:x:1000:1000::/var/home/alice:/bin/bash\n", shadow="alice:$y$secret:::::::\n")
    (tmp_path / "getent-fails").write_text("")
    accounts.passwd_file = tmp_path / "unreadable"
    result = first_boot(accounts)
    assert "the login screen is for: (the account list could not be read)" in result.stdout
    assert_switched_and_closed(accounts)


def test_the_login_check_before_first_boot_finished_writes_down_no_verdict(tmp_path):
    # First-boot setup failed, or the accounts' services were not up: nothing seen yet.
    accounts = Accounts(tmp_path)
    result = accounts.boot(firstboot_done=False)
    assert "not writing down whether this system was switched yet" in result.stdout
    assert not (accounts.state / "image-install").exists() and not accounts.switched()
    # Later the owner's account is there (systemd-homed is up), and first boot finishes.
    accounts.passwd.write_text(accounts.passwd.read_text() + "me:x:60100:60100::/home/me:/bin/bash\n")
    accounts.boot()
    assert accounts.switched() and not (accounts.state / "image-install").exists()
    assert accounts.login_screen() and accounts.greetd.read_text() == LOGIN_SCREEN


def test_the_login_check_before_first_boot_finished_still_acts_on_what_it_sees(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:$y$secret:::::::\nhermes::::::::\n",
        wheel="hermes",
    )
    accounts.boot(firstboot_done=False)
    assert not accounts.switched() and accounts.login_screen()
    assert accounts.password("hermes").startswith("!") and not accounts.in_wheel()


def test_first_boot_writes_down_its_verdict(tmp_path):
    accounts = Accounts(tmp_path)
    first_boot(accounts)
    assert (accounts.state / "image-install").exists() and not (accounts.state / "firstboot-done").exists()


SWITCHED_MACHINES_NO_ONE_SEEMS_TO_SIGN_IN_ON = {
    "key-only accounts": dict(passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:!:::::::\n"),
    "a shell-less account": dict(passwd=f"svc:x:1000:1000::/var/home/svc:{NOLOGIN}\n", shadow="svc:$y$s:::::::\n"),
    "a homed account not up yet": dict(homes={}, passwd="ghost:x:1000:1000::/var/home/ghost:/bin/bash\n", shadow="ghost:*:::::::\n"),
    "an earlier image's hermes": dict(
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:!:::::::\nhermes::::::::\n",
        wheel="me,hermes",
    ),
}


@pytest.mark.parametrize("machine", SWITCHED_MACHINES_NO_ONE_SEEMS_TO_SIGN_IN_ON)
def test_a_wrong_no_one_can_sign_in_never_leaves_a_passwordless_hermes_in_wheel(tmp_path, machine):
    accounts = Accounts(tmp_path, **SWITCHED_MACHINES_NO_ONE_SEEMS_TO_SIGN_IN_ON[machine])
    if "hermes:" not in accounts.passwd.read_text():
        first_boot(accounts)
        assert not (accounts.password("hermes") == "" and accounts.in_wheel())
        assert_never_in_wheel(accounts)
    for _ in range(2):
        accounts.boot()
        assert not (accounts.password("hermes") == "" and accounts.in_wheel())
    (tmp_path / "getent-fails").write_text("")
    accounts.boot()
    assert not (accounts.password("hermes") == "" and accounts.in_wheel())


def test_greetd_s_config_is_replaced_through_a_rename():
    script = FIRSTBOOT.read_text()
    assert 'install -m 0644 "$SHARE/session/greetd-login.toml" "$GREETD.herald-os-new"' in script
    assert 'mv -f "$GREETD.herald-os-new" "$GREETD"' in script


# An unattended install's choices (linux/image/unattended.ks writes them): the session user's name,
# and SSH for the public keys it gave. Each check also has a mutant, firstboot.sh with that check
# taken out, which its scenario must catch.
USER_LINE = re.search(r'^HERMES_USER="\$\{HERMES_USER:-.*$', FIRSTBOOT.read_text(), re.M).group(0)


def function_in(script: str, name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}$", script, re.M | re.S)
    assert match, f"firstboot.sh has no {name}()"
    return match.group(0) + "\n"


def session_user(tmp_path: Path, conf: str | None = None, accounts: str = "", env_user: str | None = None, script: str | None = None) -> tuple[str, str]:
    """The session user firstboot.sh picks, and what it said about it."""
    bin_dir = tmp_path / "bin"
    executable(bin_dir / "id", 'while read -r name uid; do [ "$2" = "$name" ] && { echo "$uid"; exit 0; }; done <"$WORLD/accounts"; exit 1')
    (tmp_path / "accounts").write_text(accounts)
    defs, install = tmp_path / "login.defs", tmp_path / "install.conf"
    defs.write_text("UID_MIN 1000\nUID_MAX 60000\n")
    if conf is not None:
        install.write_text(conf)
    body = (
        "set -euo pipefail\n"
        f"INSTALL_CONF={shlex.quote(str(install))} LOGIN_DEFS={shlex.quote(str(defs))}\n"
        + function_in(script or FIRSTBOOT.read_text(), "configured_user")
        + USER_LINE
        + '\necho "$HERMES_USER"\n'
    )
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "WORLD": str(tmp_path), **({"HERMES_USER": env_user} if env_user else {})}
    result = subprocess.run(["bash", "-c", body], env=env, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip(), result.stderr


def test_without_an_install_s_choice_the_session_user_is_hermes(tmp_path):
    assert session_user(tmp_path) == ("hermes", "")
    assert session_user(tmp_path, conf="# nothing chosen\n")[0] == "hermes"


def test_the_session_user_is_the_name_the_install_chose_before_and_after_it_exists(tmp_path):
    assert session_user(tmp_path, conf="user=luke\n")[0] == "luke"
    assert session_user(tmp_path, conf="user=luke\n", accounts="luke 1000\n")[0] == "luke"


def test_hermes_user_from_the_environment_still_wins(tmp_path):
    assert session_user(tmp_path, conf="user=luke\n", env_user="dev")[0] == "dev"


@pytest.mark.parametrize("name", ["Luke", "1luke", "lu ke", "luke;reboot", "-luke", "a" * 33, "../luke"])
def test_a_name_that_is_not_an_account_name_is_not_used(tmp_path, name):
    user, said = session_user(tmp_path, conf=f"user={name}\n")
    assert user == "hermes" and "not an account name" in said


@pytest.mark.parametrize("name, uid", [("root", 0), ("bin", 1), ("greetd", 976), ("nobody", 65534)])
def test_a_system_account_s_name_is_not_used(tmp_path, name, uid):
    user, said = session_user(tmp_path, conf=f"user={name}\n", accounts=f"{name} {uid}\n")
    assert user == "hermes" and "system account" in said


def first_boot_ssh(tmp_path: Path, keys: str | None, fails: bool = False, script: str | None = None) -> tuple[subprocess.CompletedProcess, str]:
    """firstboot.sh's SSH step, with a stand-in herald-os that writes down how it was asked."""
    bin_dir, calls = tmp_path / "bin", tmp_path / "calls"
    calls.write_text("")
    executable(bin_dir / "herald-os", f'echo "herald-os $*" >>"$CALLS"; exit {1 if fails else 0}')
    given = tmp_path / "ssh-keys"
    if keys is not None:
        given.write_text(keys)
    body = (
        "set -euo pipefail\n"
        f"HERMES_USER=luke SSH_KEYS={shlex.quote(str(given))}\n"
        + function_in(script or FIRSTBOOT.read_text(), "ssh_keys")
        + "ssh_keys\necho done\n"
    )
    result = subprocess.run(["bash", "-c", body], env={"PATH": f"{bin_dir}:/usr/bin:/bin", "CALLS": str(calls)}, capture_output=True, text=True, timeout=30, check=False)
    return result, calls.read_text()


@pytest.mark.parametrize("keys", [None, "", " \n\n\t\n"])
def test_without_keys_from_the_install_ssh_stays_off(tmp_path, keys):
    result, calls = first_boot_ssh(tmp_path, keys)
    assert result.returncode == 0 and "SSH stays off" in result.stdout and calls == ""


def test_keys_from_the_install_turn_ssh_on_for_the_session_user_through_setup_ssh(tmp_path):
    result, calls = first_boot_ssh(tmp_path, "ssh-ed25519 AAAA me@laptop\n")
    assert result.returncode == 0
    assert calls == f"herald-os setup ssh --user luke --keys-file {tmp_path / 'ssh-keys'}\n"


def test_when_setup_ssh_refuses_the_first_boot_goes_on_with_ssh_off(tmp_path):
    result, calls = first_boot_ssh(tmp_path, "ssh-ed25519 AAAA me@laptop\n", fails=True)
    assert result.returncode == 0 and "done" in result.stdout
    assert "WARNING: SSH did not turn on, so it stays off" in result.stdout and calls


def test_ssh_is_set_up_after_the_home_folder_and_before_hermes_which_can_wait_long():
    phase = function_in(FIRSTBOOT.read_text(), "system_phase")
    assert phase.index("session_account") < phase.index("ssh_keys") < phase.index("hermes_step")
    script = FIRSTBOOT.read_text()
    assert "INSTALL_CONF=/etc/herald-os/install.conf" in script and "SSH_KEYS=/etc/herald-os/ssh-keys" in script


def test_a_reset_turns_ssh_off_and_forgets_the_install_s_keys():
    helper = (ROOT / "linux" / "image" / "reset-helper").read_text()
    apply = helper.split("  apply)", 1)[1].split(";;", 1)[0]
    assert "rm -f /etc/herald-os/ssh-keys" in apply and "herald-os setup ssh --off --end-sessions" in apply
    assert apply.index("herald-os setup ssh --off") < apply.index('rm -f "$STATE/firstboot-done"')
    # The account is erased before sshd starts, so no one signs in to it over SSH meanwhile.
    unit = (ROOT / "linux" / "image" / "herald-os-reset.service").read_text()
    before = next(line for line in unit.splitlines() if line.startswith("Before="))
    assert {"sshd.service", "sshd.socket", "herald-os-firstboot.service"} <= set(before[len("Before="):].split())


def test_the_first_boot_never_turns_ssh_on_without_a_firewall():
    assert "--no-firewall" not in function_in(FIRSTBOOT.read_text(), "ssh_keys")


def firstboot_mutant(old: str, new: str) -> str:
    script = FIRSTBOOT.read_text()
    assert script.count(old) == 1, f"firstboot.sh no longer has exactly one {old!r}"
    return script.replace(old, new)


def keeps_odd_names_out(tmp_path: Path, script: str | None) -> bool:
    return session_user(tmp_path, conf="user=luke;reboot\n", script=script)[0] == "hermes"


def keeps_system_accounts_out(tmp_path: Path, script: str | None) -> bool:
    return session_user(tmp_path, conf="user=bin\n", accounts="bin 1\n", script=script)[0] == "hermes"


def ssh_off_without_keys(tmp_path: Path, script: str | None) -> bool:
    result, calls = first_boot_ssh(tmp_path, None, script=script)
    return result.returncode == 0 and calls == ""


def first_boot_survives_a_refusal(tmp_path: Path, script: str | None) -> bool:
    result, _ = first_boot_ssh(tmp_path, "ssh-ed25519 AAAA me\n", fails=True, script=script)
    return result.returncode == 0 and "done" in result.stdout


FIRSTBOOT_MUTANTS = {
    "any name": (keeps_odd_names_out, 'if [[ ! "$name" =~ $pattern ]]; then', "if false; then"),
    "system accounts": (keeps_system_accounts_out, "(( uid < ${min:-1000} || uid > ${max:-60000} ))", "false"),
    "ssh without keys": (ssh_off_without_keys, "if ! grep -q '[^[:space:]]' \"$SSH_KEYS\" 2>/dev/null; then", "if false; then"),
    "a refusal stops the first boot": (first_boot_survives_a_refusal, ' ||\n    echo "WARNING: SSH did not turn on', '\n    echo "WARNING: SSH did not turn on'),
}


@pytest.mark.parametrize("name", FIRSTBOOT_MUTANTS)
def test_each_first_boot_check_is_caught_when_taken_out(tmp_path, name):
    scenario, old, new = FIRSTBOOT_MUTANTS[name]
    (tmp_path / "real").mkdir()
    (tmp_path / "mutant").mkdir()
    assert scenario(tmp_path / "real", None)
    assert not scenario(tmp_path / "mutant", firstboot_mutant(old, new))


def run_reset_apply(tmp_path: Path, helper: str) -> str:
    """reset-helper apply with its state folder in tmp_path and stand-ins that write down what they did."""
    state, calls = tmp_path / "state", tmp_path / "calls"
    state.mkdir()
    (state / "reset-pending").write_text("hermes\n")
    calls.write_text("")
    bin_dir = tmp_path / "bin"
    for tool in ("loginctl", "userdel", "flatpak", "herald-os"):
        executable(bin_dir / tool, f'echo "{tool} $*" >>"$CALLS"')
    executable(bin_dir / "id", '[ "$1" = -u ] && echo 1000; exit 0')
    script = helper.replace("STATE=/var/lib/herald-os", f"STATE={shlex.quote(str(state))}")
    script = script.replace("/etc/herald-os/ssh-keys", str(tmp_path / "ssh-keys")).replace("/etc/NetworkManager/system-connections/", str(tmp_path) + "/nm-")
    result = subprocess.run(["bash", "-c", script, "reset-helper", "apply"], env={"PATH": f"{bin_dir}:/usr/bin:/bin", "CALLS": str(calls)}, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    return calls.read_text()


def test_a_reset_ends_ssh_sessions_and_turns_ssh_off(tmp_path):
    helper = (ROOT / "linux" / "image" / "reset-helper").read_text()
    calls = run_reset_apply(tmp_path, helper)
    assert "herald-os setup ssh --off --end-sessions" in calls.splitlines()
    (tmp_path / "mutant").mkdir()
    mutant = helper.replace("herald-os setup ssh --off --end-sessions >/dev/null", "herald-os setup ssh --off >/dev/null", 1)
    assert mutant != helper
    assert "--end-sessions" not in run_reset_apply(tmp_path / "mutant", mutant)
