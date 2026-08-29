#!/usr/bin/env bash
set -euo pipefail

# Displays the latest WhatsApp pairing QR code without systemd timestamps or line truncations
echo "📱 Fetching latest WhatsApp QR code from wa-agent service logs..."
echo ""
journalctl -u wa-agent -o cat -n 45 --no-pager
echo ""
echo "💡 Tip: To watch for a live QR code refresh in real-time:"
echo "   journalctl -u wa-agent -o cat -f"
