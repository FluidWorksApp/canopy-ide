# Local stand-in for the Lightsail `ubuntu_24_04` blueprint. The replica boots
# this filesystem from an ext4 "boot disk" image (see bin/replica-init), so the
# host sees a real block-device root, real ext4 and systemd as PID 1.
#
# Only these local-only pieces differ from a fresh Lightsail instance (all are
# documented in ../README.md):
# - cloud-init reads user data from a NoCloud seed instead of the EC2 metadata
#   service (same scripts-user path, same once-per-instance semantics);
# - lsblk/swapon/swapoff are diverted to small shims (bin/): loop devices are
#   presented as the instance's disks, and swap is accounted, not activated, so
#   a replica never adds swap to the shared Docker VM;
# - udev and snapd are absent (the Docker VM owns device events).
# Like the cloud image, unattended-upgrades, needrestart and the apt-daily
# timers are installed and enabled.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus cloud-init curl ca-certificates gnupg util-linux \
      e2fsprogs fdisk kmod iproute2 iptables nftables procps less sudo netbase \
      openssl lsb-release tzdata apt-utils unattended-upgrades needrestart \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean
# Cloud images ship without man pages etc. but are not "minimized"; restoring
# docs is not needed for host behaviour.
RUN for f in /usr/bin/lsblk /usr/sbin/swapon /usr/sbin/swapoff; do dpkg-divert --local --rename --add "$f"; done
COPY bin/lsblk /usr/bin/lsblk
COPY bin/swapon /usr/sbin/swapon
COPY bin/swapoff /usr/sbin/swapoff
COPY bin/replica-init bin/replica-attach bin/replica-detach bin/replica-observer /usr/local/lib/canopy-replica/
COPY canopy-replica-observer.service /etc/systemd/system/
COPY cloud.cfg /etc/cloud/cloud.cfg.d/90-canopy-replica.cfg
# The local CA signs the stand-ins for canopyide.dev, the S3 runtime bucket and
# ghcr.io. System tools trust it through the OS store; Node (which bundles its
# own roots in production) through NODE_EXTRA_CA_CERTS for every unit.
COPY replica-ca.crt /usr/local/share/ca-certificates/canopy-replica-ca.crt
COPY system.conf /etc/systemd/system.conf.d/90-canopy-replica.conf
RUN update-ca-certificates >/dev/null \
 && chmod 0755 /usr/bin/lsblk /usr/sbin/swapon /usr/sbin/swapoff /usr/local/lib/canopy-replica/* \
 && printf 'LABEL=cloudimg-rootfs / ext4 discard,errors=remount-ro 0 1\n' > /etc/fstab \
 && rm -f /etc/machine-id /var/lib/dbus/machine-id && touch /etc/machine-id \
 && mkdir -p /.replica/disks /.replica/oldroot \
 && systemctl enable canopy-replica-observer.service apt-daily.timer apt-daily-upgrade.timer \
 && systemctl mask systemd-firstboot.service console-getty.service getty@tty1.service 2>/dev/null || true
STOPSIGNAL SIGRTMIN+3
