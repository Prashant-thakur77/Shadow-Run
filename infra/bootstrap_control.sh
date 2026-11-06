#!/usr/bin/env bash
# Control VM: API, web UI, MCP, Caddy with HTTPS. The only machine holding the prod credential. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/shadowrun
HOST="$1"

apt-get update -qq
apt-get install -y -qq postgresql-client-16 caddy rsync curl sqlite3 >/dev/null 2>&1 || {
  # Caddy is not in the Ubuntu archive on every mirror; add its official repository.
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq postgresql-client-16 caddy rsync curl sqlite3 >/dev/null
}

id shadowrun >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin shadowrun
command -v uv >/dev/null || (curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null)
export UV_PYTHON_INSTALL_DIR=/opt/uv-python
mkdir -p /opt/uv-python
chown -R root:root "$APP"
chmod -R go-w "$APP"
uv venv --quiet --python 3.12 --allow-existing "$APP/.venv"
uv pip install --quiet --python "$APP/.venv/bin/python" -e "$APP"
chmod -R a+rX "$APP" /opt/uv-python
install -d -o shadowrun -g shadowrun -m 700 /var/lib/shadowrun

cat > /etc/systemd/system/shadowrun-control.service <<UNIT
[Unit]
Description=Shadow Run control plane
After=network-online.target
[Service]
User=shadowrun
WorkingDirectory=$APP
Environment=PATH=$APP/.venv/bin:/usr/bin:/bin
Environment=SHADOWRUN_VAR=/var/lib/shadowrun
Environment=SHADOWRUN_ENV_FILE=/etc/shadowrun/control.env
ExecStart=$APP/.venv/bin/uvicorn control.api:app --host 127.0.0.1 --port 8100
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
    encode gzip
    reverse_proxy 127.0.0.1:8100
}
CADDY

systemctl daemon-reload
systemctl enable shadowrun-control.service >/dev/null
systemctl restart shadowrun-control.service || true
systemctl enable caddy >/dev/null
systemctl restart caddy
ufw --force reset >/dev/null || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
sleep 2
systemctl is-active caddy
