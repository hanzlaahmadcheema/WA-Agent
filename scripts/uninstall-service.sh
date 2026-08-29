#!/usr/bin/env bash
set -euo pipefail

# WA-Agent Service Uninstaller
# Removes systemd service and application code while strictly preserving mutable state and credentials

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Error: This script must be run as root (use sudo)." >&2
    exit 1
fi

APP_DIR="/opt/wa-agent"
VAR_DIR="/var/lib/wa-agent"
CONF_DIR="/etc/wa-agent"
SYSTEMD_UNIT="/etc/systemd/system/wa-agent.service"
LOGROTATE_CONF="/etc/logrotate.d/wa-agent"

echo "═══════════════════════════════════════════════════════════"
echo "  🛑 WA-Agent Service Uninstaller"
echo "═══════════════════════════════════════════════════════════"

# 1. Stop service if running
if systemctl is-active --quiet wa-agent 2>/dev/null; then
    echo "🛑 [1/5] Stopping active wa-agent service..."
    systemctl stop wa-agent
else
    echo "ℹ️  [1/5] Service wa-agent is not running."
fi

# 2. Disable service
if systemctl is-enabled --quiet wa-agent 2>/dev/null; then
    echo "⏹️ [2/5] Disabling wa-agent service..."
    systemctl disable wa-agent
else
    echo "ℹ️  [2/5] Service wa-agent is not enabled."
fi

# 3. Remove systemd unit and logrotate configuration
echo "🗑️ [3/5] Removing systemd unit and logrotate configuration..."
if [ -f "${SYSTEMD_UNIT}" ]; then
    rm -f "${SYSTEMD_UNIT}"
    echo "  - Removed ${SYSTEMD_UNIT}"
fi

if [ -f "${LOGROTATE_CONF}" ]; then
    rm -f "${LOGROTATE_CONF}"
    echo "  - Removed ${LOGROTATE_CONF}"
fi

systemctl daemon-reload

# 4. Remove application code directory
echo "🧹 [4/5] Removing application binaries from ${APP_DIR}..."
if [ -d "${APP_DIR}" ]; then
    rm -rf "${APP_DIR}"
    echo "  - Removed ${APP_DIR}"
fi

# 5. State preservation report
echo "🔒 [5/5] Preserving application state and credentials..."
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ WA-Agent Service Uninstalled Successfully!"
echo "═══════════════════════════════════════════════════════════"
echo "Application state and configurations were INTENTIONALLY preserved:"
echo "  - Persistent state & credentials: ${VAR_DIR}"
echo "  - Configuration environment:       ${CONF_DIR}"
echo "  - Service account:                 wa-agent"
echo ""
echo "To completely purge all data, database, WhatsApp auth keys, and service user:"
echo "  sudo rm -rf ${VAR_DIR} ${CONF_DIR}"
echo "  sudo userdel -r wa-agent 2>/dev/null || true"
echo "═══════════════════════════════════════════════════════════"
