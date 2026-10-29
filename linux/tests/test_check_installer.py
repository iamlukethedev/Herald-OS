"""linux/image/check-installer.sh: an installer whose LVM D-Bus service cannot start (#180) fails the
check, for each step of the service's D-Bus activation, and the image and installer workflows run it."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "linux" / "image" / "check-installer.sh"
BASH = shutil.which(os.environ.get("HERALD_OS_TEST_BASH", "bash"))

ACTIVATION = """[D-BUS Service]
Name=com.redhat.lvmdbus1
Exec=/usr/bin/lvmdbusd --udev
User=root
SystemdService=lvm2-lvmdbusd.service
"""
UNIT = """[Unit]
Description=LVM2 D-Bus service
Documentation=man:lvmdbusd(8)

[Service]
Type=dbus
BusName=com.redhat.lvmdbus1
ExecStart=/usr/bin/lvmdbusd

[Install]
WantedBy=multi-user.target
"""
POLICY = """<busconfig>
	<policy user="root">
		<allow own_prefix="com.redhat.lvmdbus1"/>
		<allow send_destination="com.redhat.lvmdbus1"/>
	</policy>
	<policy context="default">
		<deny own_prefix="com.redhat.lvmdbus1"/>
	</policy>
</busconfig>
"""

# The files of Fedora 44's installer (lvm2-dbusd 2.03.38) that D-Bus activation of lvmdbusd goes through.
FILES = {
    "usr/share/dbus-1/system-services/com.redhat.lvmdbus1.service": ACTIVATION,
    "usr/lib/systemd/system/lvm2-lvmdbusd.service": UNIT,
    "etc/dbus-1/system.d/com.redhat.lvmdbus1.conf": POLICY,
    "usr/bin/lvmdbusd": "#!/usr/bin/python3\nimport sys\nfrom lvmdbusd import main\n",
    "usr/bin/python3.14": "",
    "usr/bin/lvm": "",
    "etc/lvm/profile/lvmdbusd.profile": "report {\n\toutput_format=json\n}\n",
    "usr/lib/python3.14/site-packages/lvmdbusd/__init__.py": "",
    "usr/lib/python3.14/site-packages/lvmdbusd/path.py": 'LVM_BINARY = "/usr/bin/lvm"\n',
    "usr/lib64/python3.14/site-packages/dbus/__init__.py": "",
    "usr/lib64/python3.14/site-packages/gi/__init__.py": "",
    "usr/lib/python3.14/site-packages/pyudev/__init__.py": "",
    "etc/libblockdev/3/conf.d/10-lvm-dbus.cfg": "[lvm]\nsonames=libbd_lvm-dbus.so.3\n",
    "usr/lib64/libbd_lvm-dbus.so.3.0.0": "",
}
EXECUTABLE = {"usr/bin/lvmdbusd", "usr/bin/python3.14", "usr/bin/lvm"}


def installer(tmp_path: Path) -> Path:
    root = tmp_path / "root"
    for name, text in FILES.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        if name in EXECUTABLE:
            path.chmod(0o755)
    # As in the installer: python3 is a link, and /bin, /sbin and /lib64 lead into /usr.
    (root / "usr/bin/python3").symlink_to("python3.14")
    (root / "bin").symlink_to("usr/bin")
    (root / "sbin").symlink_to("usr/sbin")
    (root / "lib64").symlink_to("usr/lib64")
    (root / "etc/systemd/system").mkdir(parents=True)
    return root


def check(root: Path) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, str(SCRIPT), "--static", str(root)], capture_output=True, text=True, check=False)


def test_an_installer_that_can_start_the_service_passes(tmp_path):
    found = check(installer(tmp_path))
    assert found.returncode == 0, found.stderr
    assert found.stderr == ""
    assert "ok: ExecStart /usr/bin/lvmdbusd" in found.stdout
    assert "ok: interpreter /usr/bin/python3" in found.stdout
    assert "libbd_lvm-dbus.so.3.0.0" in found.stdout


def remove(name):
    return lambda root: (root / name).unlink()


def write(name, text):
    def change(root):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    return change


def link(name, target):
    def change(root):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).symlink_to(target)
    return change


def not_executable(name):
    return lambda root: (root / name).chmod(0o644)


def remove_tree(name):
    return lambda root: shutil.rmtree(root / name)


UNIT_PATH = "usr/lib/systemd/system/lvm2-lvmdbusd.service"
ACTIVATION_PATH = "usr/share/dbus-1/system-services/com.redhat.lvmdbus1.service"
# Each way the service's D-Bus activation can be broken, and what the check says about it.
BROKEN = {
    "no activation file": (remove(ACTIVATION_PATH), "no D-Bus activation file names com.redhat.lvmdbus1"),
    "activation file for another name": (
        write(ACTIVATION_PATH, ACTIVATION.replace("Name=com.redhat.lvmdbus1", "Name=com.redhat.lvmdbusd1")),
        "no D-Bus activation file names com.redhat.lvmdbus1",
    ),
    "activation file naming another unit": (
        write(ACTIVATION_PATH, ACTIVATION.replace("SystemdService=lvm2-lvmdbusd.service", "SystemdService=lvmdbusd.service")),
        "starts systemd unit 'lvmdbusd.service', not lvm2-lvmdbusd.service",
    ),
    "no unit": (remove(UNIT_PATH), "the installer has no lvm2-lvmdbusd.service"),
    "masked unit": (link("etc/systemd/system/lvm2-lvmdbusd.service", "/dev/null"), "lvm2-lvmdbusd.service is masked"),
    "unit owning another name": (
        write(UNIT_PATH, UNIT.replace("BusName=com.redhat.lvmdbus1", "BusName=com.redhat.lvmdbus2")),
        "owns 'com.redhat.lvmdbus2', not com.redhat.lvmdbus1",
    ),
    "unit that is not Type=dbus": (write(UNIT_PATH, UNIT.replace("Type=dbus", "Type=simple")), "is Type=simple, not Type=dbus"),
    "unit without ExecStart": (write(UNIT_PATH, UNIT.replace("ExecStart=/usr/bin/lvmdbusd\n", "")), "has no ExecStart="),
    "drop-in starting a missing program": (
        write("etc/systemd/system/lvm2-lvmdbusd.service.d/override.conf", "[Service]\nExecStart=\nExecStart=/usr/sbin/lvmdbusd\n"),
        "starts /usr/sbin/lvmdbusd, which the installer does not have",
    ),
    "no lvmdbusd": (remove("usr/bin/lvmdbusd"), "starts /usr/bin/lvmdbusd, which the installer does not have"),
    "lvmdbusd not executable": (not_executable("usr/bin/lvmdbusd"), "starts /usr/bin/lvmdbusd, which the installer does not have"),
    "no python3": (remove("usr/bin/python3.14"), "/usr/bin/lvmdbusd needs /usr/bin/python3"),
    "no D-Bus policy": (remove("etc/dbus-1/system.d/com.redhat.lvmdbus1.conf"), "no D-Bus policy lets lvmdbusd own com.redhat.lvmdbus1"),
    "policy that only denies": (
        write("etc/dbus-1/system.d/com.redhat.lvmdbus1.conf", '<busconfig><policy context="default"><deny own_prefix="com.redhat.lvmdbus1"/></policy></busconfig>\n'),
        "no D-Bus policy lets lvmdbusd own com.redhat.lvmdbus1",
    ),
    "no lvm": (remove("usr/bin/lvm"), "lvmdbusd runs /usr/bin/lvm, which the installer does not have"),
    "lvm where path.py does not look": (
        write("usr/lib/python3.14/site-packages/lvmdbusd/path.py", 'LVM_BINARY = "/usr/sbin/lvm"\n'),
        "lvmdbusd runs /usr/sbin/lvm, which the installer does not have",
    ),
    "no lvmdbusd profile": (remove("etc/lvm/profile/lvmdbusd.profile"), "no /etc/lvm/profile/lvmdbusd.profile"),
    "no lvmdbusd module": (remove_tree("usr/lib/python3.14/site-packages/lvmdbusd"), "no Python module lvmdbusd"),
    "no dbus module": (remove_tree("usr/lib64/python3.14/site-packages/dbus"), "no Python module dbus"),
    "no gi module": (remove_tree("usr/lib64/python3.14/site-packages/gi"), "no Python module gi"),
    "no pyudev module": (remove_tree("usr/lib/python3.14/site-packages/pyudev"), "no Python module pyudev"),
    "lvm-dbus plugin picked but missing": (remove("usr/lib64/libbd_lvm-dbus.so.3.0.0"), "picks libblockdev's lvm-dbus plugin, which the installer does not have"),
}


@pytest.mark.parametrize("name", BROKEN)
def test_each_broken_step_of_the_activation_fails_the_check(name, tmp_path):
    change, said = BROKEN[name]
    root = installer(tmp_path)
    change(root)
    found = check(root)
    assert found.returncode == 1
    assert said in found.stderr
    assert "the installer cannot start com.redhat.lvmdbus1" in found.stderr


def test_links_are_followed_inside_the_installer_not_on_the_host(tmp_path):
    """An absolute link in the installer means the installer's file; the host's /usr/bin/python3
    must not stand in for one the installer lacks."""
    root = installer(tmp_path)
    (root / "usr/bin/python3").unlink()
    (root / "usr/bin/python3").symlink_to("/usr/bin/python3.14")
    assert check(root).returncode == 0
    (root / "usr/bin/python3.14").unlink()
    found = check(root)
    assert found.returncode == 1 and "needs /usr/bin/python3" in found.stderr


def test_a_unit_in_etc_takes_the_place_of_the_one_in_usr(tmp_path):
    root = installer(tmp_path)
    (root / "etc/systemd/system/lvm2-lvmdbusd.service").write_text(UNIT.replace("/usr/bin/lvmdbusd", "/usr/libexec/lvmdbusd"))
    found = check(root)
    assert found.returncode == 1 and "starts /usr/libexec/lvmdbusd" in found.stderr


def test_without_the_lvm_dbus_plugin_the_service_is_not_required_to_be_picked(tmp_path):
    root = installer(tmp_path)
    (root / "etc/libblockdev/3/conf.d/10-lvm-dbus.cfg").unlink()
    (root / "usr/lib64/libbd_lvm-dbus.so.3.0.0").unlink()
    found = check(root)
    assert found.returncode == 0, found.stderr
    assert "libbd_lvm-dbus" not in found.stdout


def test_it_refuses_what_is_not_an_installer(tmp_path):
    found = subprocess.run([BASH, str(SCRIPT), "--static", str(tmp_path)], capture_output=True, text=True, check=False)
    assert found.returncode == 1 and "is not an installer root" in found.stderr
    assert subprocess.run([BASH, str(SCRIPT)], capture_output=True, text=True, check=False).returncode == 2


def test_the_script_passes_shellcheck():
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck is not installed")
    found = subprocess.run(["shellcheck", "--shell=bash", str(SCRIPT)], capture_output=True, text=True, check=False)
    assert found.returncode == 0, found.stdout


def steps(workflow: str, job: str) -> list[dict]:
    return yaml.safe_load((ROOT / ".github" / "workflows" / workflow).read_text())["jobs"][job]["steps"]


def test_the_image_workflow_checks_the_iso_before_it_is_packaged():
    names = [step.get("name") for step in steps("image.yml", "disks")]
    check_step = next(step for step in steps("image.yml", "disks") if "check-installer.sh" in step.get("run", ""))
    assert check_step["if"] == "matrix.type == 'anaconda-iso'"
    assert "sudo bash linux/image/check-installer.sh output/bootiso/install.iso" in check_step["run"]
    assert re.search(r"apt-get install [^\n]*squashfs-tools", check_step["run"])
    assert names.index("Build the disk with bootc-image-builder") < names.index(check_step["name"]) < names.index("Name, compress and split it")


def test_the_installer_test_checks_the_release_iso_before_installing_it():
    names = [step.get("name") for step in steps("installer-test.yml", "install")]
    check_step = next(step for step in steps("installer-test.yml", "install") if "check-installer.sh" in step.get("run", ""))
    assert "sudo bash linux/image/check-installer.sh herald.iso" in check_step["run"]
    assert names.index("The installer, from the release") < names.index(check_step["name"]) < names.index("Install")
