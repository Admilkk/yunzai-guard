set -eu
cd /vm
test ! -e guest.qcow2
test ! -e key
apk add --no-cache cdrkit
ssh-keygen -q -t ed25519 -N '' -f key
printf 'instance-id: guard-systemd-test\nlocal-hostname: guard-systemd-test\n' > meta-data
cat > user-data <<EOF
#cloud-config
users:
  - name: guard
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - $(cat key.pub)
ssh_pwauth: false
EOF
genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data
qemu-img create -f qcow2 -F qcow2 -b /vm/base.img guest.qcow2 12G
cp /usr/share/OVMF/OVMF_VARS.fd vars.fd
qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m 4096 -machine q35 -smbios type=1,serial=ds=nocloud -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd -drive if=pflash,format=raw,file=vars.fd -drive file=guest.qcow2,if=virtio,format=qcow2 -drive file=seed.iso,media=cdrom,readonly=on -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 -device virtio-net-pci,netdev=net0 -display none -serial file:/vm/serial.log -daemonize -pidfile /vm/qemu.pid
