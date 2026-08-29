#!/usr/bin/env bash
set -euo pipefail

if [ -f "/etc/wa-agent/environment" ]; then
    set -a
    # shellcheck disable=SC1091
    . /etc/wa-agent/environment
    set +a
fi

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${BASE_DIR}/backups}"
TIMESTAMP="$(date +'%Y%m%d_%H%M%S')"
SNAPSHOT_DIR="${BACKUP_DIR}/snapshot_${TIMESTAMP}"
ARCHIVE_FILE="${BACKUP_DIR}/wa_agent_backup_${TIMESTAMP}.tar.gz"

mkdir -p "${SNAPSHOT_DIR}" "${BACKUP_DIR}"

echo "📦 [Backup] Creating atomic backup of WA-Agent state..."

# 1. Atomic SQLite online backup (handles active WAL mode safely)
DB_SRC="${DATABASE_PATH:-${BASE_DIR}/data/control_plane.db}"
DB_DEST="${SNAPSHOT_DIR}/control_plane.db"
if [ -f "${DB_SRC}" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        echo "  - Backing up SQLite database via online backup API..."
        sqlite3 "${DB_SRC}" ".backup '${DB_DEST}'"
    else
        echo "  - Copying SQLite database..."
        cp "${DB_SRC}" "${DB_DEST}"
    fi
fi

# 2. Backup Baileys authentication credentials
AUTH_SRC="${BAILEYS_AUTH_DIR:-${BASE_DIR}/auth_info_baileys}"
AUTH_DEST="${SNAPSHOT_DIR}/auth_info_baileys"
if [ -d "${AUTH_SRC}" ]; then
    echo "  - Backing up WhatsApp Baileys credentials..."
    cp -r "${AUTH_SRC}" "${AUTH_DEST}"
fi

# 3. Create compressed tarball archive
echo "  - Compressing archive: ${ARCHIVE_FILE}..."
tar -czf "${ARCHIVE_FILE}" -C "${BACKUP_DIR}" "snapshot_${TIMESTAMP}"
chmod 600 "${ARCHIVE_FILE}"

# Remove temporary uncompressed snapshot
rm -rf "${SNAPSHOT_DIR}"

# 4. Retention policy: Keep the latest 14 backups, delete older
echo "  - Pruning old backups (retaining latest 14)..."
ls -1t "${BACKUP_DIR}"/wa_agent_backup_*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "✅ [Backup] Backup completed successfully: ${ARCHIVE_FILE}"
