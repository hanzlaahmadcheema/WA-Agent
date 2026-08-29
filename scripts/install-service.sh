#!/usr/bin/env bash
set -euo pipefail

# WA-Agent Portable Service Installer
# Installs WA-Agent to /opt/wa-agent and /var/lib/wa-agent under service account wa-agent

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Error: This script must be run as root (use sudo)." >&2
    exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/wa-agent"
VAR_DIR="/var/lib/wa-agent"
CONF_DIR="/etc/wa-agent"
ENV_FILE="${CONF_DIR}/environment"
SYSTEMD_UNIT="/etc/systemd/system/wa-agent.service"
LOGROTATE_CONF="/etc/logrotate.d/wa-agent"

AUTO_START=false
for arg in "$@"; do
    if [ "$arg" == "--start" ]; then
        AUTO_START=true
    fi
done

echo "═══════════════════════════════════════════════════════════"
echo "  🚀 WA-Agent Portable Production Service Installer"
echo "═══════════════════════════════════════════════════════════"
echo "Source directory:      ${SOURCE_DIR}"
echo "Application directory: ${APP_DIR}"
echo "State directory:       ${VAR_DIR}"
echo "Config directory:      ${CONF_DIR}"
echo ""

# 1. Create dedicated system user and group if missing
echo "👤 [1/7] Ensuring service user and group (wa-agent)..."
if ! getent group wa-agent >/dev/null 2>&1; then
    echo "  - Creating system group: wa-agent"
    groupadd --system wa-agent
else
    echo "  - System group wa-agent already exists."
fi

if ! id -u wa-agent >/dev/null 2>&1; then
    echo "  - Creating system user: wa-agent"
    useradd --system --gid wa-agent --home-dir "${VAR_DIR}" --shell /bin/bash wa-agent
else
    echo "  - System user wa-agent already exists."
fi

# 2. Prepare state directories (Preserving existing data)
echo "📁 [2/7] Preparing state directories in ${VAR_DIR}..."
mkdir -p "${VAR_DIR}/data/logs" "${VAR_DIR}/auth_info_baileys" "${VAR_DIR}/projects" "${VAR_DIR}/.local/bin"
chown -R wa-agent:wa-agent "${VAR_DIR}"
chmod 750 "${VAR_DIR}"
chmod 750 "${VAR_DIR}/data"
chmod 750 "${VAR_DIR}/data/logs"
chmod 700 "${VAR_DIR}/auth_info_baileys"
chmod 750 "${VAR_DIR}/projects"

# 3. Ensure build exists in source directory
echo "🔨 [3/7] Verifying compiled application build..."
if [ ! -f "${SOURCE_DIR}/dist/index.js" ]; then
    echo "  - Build not found. Running npm run build in ${SOURCE_DIR}..."
    (cd "${SOURCE_DIR}" && npm run build)
fi

# 4. Install application files into /opt/wa-agent
echo "📦 [4/7] Installing application binaries to ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cp -a "${SOURCE_DIR}/package.json" "${APP_DIR}/"
cp -a "${SOURCE_DIR}/dist" "${APP_DIR}/"

if [ -d "${SOURCE_DIR}/node_modules" ]; then
    cp -a "${SOURCE_DIR}/node_modules" "${APP_DIR}/"
fi

if [ -d "${SOURCE_DIR}/scripts" ]; then
    cp -a "${SOURCE_DIR}/scripts" "${APP_DIR}/"
fi

if [ -d "${SOURCE_DIR}/deployment" ]; then
    cp -a "${SOURCE_DIR}/deployment" "${APP_DIR}/"
fi

# Protect application code: owned by root:wa-agent, read/execute only
chown -R root:wa-agent "${APP_DIR}"
chmod -R u=rwX,go=rX "${APP_DIR}"

# 5. Environment configuration (/etc/wa-agent/environment)
echo "⚙️ [5/7] Configuring environment in ${CONF_DIR}..."
mkdir -p "${CONF_DIR}"
chown root:wa-agent "${CONF_DIR}"
chmod 750 "${CONF_DIR}"

if [ ! -f "${ENV_FILE}" ]; then
    echo "  - Installing new environment file from template..."
    cp "${SOURCE_DIR}/deployment/environment.example" "${ENV_FILE}"
    
    # If source contains a .env file, extract ADMIN_PHONE_NUMBER if present
    if [ -f "${SOURCE_DIR}/.env" ]; then
        SOURCE_ADMIN=$(grep '^ADMIN_PHONE_NUMBER=' "${SOURCE_DIR}/.env" | cut -d= -f2- || true)
        if [ -n "${SOURCE_ADMIN}" ]; then
            sed -i "s/^ADMIN_PHONE_NUMBER=.*/ADMIN_PHONE_NUMBER=${SOURCE_ADMIN}/" "${ENV_FILE}"
            echo "  - Extracted ADMIN_PHONE_NUMBER from local .env"
        fi
    fi
    chown root:wa-agent "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    echo "  - Created ${ENV_FILE} (permissions 0640)"
else
    echo "  - Existing configuration preserved at ${ENV_FILE}"
fi

# 6. Install systemd unit and logrotate configuration
echo "📜 [6/7] Installing systemd service unit and logrotate..."
cp "${SOURCE_DIR}/deployment/wa-agent.service" "${SYSTEMD_UNIT}"
chown root:root "${SYSTEMD_UNIT}"
chmod 644 "${SYSTEMD_UNIT}"

if [ -f "${SOURCE_DIR}/deployment/logrotate.d/wa-agent" ]; then
    mkdir -p "$(dirname "${LOGROTATE_CONF}")"
    cp "${SOURCE_DIR}/deployment/logrotate.d/wa-agent" "${LOGROTATE_CONF}"
    chown root:root "${LOGROTATE_CONF}"
    chmod 644 "${LOGROTATE_CONF}"
fi

# 7. Reload systemd and enable service
echo "🔄 [7/7] Reloading systemd and enabling wa-agent.service..."
systemctl daemon-reload
systemctl enable wa-agent

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ WA-Agent Service Installed Successfully!"
echo "═══════════════════════════════════════════════════════════"
echo "Service Account:      wa-agent:wa-agent"
echo "Working Directory:    ${APP_DIR}"
echo "Persistent State:     ${VAR_DIR}"
echo "Environment Config:   ${ENV_FILE}"
echo ""
echo "Next Steps:"
echo "  1. Review and edit configuration: sudo nano ${ENV_FILE}"
echo "  2. Start the service:             sudo systemctl start wa-agent"
echo "  3. Check live status:             sudo systemctl status wa-agent"
echo "  4. Follow logs:                   journalctl -u wa-agent -f"
echo "  5. Verify deployment:             sudo ${SOURCE_DIR}/scripts/verify-deployment.sh"
echo "═══════════════════════════════════════════════════════════"

if [ "${AUTO_START}" = true ]; then
    echo "▶ Starting service as requested (--start)..."
    systemctl start wa-agent
    systemctl status wa-agent --no-pager
fi
