import http from 'node:http';
import { getDatabase } from './database/connection.js';
import { config } from './config.js';
import { logger } from './logger.js';

let server: http.Server | null = null;
let getWhatsAppStateFn: (() => string) | null = null;

export function registerWhatsAppStateProvider(fn: () => string): void {
  getWhatsAppStateFn = fn;
}

export function startHealthServer(port: number = config.HEALTH_PORT): Promise<http.Server> {
  return new Promise((resolve) => {
    if (server) {
      resolve(server);
      return;
    }

    server = http.createServer(async (req, res) => {
      const url = req.url || '';

      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            uptime: Math.round(process.uptime()),
            timestamp: Date.now(),
          })
        );
        return;
      }

      if (req.method === 'GET' && url === '/ready') {
        const issues: string[] = [];

        // 1. Check SQLite
        try {
          const db = getDatabase();
          db.prepare('SELECT 1').get();
        } catch {
          issues.push('database_unhealthy');
        }

        // 2. Check Sandbox configuration
        if (!config.ALLOWED_ROOTS || config.ALLOWED_ROOTS.length === 0) {
          issues.push('missing_allowed_roots');
        }

        // 3. Check WhatsApp state if registered
        if (getWhatsAppStateFn) {
          const waState = getWhatsAppStateFn();
          if (waState === 'LOGGED_OUT') {
            issues.push('whatsapp_logged_out');
          }
        }

        if (issues.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ready',
              timestamp: Date.now(),
            })
          );
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'not_ready',
              issues,
              timestamp: Date.now(),
            })
          );
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    server.listen(port, () => {
      logger.info({ port }, 'health_server.started');
      resolve(server!);
    });
  });
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => {
      server = null;
      logger.info('health_server.stopped');
      resolve();
    });
  });
}
