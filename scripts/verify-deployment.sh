#!/usr/bin/env bash
set -euo pipefail

# WA-Agent Deployment Verification Script
# Validates systemd unit, service user, permissions, and directory structure

APP_DIR="/opt/wa-agent"
VAR_DIR="/var/lib/wa-agent"
CONF_DIR="/etc/wa-agent"
ENV_FILE="${CONF_DIR}/environment"
SYSTEMD_UNIT="/etc/systemd/system/wa-agent.service"

FAILURES=0

check_pass() {
    echo "  ✅ $1"
}

check_fail() {
    echo "  ❌ $1"
    FAILURES=$((FAILURES + 1))
}

check_warn() {
    echo "  ⚠️  $1"
}

echo "═══════════════════════════════════════════════════════════"
echo "  🔍 WA-Agent Production Deployment Verification"
echo "═══════════════════════════════════════════════════════════"
echo ""

# 1. Systemd Service Unit
echo "[1/6] Checking systemd service unit..."
if [ -f "${SYSTEMD_UNIT}" ]; then
    check_pass "Unit file exists: ${SYSTEMD_UNIT}"
    if grep -E "/home/[a-zA-Z0-9_-]+" "${SYSTEMD_UNIT}" >/dev/null 2>&1; then
        check_fail "Unit file contains personal /home/ paths!"
    else
        check_pass "Unit file contains zero hardcoded /home/ user paths."
    fi

    if grep -E "User=wa-agent" "${SYSTEMD_UNIT}" >/dev/null 2>&1; then
        check_pass "Unit runs as dedicated service account: User=wa-agent"
    else
        check_fail "Unit does not specify User=wa-agent"
    fi

    if grep -E "ProtectHome=read-only" "${SYSTEMD_UNIT}" >/dev/null 2>&1; then
        check_pass "Unit enforces ProtectHome=read-only"
    else
        check_warn "Unit does not enforce ProtectHome=read-only"
    fi
else
    check_fail "Unit file missing: ${SYSTEMD_UNIT}"
fi

# 2. Service User & Group
echo ""
echo "[2/6] Checking service user & group..."
if getent group wa-agent >/dev/null 2>&1; then
    check_pass "System group exists: wa-agent"
else
    check_fail "System group wa-agent does not exist"
fi

if id -u wa-agent >/dev/null 2>&1; then
    check_pass "System user exists: wa-agent (UID $(id -u wa-agent))"
    USER_HOME=$(getent passwd wa-agent | cut -d: -f6)
    if [ "${USER_HOME}" = "${VAR_DIR}" ]; then
        check_pass "User home directory correctly set to ${VAR_DIR}"
    else
        check_warn "User home directory is ${USER_HOME} (expected ${VAR_DIR})"
    fi
else
    check_fail "System user wa-agent does not exist"
fi

# 3. Application Directory
echo ""
echo "[3/6] Checking application directory (${APP_DIR})..."
if [ -d "${APP_DIR}" ]; then
    check_pass "Application directory exists"
    if [ -f "${APP_DIR}/dist/index.js" ]; then
        check_pass "Entrypoint exists: ${APP_DIR}/dist/index.js"
    else
        check_fail "Entrypoint missing: ${APP_DIR}/dist/index.js"
    fi

    if [ -d "${APP_DIR}/node_modules" ]; then
        check_pass "Dependencies present: ${APP_DIR}/node_modules"
    else
        check_fail "node_modules missing in ${APP_DIR}"
    fi
else
    check_fail "Application directory missing: ${APP_DIR}"
fi

# 4. Environment File
echo ""
echo "[4/6] Checking configuration environment (${ENV_FILE})..."
if [ -f "${ENV_FILE}" ]; then
    check_pass "Environment configuration exists: ${ENV_FILE}"
    PERMS=$(stat -c "%a" "${ENV_FILE}" 2>/dev/null || stat -f "%Lp" "${ENV_FILE}" 2>/dev/null || echo "unknown")
    if [ "${PERMS}" = "640" ] || [ "${PERMS}" = "600" ]; then
        check_pass "Environment file permissions are restrictive (${PERMS})"
    else
        check_warn "Environment file permissions are ${PERMS} (recommended: 640)"
    fi

    # Check for personal paths in environment file
    if grep -E "/home/[a-zA-Z0-9_-]+" "${ENV_FILE}" >/dev/null 2>&1; then
        check_warn "Environment file contains /home/ path (ensure this is intentional)"
    fi
else
    check_fail "Environment configuration missing: ${ENV_FILE}"
fi

# 5. Persistent State Directories & Permissions
echo ""
echo "[5/6] Checking persistent state directories (${VAR_DIR})..."
if [ -d "${VAR_DIR}" ]; then
    check_pass "State root exists: ${VAR_DIR}"
    
    # Check permissions not world writable
    WORLD_WRITE=$(find "${VAR_DIR}" -maxdepth 2 -perm -0002 2>/dev/null | wc -l)
    if [ "${WORLD_WRITE}" -eq 0 ]; then
        check_pass "No state directories are world-writable"
    else
        check_fail "Detected world-writable directories in ${VAR_DIR}!"
    fi

    if [ -d "${VAR_DIR}/data" ]; then
        check_pass "Database directory exists: ${VAR_DIR}/data"
    fi

    if [ -d "${VAR_DIR}/auth_info_baileys" ]; then
        check_pass "Baileys credentials directory exists: ${VAR_DIR}/auth_info_baileys"
    fi
else
    check_fail "State root missing: ${VAR_DIR}"
fi

# 6. Service Runtime & Health Check (Optional / Non-blocking)
echo ""
echo "[6/6] Checking service runtime status..."
if systemctl is-active --quiet wa-agent 2>/dev/null; then
    check_pass "wa-agent service is ACTIVE and running"
    
    # Check health and readiness endpoints
    HEALTH_PORT="${HEALTH_PORT:-8080}"
    if [ -f "${ENV_FILE}" ]; then
        HEALTH_PORT=$(grep '^HEALTH_PORT=' "${ENV_FILE}" | cut -d= -f2 || echo "8080")
    fi

    HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/health" 2>/dev/null || echo "DOWN")
    if [ "${HEALTH_STATUS}" = "200" ]; then
        check_pass "HTTP /health returned 200 OK (port ${HEALTH_PORT})"
    else
        check_warn "HTTP /health returned ${HEALTH_STATUS} on port ${HEALTH_PORT}"
    fi

    READY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/ready" 2>/dev/null || echo "DOWN")
    if [ "${READY_STATUS}" = "200" ]; then
        check_pass "HTTP /ready returned 200 OK"
    else
        check_warn "HTTP /ready returned ${READY_STATUS}"
    fi
else
    check_warn "wa-agent service is currently NOT running (Start via: sudo systemctl start wa-agent)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
if [ "${FAILURES}" -eq 0 ]; then
    echo "🎉 Verification PASSED: Deployment configuration is sound!"
    exit 0
else
    echo "⚠️  Verification FAILED: Detected ${FAILURES} issue(s) above."
    exit 1
fi
