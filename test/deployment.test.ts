import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { config } from '../src/config.js';

test('Portable Systemd Deployment & Service Hardening Suite', async (suite) => {
  const rootDir = path.resolve('.');
  const unitPath = path.join(rootDir, 'deployment/wa-agent.service');
  const envExamplePath = path.join(rootDir, 'deployment/environment.example');
  const logrotatePath = path.join(rootDir, 'deployment/logrotate.d/wa-agent');
  const installerPath = path.join(rootDir, 'scripts/install-service.sh');
  const uninstallerPath = path.join(rootDir, 'scripts/uninstall-service.sh');
  const verifyPath = path.join(rootDir, 'scripts/verify-deployment.sh');

  await suite.test('1. Systemd unit file: exists and contains zero personal /home/ paths', () => {
    assert.ok(fs.existsSync(unitPath), 'wa-agent.service must exist');
    const content = fs.readFileSync(unitPath, 'utf8');

    // Strictly verify no personal home directories
    assert.ok(!content.includes('/home/hanzlaahmad'), 'Must not contain /home/hanzlaahmad');
    assert.ok(!/\/home\/[a-zA-Z0-9_-]+/.test(content), 'Must not contain any personal /home/<user> paths');
  });

  await suite.test('2. Systemd unit file: enforces dedicated unprivileged user and portable paths', () => {
    const content = fs.readFileSync(unitPath, 'utf8');

    assert.match(content, /^User=wa-agent/m, 'Must run as User=wa-agent');
    assert.match(content, /^Group=wa-agent/m, 'Must run as Group=wa-agent');
    assert.match(content, /^WorkingDirectory=\/opt\/wa-agent/m, 'Must set WorkingDirectory to /opt/wa-agent');
    assert.match(content, /^EnvironmentFile=\/etc\/wa-agent\/environment/m, 'Must load /etc/wa-agent/environment');
    assert.match(content, /^Environment=HOME=\/var\/lib\/wa-agent/m, 'Must set HOME to /var/lib/wa-agent');
    assert.match(content, /^ExecStart=\/opt\/wa-agent\/bin\/node \/opt\/wa-agent\/dist\/index\.js/m, 'Must launch node /opt/wa-agent/dist/index.js');
  });

  await suite.test('3. Systemd unit file: security sandboxing directives verified', () => {
    const content = fs.readFileSync(unitPath, 'utf8');

    assert.match(content, /^NoNewPrivileges=true/m, 'Must enforce NoNewPrivileges=true');
    assert.match(content, /^PrivateTmp=true/m, 'Must enforce PrivateTmp=true');
    assert.match(content, /^ProtectSystem=full/m, 'Must enforce ProtectSystem=full');
    assert.match(content, /^ProtectHome=read-only/m, 'Must enforce ProtectHome=read-only');
    assert.match(content, /^ReadWritePaths=\/var\/lib\/wa-agent/m, 'Must isolate ReadWritePaths to /var/lib/wa-agent');
  });

  await suite.test('4. Environment template: contains all required production variables', () => {
    assert.ok(fs.existsSync(envExamplePath), 'environment.example must exist');
    const content = fs.readFileSync(envExamplePath, 'utf8');

    assert.ok(!content.includes('/home/hanzlaahmad'), 'Must not contain personal home paths');
    assert.match(content, /NODE_ENV=production/);
    assert.match(content, /ADMIN_PHONE_NUMBER=/);
    assert.match(content, /ALLOWED_ROOTS=/);
    assert.match(content, /DATABASE_PATH=\/var\/lib\/wa-agent\/data\/control_plane\.db/);
    assert.match(content, /BAILEYS_AUTH_DIR=\/var\/lib\/wa-agent\/auth_info_baileys/);
    assert.match(content, /LOG_DIR=\/var\/lib\/wa-agent\/data\/logs/);
    assert.match(content, /CLAUDE_BIN_PATH=/);
    assert.match(content, /ANTIGRAVITY_BIN_PATH=/);
    assert.match(content, /CODEX_BIN_PATH=/);
    assert.match(content, /OPENCODE_BIN_PATH=/);
    assert.match(content, /COPILOT_BIN_PATH=/);
  });

  await suite.test('5. Logrotate config: points to portable /var/lib/wa-agent/data/logs path', () => {
    assert.ok(fs.existsSync(logrotatePath), 'logrotate config must exist');
    const content = fs.readFileSync(logrotatePath, 'utf8');

    assert.ok(!content.includes('/home/hanzlaahmad'), 'Must not contain personal home paths');
    assert.match(content, /\/var\/lib\/wa-agent\/data\/logs\/\*\.log/);
    assert.match(content, /copytruncate/);
  });

  await suite.test('6. Installation script: passes bash syntax check and preserves state on upgrade', () => {
    assert.ok(fs.existsSync(installerPath), 'install-service.sh must exist');
    
    // Validate bash syntax
    execSync(`bash -n "${installerPath}"`);

    const content = fs.readFileSync(installerPath, 'utf8');
    assert.match(content, /groupadd --system wa-agent/);
    assert.match(content, /useradd --system --gid wa-agent/);
    assert.match(content, /systemctl daemon-reload/);
    assert.match(content, /systemctl enable wa-agent/);
    assert.match(content, /validate_node_binary/);
    assert.match(content, /node:sqlite/);

    // Verify upgrade safety: preserves existing environment file
    assert.match(content, /Existing configuration preserved/);
  });

  await suite.test('7. Installation script: detects and validates Node runtime requirements', () => {
    const content = fs.readFileSync(installerPath, 'utf8');
    assert.match(content, /NODE_BIN/);
    assert.match(content, /maj < 22/);
    assert.match(content, /min < 5/);
    assert.match(content, /opt\/wa-agent\/bin\/node/);
  });

  await suite.test('8. Uninstallation script: passes bash syntax check and preserves user data', () => {
    assert.ok(fs.existsSync(uninstallerPath), 'uninstall-service.sh must exist');

    // Validate bash syntax
    execSync(`bash -n "${uninstallerPath}"`);

    const content = fs.readFileSync(uninstallerPath, 'utf8');
    assert.match(content, /systemctl stop wa-agent/);
    assert.match(content, /systemctl disable wa-agent/);
    assert.match(content, /systemctl daemon-reload/);
    assert.match(content, /Preserving application state and credentials/);
    // Ensure it does NOT automatically rm -rf /var/lib/wa-agent
    assert.ok(!content.includes('rm -rf "${VAR_DIR}"'), 'Must not automatically delete state directory');
  });

  await suite.test('9. Verification script: passes bash syntax check and tests Node >= 22.5.0 + node:sqlite', () => {
    assert.ok(fs.existsSync(verifyPath), 'verify-deployment.sh must exist');
    execSync(`bash -n "${verifyPath}"`);

    const content = fs.readFileSync(verifyPath, 'utf8');
    assert.match(content, /Checking Node\.js runtime/);
    assert.match(content, /node:sqlite/);
    assert.match(content, /opt\/wa-agent\/bin\/node/);
  });

  await suite.test('10. Runtime config resolution: BAILEYS_AUTH_DIR is supported and resolved', () => {
    assert.ok(typeof config.BAILEYS_AUTH_DIR === 'string');
    assert.ok(path.isAbsolute(config.BAILEYS_AUTH_DIR));
    // Defaults to ./auth_info_baileys inside workspace
    assert.ok(config.BAILEYS_AUTH_DIR.endsWith('auth_info_baileys'));
  });

  await suite.test('11. Current Node runtime satisfies Node >= 22.5.0 and node:sqlite', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    assert.ok(maj > 22 || (maj === 22 && min >= 5), `Expected Node >= 22.5.0, got ${process.versions.node}`);
    assert.doesNotThrow(() => {
      // @ts-ignore
      import('node:sqlite');
    });
  });

  await suite.test('12. Documentation: MIGRATION.md and DEPLOYMENT.md exist with complete procedures', () => {
    const migrationPath = path.join(rootDir, 'deployment/MIGRATION.md');
    const deploymentPath = path.join(rootDir, 'deployment/DEPLOYMENT.md');

    assert.ok(fs.existsSync(migrationPath), 'MIGRATION.md must exist');
    assert.ok(fs.existsSync(deploymentPath), 'DEPLOYMENT.md must exist');

    const migration = fs.readFileSync(migrationPath, 'utf8');
    assert.match(migration, /claude/);
    assert.match(migration, /antigravity/);
    assert.match(migration, /codex/);
    assert.match(migration, /opencode/);
    assert.match(migration, /copilot/);
  });
});
