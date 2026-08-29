# WA-Agent: Portable Production Deployment Guide

This document outlines the standard production deployment procedure for WA-Agent across Linux systems.

---

## 1. Directory & Service Architecture

The portable deployment separates immutable application code from mutable state and configurations:

```text
/opt/wa-agent/                       <-- Application Code (owned by root:wa-agent, read-only to daemon)
    ├── package.json
    ├── dist/
    ├── node_modules/
    ├── scripts/
    └── deployment/

/var/lib/wa-agent/                   <-- Mutable State & Service HOME (owned by wa-agent:wa-agent, 0750)
    ├── data/
    │   ├── control_plane.db         <-- SQLite Database (WAL mode)
    │   └── logs/                    <-- Application logs
    ├── auth_info_baileys/           <-- WhatsApp multi-file auth credentials (0700)
    ├── projects/                    <-- Default workspace directory for coding projects
    └── .<agent>/                    <-- Isolated CLI agent configurations and tokens

/etc/wa-agent/                       <-- Configuration Directory (owned by root:wa-agent, 0750)
    └── environment                  <-- Environment variables & secrets (0640)

/etc/systemd/system/
    └── wa-agent.service             <-- Systemd Unit File (runs as User=wa-agent, ProtectHome=read-only)
```

---

## 2. Fresh Installation

### Prerequisites
- Node.js >= 22.5.0
- systemd
- Linux kernel with user namespace support

### Installation Commands
```bash
# 1. Clone the repository
git clone https://github.com/hanzlaahmadcheema/WA-Agent.git /tmp/wa-agent-src
cd /tmp/wa-agent-src

# 2. Build the project
npm install
npm run build

# 3. Run the installer
sudo ./scripts/install-service.sh
```

The installer will:
- Create the system user `wa-agent` and group `wa-agent`.
- Create `/opt/wa-agent`, `/var/lib/wa-agent`, and `/etc/wa-agent`.
- Set restrictive permissions (`0750` for directories, `0640` for `/etc/wa-agent/environment`).
- Install and enable `wa-agent.service` and logrotate config.

---

## 3. Configuration

Edit `/etc/wa-agent/environment`:

```bash
sudo nano /etc/wa-agent/environment
```

Key configuration options:
- `ADMIN_PHONE_NUMBER`: Phone number authorized to send commands.
- `ALLOWED_ROOTS`: Comma-separated list of absolute directory paths the agents are permitted to access.
- `HEALTH_PORT`: Port for the HTTP health server (default: `8080`).
- `DEFAULT_AGENT`: Default agent to use (`claude`, `antigravity`, `codex`, `opencode`, `copilot`).

---

## 4. Agent Authentication Guide

When running as the `wa-agent` service account, agents store their auth tokens under `/var/lib/wa-agent`:

| Agent | Preferred Headless Authentication | Alternate Interactive Command |
| :--- | :--- | :--- |
| **Claude Code** | Copy `~/.claude/` to `/var/lib/wa-agent/.claude/` | `sudo -u wa-agent claude login` |
| **Antigravity** | `GEMINI_API_KEY=...` in `/etc/wa-agent/environment` | `sudo -u wa-agent agy` |
| **Codex CLI** | `CODEX_API_KEY=...` in `/etc/wa-agent/environment` | `sudo -u wa-agent codex login` |
| **OpenCode** | Copy `~/.opencode/` to `/var/lib/wa-agent/.opencode/` | `sudo -u wa-agent opencode` |
| **Copilot** | `GH_TOKEN=...` in `/etc/wa-agent/environment` | `sudo -u wa-agent copilot login` |

Ensure permissions are maintained after copying files:
```bash
sudo chown -R wa-agent:wa-agent /var/lib/wa-agent
```

---

## 5. Operations & Monitoring

### Starting the Service
```bash
sudo systemctl start wa-agent
```

### Checking Status
```bash
sudo systemctl status wa-agent
```

### Viewing Logs
```bash
# Live journal stream
journalctl -u wa-agent -f

# Application logs
tail -f /var/lib/wa-agent/data/logs/*.log
```

### Health & Readiness Endpoints
```bash
# Using default port 8085 (or configured HEALTH_PORT)
curl http://localhost:8085/health
curl http://localhost:8085/ready
```

### Operational Report
```bash
/opt/wa-agent/scripts/daily-report.sh
```

### Stopping the Service
```bash
sudo systemctl stop wa-agent
```

---

## 6. Upgrading WA-Agent

The installer is completely idempotent and safe for upgrades. It **never overwrites** existing database files, WhatsApp credentials, or configuration files:

```bash
cd /tmp/wa-agent-src
git pull
npm install
npm run build
sudo ./scripts/install-service.sh
sudo systemctl restart wa-agent
```

---

## 7. Uninstallation

To remove the service and application files while preserving data and credentials:

```bash
sudo /opt/wa-agent/scripts/uninstall-service.sh
```

To permanently delete all state:
```bash
sudo rm -rf /var/lib/wa-agent /etc/wa-agent
sudo userdel -r wa-agent 2>/dev/null || true
```

---

## 8. Security Review

- **Zero Hardcoded Paths**: No personal user paths (`/home/...`) exist in the production service or installation files.
- **Dedicated Unprivileged Account**: Runs as `User=wa-agent` (never as `root`).
- **Sandboxing**: `ProtectSystem=full`, `ProtectHome=read-only`, and `NoNewPrivileges=true` are strictly enforced by systemd.
- **Restricted Access**: The daemon can only write to `/var/lib/wa-agent` and explicit `ALLOWED_ROOTS`.
