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

# Helper function to validate if a given node executable satisfies >= 22.5.0 with node:sqlite
validate_node_binary() {
    local candidate="$1"
    if [ -z "${candidate}" ] || [ ! -x "${candidate}" ]; then
        return 1
    fi
    "${candidate}" -e '
        const [majStr, minStr] = process.versions.node.split(".");
        const maj = parseInt(majStr, 10);
        const min = parseInt(minStr, 10);
        if (maj < 22 || (maj === 22 && min < 5)) process.exit(1);
        try {
            require("node:sqlite");
        } catch {
            process.exit(1);
        }
    ' >/dev/null 2>&1
}

# 1. Node.js Runtime Resolution & Verification
echo "🔍 [1/8] Detecting compatible Node.js runtime (>= 22.5.0 with node:sqlite)..."

CHOSEN_NODE=""

# 1a. Check if NODE_BIN is explicitly provided via environment
if [ -n "${NODE_BIN:-}" ] && validate_node_binary "${NODE_BIN}"; then
    CHOSEN_NODE="${NODE_BIN}"
    echo "  - Using explicitly specified NODE_BIN: ${CHOSEN_NODE}"
fi

# 1b. Check node in current environment PATH
if [ -z "${CHOSEN_NODE}" ] && command -v node >/dev/null 2>&1; then
    CURRENT_NODE=$(command -v node)
    if validate_node_binary "${CURRENT_NODE}"; then
        CHOSEN_NODE="${CURRENT_NODE}"
        echo "  - Found compatible Node in PATH: ${CHOSEN_NODE}"
    fi
fi

# 1c. Check SUDO_USER environment if run via sudo
if [ -z "${CHOSEN_NODE}" ] && [ -n "${SUDO_USER:-}" ]; then
    USER_HOME=$(getent passwd "${SUDO_USER}" | cut -d: -f6)
    
    # Try user's interactive login PATH
    USER_NODE=$(sudo -u "${SUDO_USER}" bash -l -c 'command -v node 2>/dev/null' || true)
    if [ -n "${USER_NODE}" ] && validate_node_binary "${USER_NODE}"; then
        CHOSEN_NODE="${USER_NODE}"
        echo "  - Found compatible Node in user (${SUDO_USER}) environment: ${CHOSEN_NODE}"
    fi

    # Check common user installation directories if still not found
    if [ -z "${CHOSEN_NODE}" ]; then
        for p in "${USER_HOME}/.hermes/node/bin/node" \
                 "${USER_HOME}/.local/bin/node" \
                 "${USER_HOME}/.nvm/versions/node/"*"/bin/node"; do
            if [ -f "$p" ] && validate_node_binary "$p"; then
                CHOSEN_NODE="$p"
                echo "  - Found compatible Node in user directory: ${CHOSEN_NODE}"
                break
            fi
        done
    fi
fi

# 1d. Check common system paths
if [ -z "${CHOSEN_NODE}" ]; then
    for p in "/usr/local/bin/node" "/opt/node/bin/node" "/usr/bin/node"; do
        if [ -f "$p" ] && validate_node_binary "$p"; then
            CHOSEN_NODE="$p"
            echo "  - Found compatible Node in system path: ${CHOSEN_NODE}"
            break
        fi
    done
fi

# Abort if no compatible Node runtime is found
if [ -z "${CHOSEN_NODE}" ]; then
    DETECTED_VER=$(node -v 2>/dev/null || echo "none")
    echo "❌ Error: Incompatible or missing Node.js runtime!" >&2
    echo "   WA-Agent requires Node.js >= 22.5.0 with built-in node:sqlite." >&2
    echo "   Detected version: ${DETECTED_VER}" >&2
    echo "   Please install Node.js >= 22.5.0 or re-run specifying NODE_BIN:" >&2
    echo "     sudo NODE_BIN=/path/to/node ./scripts/install-service.sh" >&2
    exit 1
fi

NODE_VERSION=$("${CHOSEN_NODE}" -v)
echo "  - Verified runtime: ${CHOSEN_NODE} (${NODE_VERSION})"

# 2. Create dedicated system user and group if missing
echo "👤 [2/8] Ensuring service user and group (wa-agent)..."
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

# 3. Prepare state directories (Preserving existing data)
echo "📁 [3/8] Preparing state directories in ${VAR_DIR}..."
mkdir -p "${VAR_DIR}/data/logs" "${VAR_DIR}/auth_info_baileys" "${VAR_DIR}/projects" "${VAR_DIR}/.local/bin"
chown -R wa-agent:wa-agent "${VAR_DIR}"
chmod 750 "${VAR_DIR}"
chmod 750 "${VAR_DIR}/data"
chmod 750 "${VAR_DIR}/data/logs"
chmod 700 "${VAR_DIR}/auth_info_baileys"
chmod 750 "${VAR_DIR}/projects"

# 4. Ensure build exists in source directory
echo "🔨 [4/8] Verifying compiled application build..."
if [ ! -f "${SOURCE_DIR}/dist/index.js" ]; then
    echo "  - Build not found. Running npm run build in ${SOURCE_DIR} using ${CHOSEN_NODE}..."
    (cd "${SOURCE_DIR}" && "${CHOSEN_NODE}" "$(command -v npm || which npm)" run build)
fi

# 5. Install application files into /opt/wa-agent & provision dedicated runtime
echo "📦 [5/8] Installing application binaries to ${APP_DIR}..."
mkdir -p "${APP_DIR}/bin"
cp -a "${SOURCE_DIR}/package.json" "${APP_DIR}/"
cp -a "${SOURCE_DIR}/dist" "${APP_DIR}/"

if [ -f "${SOURCE_DIR}/src/database/schema.sql" ]; then
    mkdir -p "${APP_DIR}/dist/database"
    cp -a "${SOURCE_DIR}/src/database/schema.sql" "${APP_DIR}/dist/database/schema.sql"
fi

if [ -f "${SOURCE_DIR}/data/timetable.json" ]; then
    mkdir -p "${APP_DIR}/data" "${VAR_DIR}/data"
    cp -a "${SOURCE_DIR}/data/timetable.json" "${APP_DIR}/data/timetable.json"
    cp -a "${SOURCE_DIR}/data/timetable.json" "${VAR_DIR}/data/timetable.json"
    chown wa-agent:wa-agent "${VAR_DIR}/data/timetable.json"
fi

if [ -d "${SOURCE_DIR}/node_modules" ]; then
    cp -a "${SOURCE_DIR}/node_modules" "${APP_DIR}/"
fi

if [ -d "${SOURCE_DIR}/scripts" ]; then
    cp -a "${SOURCE_DIR}/scripts" "${APP_DIR}/"
fi

if [ -d "${SOURCE_DIR}/deployment" ]; then
    cp -a "${SOURCE_DIR}/deployment" "${APP_DIR}/"
fi

# Provision dedicated runtime in /opt/wa-agent/bin/node
REAL_CHOSEN=$(realpath "${CHOSEN_NODE}")
REAL_APP_NODE=$(realpath "${APP_DIR}/bin/node" 2>/dev/null || true)

if [ "${REAL_CHOSEN}" = "${REAL_APP_NODE}" ] && [ -f "${APP_DIR}/bin/node" ]; then
    echo "  - Dedicated runtime already in place at ${APP_DIR}/bin/node"
else
    # If CHOSEN_NODE is located under a user home directory (e.g. /home/... or /root/...)
    # we must COPY the binary so the wa-agent service user can execute it without traversing
    # restrictive 0700 user home directories, and to eliminate personal path dependencies.
    if [[ "${REAL_CHOSEN}" == /home/* ]] || [[ "${REAL_CHOSEN}" == /root/* ]]; then
        echo "  - Copying Node binary from ${REAL_CHOSEN} to ${APP_DIR}/bin/node (self-contained)..."
        cp "${REAL_CHOSEN}" "${APP_DIR}/bin/node"
    else
        # For system-level paths (/usr/local/bin, /opt/node, /usr/bin), symlink is portable and safe
        echo "  - Linking system Node binary from ${REAL_CHOSEN} to ${APP_DIR}/bin/node..."
        ln -sf "${REAL_CHOSEN}" "${APP_DIR}/bin/node"
    fi
fi

chown root:wa-agent "${APP_DIR}/bin/node"
chmod 755 "${APP_DIR}/bin/node"
echo "  - Dedicated runtime ready at ${APP_DIR}/bin/node ($(${APP_DIR}/bin/node -v))"

# Also ensure /usr/local/bin/node is available for maintenance scripts if missing or older
REAL_USR_LOCAL=$(realpath "/usr/local/bin/node" 2>/dev/null || true)
if [ "${REAL_USR_LOCAL}" != "${REAL_APP_NODE}" ]; then
    if [ ! -f "/usr/local/bin/node" ] || ! validate_node_binary "/usr/local/bin/node"; then
        echo "  - Linking ${APP_DIR}/bin/node -> /usr/local/bin/node for system-wide availability..."
        ln -sf "${APP_DIR}/bin/node" /usr/local/bin/node
    fi
fi

# Protect application code: owned by root:wa-agent, read/execute only
chown -R root:wa-agent "${APP_DIR}"
chmod -R u=rwX,go=rX "${APP_DIR}"
chmod 755 "${APP_DIR}/bin/node"

# 6. Environment configuration (/etc/wa-agent/environment)
echo "⚙️ [6/8] Configuring environment in ${CONF_DIR}..."
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

# 7. Install systemd unit and logrotate configuration
echo "📜 [7/8] Installing systemd service unit and logrotate..."
cp "${SOURCE_DIR}/deployment/wa-agent.service" "${SYSTEMD_UNIT}"

# Dynamically append host allowed roots to ReadWritePaths in the installed service unit
if [ -f "${ENV_FILE}" ]; then
    ALLOWED_FROM_ENV=$(grep '^ALLOWED_ROOTS=' "${ENV_FILE}" | cut -d= -f2- | tr ',' ' ' || true)
    if [ -n "${ALLOWED_FROM_ENV}" ]; then
        for root in ${ALLOWED_FROM_ENV}; do
            if [ -d "${root}" ] && ! grep -q "${root}" "${SYSTEMD_UNIT}"; then
                sed -i "s|^ReadWritePaths=.*|& ${root}|" "${SYSTEMD_UNIT}"
            fi
        done
    fi
fi

# Patch HOME in installed unit to match the configured DEFAULT_CWD (where agent binaries auth live)
if [ -f "${ENV_FILE}" ]; then
    CONFIGURED_HOME=$(grep '^DEFAULT_CWD=' "${ENV_FILE}" | cut -d= -f2- || true)
    if [ -n "${CONFIGURED_HOME}" ] && [ -d "${CONFIGURED_HOME}" ]; then
        sed -i "s|^Environment=HOME=.*|Environment=HOME=${CONFIGURED_HOME}|" "${SYSTEMD_UNIT}"
        # Also ensure user's .local/bin is in PATH for agent binaries
        if ! grep -q "${CONFIGURED_HOME}/.local/bin" "${SYSTEMD_UNIT}"; then
            sed -i "s|^Environment=PATH=|Environment=PATH=${CONFIGURED_HOME}/.local/bin:|" "${SYSTEMD_UNIT}"
        fi
        # Ensure HOME is in ReadWritePaths
        if ! grep -q "${CONFIGURED_HOME}" "${SYSTEMD_UNIT}"; then
            sed -i "s|^ReadWritePaths=.*|& ${CONFIGURED_HOME}|" "${SYSTEMD_UNIT}"
        fi
    fi
fi

chown root:root "${SYSTEMD_UNIT}"
chmod 644 "${SYSTEMD_UNIT}"

if [ -f "${SOURCE_DIR}/deployment/logrotate.d/wa-agent" ]; then
    mkdir -p "$(dirname "${LOGROTATE_CONF}")"
    cp "${SOURCE_DIR}/deployment/logrotate.d/wa-agent" "${LOGROTATE_CONF}"
    chown root:root "${LOGROTATE_CONF}"
    chmod 644 "${LOGROTATE_CONF}"
fi

# 8. Reload systemd and enable service
echo "🔄 [8/8] Reloading systemd and enabling wa-agent.service..."
systemctl daemon-reload
systemctl enable wa-agent

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "✅ WA-Agent Service Installed Successfully!"
echo "═══════════════════════════════════════════════════════════"
echo "Service Account:      wa-agent:wa-agent"
echo "Runtime Binary:       ${APP_DIR}/bin/node ($(${APP_DIR}/bin/node -v))"
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
    systemctl restart wa-agent
    systemctl status wa-agent --no-pager
fi
