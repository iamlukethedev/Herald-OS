"""linux/image/firstboot.sh and Hermes Agent: found in any layout, given its voice extras the way that
layout takes them, and installed once the network is back when the first boot had none. Its
functions run in bash against a home folder in a temporary directory, with stand-ins for git, curl,
sleep, Hermes's installer and the parts of herald-os that change things; the real herald-os finds
Hermes."""

import re
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


class Accounts:
    """/etc/passwd, /etc/shadow, login.defs, /var/home and greetd's config in a temporary directory, with
    stand-ins for the tools that read and change accounts."""

    def __init__(self, tmp_path: Path, passwd: str = "", shadow: str = "", greetd: str = AUTOLOGIN, homes: dict[str, str] | None = None, remote: str = ""):
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
            '[ -f "$WORLD/getent-fails" ] && exit 2\n'
            'case "$1" in\n'
            '  passwd) if [ -n "$2" ]; then grep "^$2:" "$WORLD/passwd" || grep "^$2:" "$WORLD/remote"; else cat "$WORLD/passwd"; fi ;;\n'
            '  shadow) grep "^$2:" "$WORLD/shadow" ;;\n'
            "esac",
        )
        executable(
            bin_dir / "id",
            'if [ "$1" = -u ]; then line=$(grep "^$2:" "$WORLD/passwd") || exit 1; echo "$line" | cut -d: -f3; else grep -q "^$1:" "$WORLD/passwd"; fi',
        )
        executable(bin_dir / "stat", 'for path; do :; done; cat "$path/.owner"')
        executable(bin_dir / "date", "echo 2026-10-14T08:00:00+00:00")
        executable(bin_dir / "install", 'echo "install $*" >>"$CALLS"; exec /usr/bin/install "$@"')
        # useradd: the next free UID from 1000, and a password no one can sign in with, as shadow-utils does.
        executable(
            bin_dir / "useradd",
            'echo "useradd $*" >>"$CALLS"; shell=/bin/bash; for arg; do [ "$prev" = -s ] && shell="$arg"; prev="$arg"; name="$arg"; done\n'
            'uid=$(awk -F: \'$3 >= 1000 && $3 < 60000 && $3 >= n { n = $3 + 1 } END { print n ? n : 1000 }\' n=1000 "$WORLD/passwd")\n'
            'echo "$name:x:$uid:$uid::/home/$name:$shell" >>"$WORLD/passwd"; echo "$name:!:::::::" >>"$WORLD/shadow"',
        )
        # usermod -L (lock: a ! before the hash) and -s (the shell), together or alone; the user comes last.
        executable(
            bin_dir / "usermod",
            'echo "usermod $*" >>"$CALLS"; lock=; shell=; for arg; do [ "$prev" = -s ] && shell="$arg"; [ "$arg" = -L ] && lock=1; prev="$arg"; u="$arg"; done\n'
            f'if [ -n "$lock" ]; then file="$WORLD/shadow" f=2 v="!$(grep "^$u:" "$WORLD/shadow" | cut -d: -f2)"; {SET_FIELD}; fi\n'
            f'if [ -n "$shell" ]; then file="$WORLD/passwd" f=7 v="$shell"; {SET_FIELD}; fi\n'
            "exit 0",
        )
        executable(bin_dir / "passwd", f'echo "passwd $*" >>"$CALLS"; if [ "$1" = -d ]; then u="$2" file="$WORLD/shadow" f=2 v=""; {SET_FIELD}; fi; exit 0')
        self.env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "WORLD": str(tmp_path), "CALLS": str(self.calls)}

    def run(self, call: str) -> subprocess.CompletedProcess:
        quote = shlex.quote
        script = (
            "set -euo pipefail\n"
            f"HERMES_USER=hermes STATE={quote(str(self.state))} SWITCHED={quote(str(self.state / 'switched'))}\n"
            f"LOGIN_SCREEN={quote(str(self.state / 'login-screen'))} PASSWD={quote(str(self.passwd))}\n"
            f"GREETD={quote(str(self.greetd))} LOGIN_DEFS={quote(str(self.root / 'login.defs'))} SHARE={quote(str(ROOT / 'linux'))}\n"
            f"NOLOGIN={NOLOGIN} HOMES=({quote(str(self.homes))}/*)\n"
            + 'LOGIN_SCREEN_DUE=""\n'
            + functions("earlier_accounts", "switched", "has_password", "sign_in_accounts", "login_screen_due", "session_account", "login_screen", "login_phase", "greeter")
            + call
            + "\n"
        )
        return subprocess.run(["bash", "-c", script], env=self.env, capture_output=True, text=True, timeout=60, check=False)

    def boot(self) -> subprocess.CompletedProcess:
        """herald-os-login.service: firstboot.sh login."""
        result = self.run("login_phase")
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

    def login_screen(self) -> bool:
        """What the shell's setup reads: the account signed in at a login screen."""
        return (self.state / "login-screen").exists()


def first_boot(accounts: Accounts) -> subprocess.CompletedProcess:
    """What system_phase does about the account and greetd."""
    result = accounts.run("session_account\ngreeter")
    assert result.returncode == 0, result.stderr
    return result


def assert_switched_and_closed(accounts: Accounts) -> None:
    """A login screen, and a session user no one can sign in to."""
    assert accounts.switched() and accounts.login_screen()
    assert accounts.password("hermes").startswith("!") and accounts.shell("hermes") == NOLOGIN
    assert accounts.greetd.read_text() == LOGIN_SCREEN


def test_an_install_from_the_image_signs_its_new_account_in_and_setup_asks_for_a_password(tmp_path):
    accounts = Accounts(tmp_path)
    first_boot(accounts)
    assert "useradd -m -G wheel hermes" in accounts.calls.read_text()
    assert accounts.password("hermes") == "" and accounts.shell("hermes") == "/bin/bash"
    assert not accounts.switched() and not accounts.login_screen()
    assert accounts.greetd.read_text() == AUTOLOGIN
    # The boot unit, which runs on every boot, changes nothing on such a system.
    (accounts.homes / "hermes").mkdir()
    (accounts.homes / "hermes" / ".owner").write_text("hermes")
    accounts.boot()
    assert accounts.greetd.read_text() == AUTOLOGIN and accounts.password("hermes") == ""


def test_a_switched_system_gets_a_locked_administrator_with_no_shell_and_a_login_screen(tmp_path):
    accounts = Accounts(tmp_path, passwd="me:x:1000:1000::/var/home/me:/bin/bash\n", shadow="me:$y$secret:::::::\n", homes={"me": "me"})
    result = first_boot(accounts)
    assert "switched from another system, which has these accounts:" in result.stdout and " me " in result.stdout
    assert "passwd -d" not in accounts.calls.read_text()
    assert_switched_and_closed(accounts)
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
    assert accounts.shell("hermes") == "/bin/bash" and accounts.password("hermes") == "$y$theirs"
    assert "has a password now, and its shell back" in result.stdout
    assert accounts.greetd.read_text() == LOGIN_SCREEN


def test_a_session_user_that_has_a_password_keeps_it_and_meets_the_login_screen(tmp_path):
    accounts = Accounts(
        tmp_path,
        passwd="me:x:1000:1000::/var/home/me:/bin/bash\nhermes:x:1001:1001::/var/home/hermes:/bin/bash\n",
        shadow="me:$y$secret:::::::\nhermes:$y$theirs:::::::\n",
    )
    accounts.boot()
    assert accounts.password("hermes") == "$y$theirs" and accounts.shell("hermes") == "/bin/bash"
    assert "usermod" not in accounts.calls.read_text()
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
    assert accounts.password("hermes") == "" and accounts.shell("hermes") == "/bin/bash"
    assert accounts.greetd.read_text() == AUTOLOGIN
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


def test_a_home_folder_whose_owner_no_one_can_resolve_keeps_setup_s_password_prompt(tmp_path):
    accounts = Accounts(tmp_path, homes={"gone": "1234"})
    fallback(accounts)


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
