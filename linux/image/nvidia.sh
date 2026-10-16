#!/usr/bin/env bash
# The NVIDIA image's layer on top of the default one (linux/image/Containerfile.nvidia; ADR-029):
# NVIDIA's open kernel modules, prebuilt and signed by Universal Blue, negativo17's driver and CUDA
# libraries to match, and NVIDIA's container toolkit, so local models get the GPU on the system and
# in containers. It follows Universal Blue's own nvidia-install.sh, without the 32-bit libraries
# (Steam's Flatpak brings its own), the X11 tools or their COPR. Runs as root at image build, x86_64
# only.
#
#   nvidia.sh <akmods image's /rpms/ublue-os> <akmods-nvidia image's /rpms>
set -euo pipefail

COMMON="${1:?nvidia.sh needs /rpms/ublue-os from the akmods image}"
AKMODS="${2:?nvidia.sh needs /rpms from the akmods-nvidia image}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS="${HERALD_OS_YUM_REPOS:-/etc/yum.repos.d}"
# Universal Blue's "ublue kernel" certificate, the key the modules are signed with and the one people
# enroll for Secure Boot: its SHA-256, which is also its fingerprint (docs/LINUX.md).
KEY=/etc/pki/akmods/certs/akmods-ublue.der
KEY_SHA256=4e5c68474cb133fd8984d9599762cece9100c3e6cd8a9709aeaabd85dd9e70d1
# The repositories' signing keys, committed next to this script and used instead of the URLs in the
# repository files: negativo17's (it also signs the driver RPMs in the akmods image) and NVIDIA's.
NEGATIVO17_KEY=0c5d0f470484ae2fc40a9b6597f3008993e8909b
NVIDIA_KEY=c95b321b61e88c1809c4f759ddcae044f796ecb0
step() { echo; echo "--- $*"; }

# Each repository the addons bring checks package signatures, and NVIDIA's its metadata's too.
repos_signed() {
  python3 - "$REPOS" <<'PY'
import configparser, sys
repos = sys.argv[1]
need = {"negativo17-fedora-nvidia.repo": {"fedora-nvidia": ["gpgcheck"]},
        "nvidia-container-toolkit.repo": {"nvidia-container-toolkit": ["gpgcheck", "repo_gpgcheck"]}}
bad = []
for name, sections in need.items():
    config = configparser.ConfigParser(interpolation=None)
    if not config.read(f"{repos}/{name}"):
        bad.append(f"{name} is missing")
        continue
    for section, options in sections.items():
        for option in options:
            if not config.has_section(section) or config.get(section, option, fallback="0") != "1":
                bad.append(f"{name} [{section}] has no {option}=1")
if bad:
    sys.exit("; ".join(bad))
PY
}

# Every repository the addons bring stays disabled in the image, and no COPR came with them.
repos_disabled() {
  python3 - "$REPOS" <<'PY'
import configparser, glob, os, sys
repos = sys.argv[1]
bad = [os.path.basename(path) for path in glob.glob(f"{repos}/_copr*.repo")]
for name in ("negativo17-fedora-nvidia.repo", "negativo17-fedora-nvidia-lts.repo", "nvidia-container-toolkit.repo"):
    config = configparser.ConfigParser(interpolation=None)
    config.read(f"{repos}/{name}")
    bad += [f"{name} [{section}]" for section in config.sections() if config.get(section, "enabled", fallback="1") != "0"]
if bad:
    sys.exit("enabled in the image: " + ", ".join(bad))
PY
}

# dnf does not check the signatures of RPMs given as files. Each driver RPM must be signed with
# negativo17's key, checked against an RPM database that holds that key alone, since rpm -K accepts
# any key the system's database has. kmod-nvidia is Universal Blue's build and carries no RPM
# signature: only its digests are checked here, and the cosign signature on the akmods-nvidia image,
# checked by digest in the image workflow, is what vouches for it.
# The key database is removed however the check ends: a refused RPM exits from here.
verify_rpms() {
  local rpm out
  keys="$(mktemp -d)"
  trap 'rm -rf "$keys"' EXIT
  rpm --dbpath "$keys" --import "$HERE/negativo17.asc"
  out="$(rpm --dbpath "$keys" -q gpg-pubkey --qf '%{VERSION}\n')"
  [[ "$out" == "$NEGATIVO17_KEY" ]] || { echo "the driver RPMs' key database holds ${out//$'\n'/ }, not $NEGATIVO17_KEY alone" >&2; exit 1; }
  for rpm in "${RPMS[@]}"; do
    out="$(rpm --dbpath "$keys" -K "$rpm" || true)"
    [[ "$out" == *": digests signatures OK" ]] || { echo "${rpm##*/} is not signed with negativo17's key: ${out##*: }" >&2; exit 1; }
  done
  out="$(rpm --dbpath "$keys" -K "$KMOD" || true)"
  [[ "$out" == *": digests OK" || "$out" == *": digests signatures OK" ]] || { echo "${KMOD##*/} fails its digests: ${out##*: }" >&2; exit 1; }
  rm -rf "$keys"
  trap - EXIT
}

[[ "$(uname -m)" == x86_64 ]] || { echo "the NVIDIA image is x86_64 only" >&2; exit 1; }

# KERNEL_VERSION, NVIDIA_AKMOD_VERSION and DIST_ARCH: what the modules were built for.
# shellcheck source=/dev/null
source "$AKMODS/kmods/nvidia-vars"
kernel="$(rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}\n' kernel-core)"
if [[ "$kernel" != "$KERNEL_VERSION" ]]; then
  echo "the NVIDIA modules are built for kernel $KERNEL_VERSION, and this image has $kernel:" \
    "build with the akmods images for this kernel (main-44-$kernel), or wait until Universal Blue publishes them" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
step "Universal Blue's module signing key (for Secure Boot: mokutil --import, docs/LINUX.md)"
# Only the key: the package's repositories (their COPR among them) stay out of the image.
rpm -i --excludepath=/etc/yum.repos.d --excludepath=/usr/share/ublue-os/etc/yum.repos.d "$COMMON"/ublue-os-akmods-addons-*.rpm
[[ -f "$KEY" ]] || { echo "ublue-os-akmods-addons has no $KEY" >&2; exit 1; }
if ! echo "$KEY_SHA256  $KEY" | sha256sum --quiet -c -; then
  echo "$KEY is not the certificate this script pins ($KEY_SHA256): Universal Blue changed its key?" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
step "NVIDIA's driver ($NVIDIA_AKMOD_VERSION for $KERNEL_VERSION), CUDA and the container toolkit"
# negativo17's and NVIDIA's repositories, which the addons bring disabled and leave so.
dnf -y install "$AKMODS"/ublue-os/ublue-os-nvidia-addons-*.rpm
repos_signed
RPMS=()
for rpm in "$AKMODS"/nvidia/*.x86_64.rpm "$AKMODS"/nvidia/*.noarch.rpm; do
  case "${rpm##*/}" in
    # X11 only; xorg-x11-nvidia would bring the Xorg server into a Wayland image.
    xorg-x11-nvidia-* | nvidia-xconfig-* | nvidia-settings-* | nvidia-libXNVCtrl-*) continue ;;
  esac
  RPMS+=("$rpm")
done
KMOD="$AKMODS/kmods/kmod-nvidia-$KERNEL_VERSION-$NVIDIA_AKMOD_VERSION.$DIST_ARCH.rpm"
verify_rpms
dnf -y install --setopt=install_weak_deps=False --enablerepo=fedora-nvidia --enablerepo=nvidia-container-toolkit \
  --setopt="fedora-nvidia.gpgkey=file://$HERE/negativo17.asc" \
  --setopt="nvidia-container-toolkit.gpgkey=file://$HERE/nvidia-container-toolkit.asc" \
  "${RPMS[@]}" "$KMOD" \
  nvidia-container-toolkit egl-wayland libva-nvidia-driver mokutil
for key in "$NEGATIVO17_KEY" "$NVIDIA_KEY"; do
  rpm -q gpg-pubkey --qf '%{VERSION}\n' | grep -qx "$key" || { echo "the RPM database has no key $key" >&2; exit 1; }
done
kmod="$(rpm -q --qf '%{VERSION}' kmod-nvidia)"
driver="$(rpm -q --qf '%{VERSION}' nvidia-driver)"
[[ "$kmod" == "$driver" ]] || { echo "kmod-nvidia $kmod does not match nvidia-driver $driver" >&2; exit 1; }
repos_disabled

# ---------------------------------------------------------------------------------------------
step "Services"
# nvidia-cdi-refresh writes the CDI spec podman reads for --device nvidia.com/gpu=all.
systemctl enable nvidia-persistenced.service nvidia-cdi-refresh.service nvidia-cdi-refresh.path
semodule --verbose --install /usr/share/selinux/packages/nvidia-container.pp

# ---------------------------------------------------------------------------------------------
step "The initramfs, with the driver in it, and the kernel arguments"
# negativo17 leaves the driver out of the initramfs; loaded later, many desktops come up on a black
# screen. The integrated GPU's driver loads first, or Chromium-based apps (the shell among them) lose
# hardware acceleration on hybrid laptops. Universal Blue's images do the same.
conf=/usr/lib/dracut/dracut.conf.d/99-nvidia.conf
grep -q '^omit_drivers+=" nvidia ' "$conf" || { echo "$conf is not the one this script expects" >&2; exit 1; }
sed -i -e 's@omit_drivers@force_drivers@' -e 's@ nvidia @ i915 amdgpu nvidia @' "$conf"
dracut -f --no-hostonly "/usr/lib/modules/$KERNEL_VERSION/initramfs.img" "$KERNEL_VERSION"
install -Dm0644 "$HERE/kargs-nvidia.toml" /usr/lib/bootc/kargs.d/20-herald-os-nvidia.toml
echo "initramfs: $(du -h "/usr/lib/modules/$KERNEL_VERSION/initramfs.img" | cut -f1)"

echo "==> NVIDIA layer done ($NVIDIA_AKMOD_VERSION)"
