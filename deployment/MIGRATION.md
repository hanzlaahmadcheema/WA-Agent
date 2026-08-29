# WA-Agent: Migration to Portable Systemd Deployment

This guide documents the procedure for migrating an existing local or developer installation of WA-Agent to the portable, multi-tenant Linux layout:

- **Application Directory**: `/opt/wa-agent` (owned by `root:wa-agent`, read/execute only)
- **Mutable State Directory**: `/var/lib/wa-agent` (owned by `wa-agent:wa-agent`)
- **Configuration Directory**: `/etc/wa-agent` (owned by `root:wa-agent`, permissions `0640`)
- **System Service**: `/etc/systemd/system/wa-agent.service` (runs as system user `wa-agent`)

---

## Pre-Migration Checklist

1. Node.js >= 22.5.0 installed globally.
2. Root / sudo access on the host.
3. Existing local checkout is in working condition.

---

## Step 1: Create an Atomic Backup of Current State

Before altering any system files, generate a complete backup of the local database and WhatsApp credentials:

```bash
cd /home/<user>/PersonalProjects/WA-Agent
./scripts/backup.sh
```
This produces an archive: `backups/wa_agent_backup_<timestamp>.tar.gz`. Keep this file safe for rollback.

---

## Step 2: Run the Portable Service Installer

Run the idempotent installer:

```bash
sudo ./scripts/install-service.sh
```

This performs the following actions without destroying existing data:
1. Creates the `wa-agent` system user and group (`HOME=/var/lib/wa-agent`).
2. Creates `/var/lib/wa-agent/{data,auth_info_baileys,projects}` with restrictive permissions (`0750` / `0700`).
3. Installs the compiled binaries into `/opt/wa-agent`.
4. Installs the `/etc/wa-agent/environment` configuration template (if not already present).
5. Installs and enables `/etc/systemd/system/wa-agent.service` and logrotate.

---

## Step 3: Explicitly Migrate State and Credentials

To transfer existing conversation history, tasks, and WhatsApp pairing credentials into the portable service account:

```bash
# 1. Copy SQLite database
sudo cp data/control_plane.db /var/lib/wa-agent/data/control_plane.db

# 2. Copy WhatsApp Baileys pairing keys
sudo cp -r auth_info_baileys/* /var/lib/wa-agent/auth_info_baileys/

# 3. Ensure wa-agent owns all migrated state
sudo chown -R wa-agent:wa-agent /var/lib/wa-agent
sudo chmod 700 /var/lib/wa-agent/auth_info_baileys
sudo chmod 750 /var/lib/wa-agent/data
```

---

## Step 4: Configure the Production Environment

Edit `/etc/wa-agent/environment`:

```bash
sudo nano /etc/wa-agent/environment
```

Ensure the following variables are configured:
```ini
NODE_ENV=production
ADMIN_PHONE_NUMBER=<your-whatsapp-phone-number>
ALLOWED_ROOTS=/var/lib/wa-agent/projects,/opt/my-projects

DATABASE_PATH=/var/lib/wa-agent/data/control_plane.db
BAILEYS_AUTH_DIR=/var/lib/wa-agent/auth_info_baileys
LOG_DIR=/var/lib/wa-agent/data/logs
LOG_LEVEL=info
HEALTH_PORT=8080
```

---

## Step 5: Provision Agent Credentials for the `wa-agent` User

Because the daemon runs under `wa-agent` with `ProtectHome=read-only`, each agent CLI resolves its configuration in `/var/lib/wa-agent`:

### 1. Claude Code
```bash
# Option A: Login interactively as wa-agent
sudo -u wa-agent claude login

# Option B: Copy existing developer credentials
sudo cp -r ~/.claude /var/lib/wa-agent/.claude
sudo cp ~/.claude.json /var/lib/wa-agent/.claude.json
sudo chown -R wa-agent:wa-agent /var/lib/wa-agent/.claude /var/lib/wa-agent/.claude.json
```

### 2. Antigravity (`agy`)
```bash
# Option A: Set GEMINI_API_KEY in /etc/wa-agent/environment
echo "GEMINI_API_KEY=your_key_here" | sudo tee -a /etc/wa-agent/environment

# Option B: Copy existing OAuth token
sudo mkdir -p /var/lib/wa-agent/.gemini
sudo cp -r ~/.gemini/antigravity-cli /var/lib/wa-agent/.gemini/
sudo chown -R wa-agent:wa-agent /var/lib/wa-agent/.gemini
```

### 3. OpenAI Codex CLI
```bash
# Option A: Set CODEX_API_KEY in /etc/wa-agent/environment
echo "CODEX_API_KEY=your_key_here" | sudo tee -a /etc/wa-agent/environment

# Option B: Login interactively as wa-agent
sudo -u wa-agent codex login
```

### 4. OpenCode
```bash
sudo mkdir -p /var/lib/wa-agent/.config
sudo cp -r ~/.opencode /var/lib/wa-agent/.opencode 2>/dev/null || true
sudo cp -r ~/.config/opencode /var/lib/wa-agent/.config/ 2>/dev/null || true
sudo chown -R wa-agent:wa-agent /var/lib/wa-agent/.opencode /var/lib/wa-agent/.config/opencode 2>/dev/null || true
```

### 5. GitHub Copilot
```bash
# Option A: Set GH_TOKEN / GITHUB_TOKEN in /etc/wa-agent/environment
echo "GH_TOKEN=your_token_here" | sudo tee -a /etc/wa-agent/environment

# Option B: Authenticate interactively as wa-agent
sudo -u wa-agent copilot login
```

---

## Step 6: Verify and Start the Service

```bash
# 1. Run the verification script
sudo ./scripts/verify-deployment.sh

# 2. Start the daemon
sudo systemctl start wa-agent

# 3. Check service status
sudo systemctl status wa-agent

# 4. Tail production logs
journalctl -u wa-agent -f

# 5. Verify HTTP health endpoints
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

---

## Rollback Procedure

If you need to revert to the previous local installation:

```bash
# 1. Stop and disable the portable service
sudo systemctl stop wa-agent
sudo systemctl disable wa-agent

# 2. Restore database and credentials from backup if required
tar -xzf backups/wa_agent_backup_<timestamp>.tar.gz -C ./
```
The original developer repository remains intact and ready to run locally via `npm run build && node dist/index.js`.
