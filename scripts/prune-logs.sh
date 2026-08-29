#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${BASE_DIR}/data/logs"

echo "🧹 [Maintenance] Cleaning log files older than 7 days in ${LOG_DIR}..."
if [ -d "${LOG_DIR}" ]; then
    find "${LOG_DIR}" -type f -name "*.log" -mtime +7 -delete || true
fi

echo "🧹 [Maintenance] Pruning systemd journal logs to 7 days..."
if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-time=7d --unit=wa-agent 2>/dev/null || true
fi

DB_FILE="${BASE_DIR}/data/control_plane.db"
if [ -f "${DB_FILE}" ] && command -v sqlite3 >/dev/null 2>&1; then
    echo "🧹 [Maintenance] Optimizing and vacuuming SQLite database..."
    sqlite3 "${DB_FILE}" "PRAGMA optimize; VACUUM;"
fi

echo "✅ [Maintenance] Prune and retention sweep complete."
