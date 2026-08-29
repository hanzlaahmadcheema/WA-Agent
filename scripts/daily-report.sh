#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_FILE="${BASE_DIR}/data/control_plane.db"
AUTH_FILE="${BASE_DIR}/auth_info_baileys/creds.json"
HEALTH_PORT="${HEALTH_PORT:-8080}"

echo "====================================================="
echo "       📊 WA-Agent Daily Operational Report"
echo "====================================================="
echo "Report Timestamp (UTC): $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo ""

# 1. Systemd / Process Status & Uptime
if systemctl is-active --quiet wa-agent 2>/dev/null; then
    SERVICE_STATUS="ACTIVE (running)"
    RESTARTS=$(systemctl show wa-agent --property=NRestarts 2>/dev/null | cut -d= -f2 || echo "0")
    MEM_BYTES=$(systemctl show wa-agent --property=MemoryCurrent 2>/dev/null | cut -d= -f2 || echo "0")
    if [ "$MEM_BYTES" != "[not set]" ] && [ "$MEM_BYTES" -gt 0 ] 2>/dev/null; then
        MEM_MB=$(awk "BEGIN {printf \"%.1f MB\", $MEM_BYTES/1024/1024}")
    else
        MEM_MB="N/A"
    fi
else
    PID=$(pgrep -f "node.*dist/index.js" | head -n 1 || true)
    if [ -n "$PID" ]; then
        SERVICE_STATUS="MANUAL (PID: $PID)"
        RESTARTS="0 (manual)"
        MEM_KB=$(ps -p "$PID" -o rss= 2>/dev/null || echo "0")
        MEM_MB=$(awk "BEGIN {printf \"%.1f MB\", $MEM_KB/1024}")
    else
        SERVICE_STATUS="STOPPED"
        RESTARTS="N/A"
        MEM_MB="0 MB"
    fi
fi

echo "SERVICE STATUS:    $SERVICE_STATUS"
echo "RESTART COUNT:     $RESTARTS"
echo "MEMORY RSS:        $MEM_MB"

# 2. Health & Readiness Endpoints
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${HEALTH_PORT}/health" 2>/dev/null || echo "DOWN")
READY_JSON=$(curl -s "http://localhost:${HEALTH_PORT}/ready" 2>/dev/null || echo '{"status":"DOWN"}')
echo "HEALTH ENDPOINT:   HTTP $HEALTH_CODE"
echo "READINESS STATUS:  $READY_JSON"

# 3. WhatsApp Auth Status
if [ -f "$AUTH_FILE" ]; then
    AUTH_STATUS="HEALTHY (creds.json present, $(stat -c%s "$AUTH_FILE") bytes)"
else
    AUTH_STATUS="NOT CONFIGURED (creds.json missing)"
fi
echo "AUTH STATUS:       $AUTH_STATUS"

# 4. Database Metrics
if [ -f "$DB_FILE" ]; then
    DB_SIZE=$(ls -lh "$DB_FILE" | awk '{print $5}')
    echo "SQLITE DB SIZE:    $DB_SIZE"

    if command -v sqlite3 >/dev/null 2>&1; then
        echo ""
        echo "TASK METRICS (All Time):"
        sqlite3 -header -column "$DB_FILE" "
            SELECT 
                status AS STATUS, 
                COUNT(*) AS COUNT, 
                IFNULL(ROUND(AVG(duration_ms)/1000, 1), 0) || 's' AS AVG_DURATION,
                IFNULL(ROUND(SUM(cost_usd), 4), 0) AS TOTAL_COST_USD
            FROM jobs 
            GROUP BY status;
        " || true

        echo ""
        DEDUP_COUNT=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM processed_messages;" 2>/dev/null || echo "0")
        echo "MESSAGES DEDUPED:  $DEDUP_COUNT messages tracked"

        ACTIVE_RUNNING=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM jobs WHERE status = 'RUNNING';" 2>/dev/null || echo "0")
        echo "ACTIVE DB LOCKS:   $ACTIVE_RUNNING running tasks recorded"
    fi
else
    echo "SQLITE DB SIZE:    N/A (db file not found)"
fi

# 5. Process Group & Orphan Audit
ORPHANS=$(pgrep -fa "claude" 2>/dev/null | grep -v "grep" | grep -v "daily-report" || true)
if [ -z "$ORPHANS" ]; then
    echo "ORPHAN PROCESSES:  0 (clean)"
else
    ORPHAN_COUNT=$(echo "$ORPHANS" | wc -l)
    echo "ORPHAN PROCESSES:  ⚠️ $ORPHAN_COUNT active claude process(es) detected:"
    echo "$ORPHANS"
fi

echo "====================================================="
