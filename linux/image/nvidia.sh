#!/usr/bin/env bash
# The NVIDIA image's layer on top of the default one (linux/image/Containerfile, --target
# herald-os-nvidia; ADR-029): NVIDIA's open kernel modules, prebuilt and signed by Universal Blue,
# negativo17's driver and CUDA libraries to match, and NVIDIA's container toolkit, so local models
# get the GPU on the system and in containers. It follows Universal Blue's own nvidia-install.sh,
# without the 32-bit libraries (Steam's Flatpak brings its own), the X11 tools or their COPR.
# Runs as root at image build, x86_64 only.
#
#   nvidia.sh <akmods image's /rpms/ublue-os> <akmods-nvidia image's /rpms>
set -euo pipefail

COMMON="${1:?nvidia.sh needs /rpms/ublue-os from the akmods image}"
AKMODS="${2:?nvidia.sh needs /rpms from the akmods-nvidia image}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
step() { echo; echo "--- $*"; }

[[ "$(uname -m)" == x86_64 ]] || { echo "the NVIDIA image is x86_64 only" >&2; exit 1; }

# KERNEL_VERSION, NVIDIA_AKMOD_VERSION and DIST_ARCH: what the modules were built for.
# shellcheck source=/dev/null
source "$AKMODS/kmods/nvidia-vars"
kernel="$(rpm -q --qf '%{VERSION}-%{RELEASE}.%{ARCH}\n' kernel-core)"
if [[ "$kernel" != "$KERNEL_VERSION" ]]; then
  echo "the NVIDIA modules are built for kernel $KERNEL_VERSION, and this image has $kernel:" \
    "build with --build-arg AKMODS_TAG=main-44-$kernel, or wait until Universal Blue publishes it" >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
step "Universal Blue's module signing key (for Secure Boot: mokutil --import, docs/LINUX.md)"
# Only the key: the package's repositories (their COPR among them) stay out of the image.
rpm -i --excludepath=/etc/yum.repos.d --excludepath=/usr/share/ublue-os/etc/yum.repos.d "$COMMON"/ublue-os-akmods-addons-*.rpm
[[ -f /etc/pki/akmods/certs/akmods-ublue.der ]] || { echo "ublue-os-akmods-addons has no akmods-ublue.der" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
step "NVIDIA's driver ($NVIDIA_AKMOD_VERSION for $KERNEL_VERSION), CUDA and the container toolkit"
# negativo17's and NVIDIA's repositories, which the addons bring disabled and leave so.
dnf -y install "$AKMODS"/ublue-os/ublue-os-nvidia-addons-*.rpm
RPMS=()
for rpm in "$AKMODS"/nvidia/*.x86_64.rpm "$AKMODS"/nvidia/*.noarch.rpm; do
  case "${rpm##*/}" in
    # X11 only; xorg-x11-nvidia would bring the Xorg server into a Wayland image.
    xorg-x11-nvidia-* | nvidia-xconfig-* | nvidia-settings-* | nvidia-libXNVCtrl-*) continue ;;
  esac
  RPMS+=("$rpm")
done
dnf -y install --setopt=install_weak_deps=False --enablerepo=fedora-nvidia --enablerepo=nvidia-container-toolkit \
  "${RPMS[@]}" "$AKMODS/kmods/kmod-nvidia-$KERNEL_VERSION-$NVIDIA_AKMOD_VERSION.$DIST_ARCH.rpm" \
  nvidia-container-toolkit egl-wayland libva-nvidia-driver mokutil
kmod="$(rpm -q --qf '%{VERSION}' kmod-nvidia)"
driver="$(rpm -q --qf '%{VERSION}' nvidia-driver)"
[[ "$kmod" == "$driver" ]] || { echo "kmod-nvidia $kmod does not match nvidia-driver $driver" >&2; exit 1; }

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

echo "==> NVIDIA layer done ($NVIDIA_AKMOD_VERSION)"
