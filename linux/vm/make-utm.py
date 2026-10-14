#!/usr/bin/env python3
"""Wrap Herald OS's aarch64 VM disk in a UTM bundle (`Herald OS.utm`) that opens with a double-click.

UTM's QEMU backend (ConfigurationVersion 4) on Apple's hypervisor: virtio-gpu with OpenGL, so niri
renders on the Mac's GPU; a display that follows the window's size; sound; clipboard sharing; NAT
networking; UEFI. 4 cores and 6 GiB of memory, what installer-test.yml boots the ISO with; UTM's
settings change them. The disk keeps its qcow2 form, so the bundle stays as small as the disk.

  python3 linux/vm/make-utm.py [--version V] [--name N] [--move] <disk.qcow2> <out-dir>
"""

import argparse
import plistlib
import shutil
import sys
import uuid
from pathlib import Path

DISK_NAME = "herald-os.qcow2"
CPUS = 4
MEMORY_MIB = 6144
# Rebuilding one version gives the same bundle, and two versions never share a UUID in UTM's list.
NAMESPACE = uuid.UUID("6f1d3f0e-6c7b-4d38-9a43-0b3d1e5a2c71")


def identity(version: str) -> tuple[str, str, str]:
    """The VM's UUID, its drive's and its network card's MAC, all from the version."""
    vm = uuid.uuid5(NAMESPACE, f"vm:{version}")
    drive = uuid.uuid5(NAMESPACE, f"drive:{version}")
    mac = "52:54:00:" + ":".join(f"{b:02x}" for b in vm.bytes[:3])
    return str(vm).upper(), str(drive).upper(), mac


def config(name: str, version: str) -> dict:
    vm, drive, mac = identity(version)
    return {
        "Backend": "QEMU",
        "ConfigurationVersion": 4,
        "Information": {
            "Name": name,
            "UUID": vm,
            "Icon": "linux",
            "IconCustom": False,
            "Notes": f"Herald OS Linux {version}. The first start sets itself up, Hermes Agent included.",
        },
        "System": {
            "Architecture": "aarch64",
            "Target": "virt",
            "CPU": "default",
            "CPUFlagsAdd": [],
            "CPUFlagsRemove": [],
            "CPUCount": CPUS,
            "ForceMulticore": False,
            "MemorySize": MEMORY_MIB,
            "JITCacheSize": 0,
        },
        "QEMU": {
            "DebugLog": False,
            "UEFIBoot": True,
            "RNGDevice": True,
            "BalloonDevice": False,
            "TPMDevice": False,
            "Hypervisor": True,
            "TSO": False,
            "RTCLocalTime": False,
            "PS2Controller": False,
            "AdditionalArguments": [],
        },
        "Input": {"UsbBusSupport": "3.0", "UsbSharing": False, "MaximumUsbShare": 3},
        "Sharing": {"DirectoryShareMode": "None", "DirectoryShareReadOnly": False, "ClipboardSharing": True},
        "Display": [
            {
                "Hardware": "virtio-gpu-gl-pci",
                "DynamicResolution": True,
                "NativeResolution": False,
                "UpscalingFilter": "Nearest",
                "DownscalingFilter": "Linear",
            }
        ],
        "Drive": [
            {
                "Identifier": drive,
                "ImageName": DISK_NAME,
                "ImageType": "Disk",
                "Interface": "VirtIO",
                "ReadOnly": False,
            }
        ],
        "Network": [
            {
                "Mode": "Shared",
                "Hardware": "virtio-net-pci",
                "MacAddress": mac,
                "IsolateFromHost": False,
                "PortForward": [],
            }
        ],
        "Serial": [],
        "Sound": [{"Hardware": "intel-hda"}],
    }


def make(disk: Path, out: Path, name: str = "Herald OS", version: str = "dev", move: bool = False) -> Path:
    if not disk.is_file():
        raise SystemExit(f"make-utm: no disk at {disk}")
    bundle = out / f"{name}.utm"
    if bundle.exists():
        raise SystemExit(f"make-utm: {bundle} already exists")
    data = bundle / "Data"
    data.mkdir(parents=True)
    (shutil.move if move else shutil.copyfile)(str(disk), str(data / DISK_NAME))
    with open(bundle / "config.plist", "wb") as f:
        plistlib.dump(config(name, version), f, sort_keys=True)
    return bundle


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Wrap Herald OS's aarch64 VM disk in a UTM bundle.")
    parser.add_argument("disk", type=Path, help="the aarch64 qcow2")
    parser.add_argument("out", type=Path, help="the folder the bundle goes in")
    parser.add_argument("--name", default="Herald OS")
    parser.add_argument("--version", default="dev")
    parser.add_argument("--move", action="store_true", help="move the disk into the bundle instead of copying it")
    args = parser.parse_args(argv)
    print(make(args.disk, args.out, args.name, args.version, args.move))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
