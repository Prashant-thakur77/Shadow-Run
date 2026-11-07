#!/usr/bin/env bash
# VX1 host: KVM, microsandbox, Docker to build the rehearsal image, unprivileged uid `sbx`, walls.
# Holds no prod credential and no inference key. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/shadowrun
VPC_IP="$1"

apt-get update -qq
apt-get install -y -qq docker.io iptables rsync curl python3-venv >/dev/null
systemctl enable --now docker >/dev/null

id sbx >/dev/null 2>&1 || useradd --create-home --shell /bin/bash sbx
usermod -aG kvm sbx
chmod 750 /home/sbx
install -m 440 "$APP/infra/sudoers-sbx" /etc/sudoers.d/shadowrun-sbx

command -v uv >/dev/null || (curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null)
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
mkdir -p /opt/uv-python
chown -R root:root "$APP"
chmod -R go-w "$APP"
uv venv --quiet --python 3.12 --allow-existing "$APP/.venv"
uv pip install --quiet --python "$APP/.venv/bin/python" 'microsandbox==0.7.13' 'fastapi>=0.115' 'uvicorn[standard]>=0.30' 'pydantic>=2.7'
chmod -R a+rX "$APP" /opt/uv-python

# Build the rehearsal images and load them for sbx. Loading is local, so the egress wall can stay up.
PATH="$APP/.venv/bin:$PATH" LOAD_AS=sbx bash "$APP/runner/images/build.sh"

install -d -o sbx -g sbx -m 700 /var/lib/shadowrun
cat > /etc/systemd/system/shadowrun-egress.service <<UNIT
[Unit]
Description=Shadow Run second network wall (uid sbx)
After=network-online.target ufw.service
Wants=ufw.service
Before=shadowrun-runner.service
[Service]
Type=oneshot
RemainAfterExit=yes
Environment=VPC_CIDR=10.77.0.0/24
ExecStart=/bin/bash $APP/infra/sbx-egress.sh
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/shadowrun-runner.service <<UNIT
[Unit]
Description=Shadow Run runner (microVM lifecycle, red team)
After=network-online.target shadowrun-egress.service
Requires=shadowrun-egress.service
[Service]
User=sbx
UMask=0022
WorkingDirectory=$APP
Environment=PATH=$APP/.venv/bin:/usr/sbin:/usr/bin:/bin
Environment=PYTHONPATH=$APP
Environment=SHADOWRUN_RUNNER_BIND=$VPC_IP
Environment=SHADOWRUN_RUNNER_PORT=8101
Environment=SHADOWRUN_RUNNER_TMP=/var/lib/shadowrun
Environment=SHADOWRUN_CANARY_DIR=/var/lib/shadowrun/canary
Environment=SHADOWRUN_VM_PARALLEL=4
EnvironmentFile=/etc/shadowrun/runner.env
ExecStart=$APP/.venv/bin/python -m runner.service
# Each sandbox leaves a process handle behind, and the default soft limit of 1024 ran out after about 1,000 of them.
LimitNOFILE=65536
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
# Only the control plane may reach the runner port, whatever the Vultr firewall does.
ufw --force reset >/dev/null || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow from 10.77.0.0/24 to any port 8101 proto tcp >/dev/null
ufw --force enable >/dev/null
systemctl daemon-reload
# After ufw, on purpose: see infra/sbx-egress.sh.
systemctl enable --now shadowrun-egress.service >/dev/null
systemctl restart shadowrun-egress.service
systemctl enable shadowrun-runner.service >/dev/null
systemctl restart shadowrun-runner.service

sleep 2
echo "--- checks"
ls -l /dev/kvm
runuser -u sbx -- bash -c "export PATH=$APP/.venv/bin:\$PATH; msb --version; msb doctor; msb image ls"
systemctl is-active shadowrun-runner.service shadowrun-egress.service
