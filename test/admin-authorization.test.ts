import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import {
  normalizeJid,
  isSenderAdmin,
  authorizeUser,
  registerAdminLid,
  clearAdminLids,
  getAllAuthorizedPhones,
} from '../src/security/authorizer.js';
import { executeMessagePipeline } from '../src/whatsapp/message-pipeline.js';
import { UnauthorizedError } from '../src/router/errors.js';
import { config } from '../src/config.js';
import type { proto } from '@whiskeysockets/baileys';

const TEST_DB = path.resolve('./data/test_admin_auth.db');

test('WhatsApp Admin Authorization & LID Resolution Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  suite.after(() => {
    clearAdminLids();
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  const adminPhone = config.ADMIN_PHONE_NUMBER;
  const adminPhoneJid = `${adminPhone}@s.whatsapp.net`;
  const adminPhoneDeviceJid = `${adminPhone}:12@s.whatsapp.net`;
  const adminLidJid = '173559762686119@lid';
  const adminLidDeviceJid = '173559762686119:42@lid';
  const strangerPhoneJid = '999888777666@s.whatsapp.net';
  const strangerLidJid = '987654321098765@lid';

  await suite.test('1. JID Normalization: Canonical Baileys decode and device suffix stripping', () => {
    const pn = normalizeJid(adminPhoneDeviceJid);
    assert.equal(pn.jid, adminPhoneJid);
    assert.equal(pn.user, adminPhone);
    assert.equal(pn.server, 's.whatsapp.net');
    assert.equal(pn.isLid, false);

    const lid = normalizeJid(adminLidDeviceJid);
    assert.equal(lid.jid, adminLidJid);
    assert.equal(lid.user, '173559762686119');
    assert.equal(lid.server, 'lid');
    assert.equal(lid.isLid, true);
  });

  await suite.test('2. Admin identification: Phone JID authorized, unlinked LID initially rejected', () => {
    clearAdminLids();

    assert.equal(isSenderAdmin(adminPhoneJid), true);
    assert.equal(isSenderAdmin(adminPhoneDeviceJid), true);

    // Prior to LID registration, an unknown LID must NOT be treated as admin
    assert.equal(isSenderAdmin(adminLidJid), false);
    assert.equal(isSenderAdmin(adminLidDeviceJid), false);
    assert.equal(isSenderAdmin(strangerPhoneJid), false);
    assert.equal(isSenderAdmin(strangerLidJid), false);
  });

  await suite.test('3. Dynamic LID registration: Link LID to administrator account', () => {
    registerAdminLid(adminLidJid);

    assert.equal(isSenderAdmin(adminLidJid), true);
    assert.equal(isSenderAdmin(adminLidDeviceJid), true);

    // Stranger LID remains strictly unauthorized
    assert.equal(isSenderAdmin(strangerLidJid), false);
  });

  await suite.test('4. Database authorization flow: Admin LID is auto-whitelisted', () => {
    const user = authorizeUser(adminLidDeviceJid, 'Hanzla Ahmad');
    assert.equal(user.id, adminLidJid);
    assert.equal(user.is_authorized, 1);
    assert.equal(user.display_name, 'Hanzla Ahmad');

    // Confirm persisted in database
    const db = getDatabase();
    const row: any = db.prepare('SELECT * FROM users WHERE id = ?').get(adminLidJid);
    assert.ok(row);
    assert.equal(row.is_authorized, 1);
  });

  await suite.test('5. Retroactive unblocking: Prior unauthorized entry is upgraded on LID discovery', () => {
    clearAdminLids();

    const priorLid = '199999999999999@lid';
    // Stranger message inserts an unauthorized record (is_authorized = 0)
    assert.throws(() => authorizeUser(priorLid, 'Deferred Admin'), (err) => err instanceof UnauthorizedError);

    const db = getDatabase();
    const rowBefore: any = db.prepare('SELECT * FROM users WHERE id = ?').get(priorLid);
    assert.equal(rowBefore.is_authorized, 0);

    // Later, USync confirms this LID is the admin
    registerAdminLid(priorLid);

    // Record is upgraded in SQLite
    const rowAfter: any = db.prepare('SELECT * FROM users WHERE id = ?').get(priorLid);
    assert.equal(rowAfter.is_authorized, 1);

    // Subsequent authorizeUser call succeeds
    const user = authorizeUser(priorLid);
    assert.equal(user.is_authorized, 1);
  });

  await suite.test('6. Message Pipeline: Inbound direct message via LID with on-demand resolver', async () => {
    clearAdminLids();
    const pipelineLid = '188888888888888@lid';

    const msg: proto.IWebMessageInfo = {
      key: {
        id: 'LID_MSG_1',
        remoteJid: pipelineLid,
        fromMe: false,
      },
      message: {
        conversation: '/help',
      },
    };

    // Resolver simulates Baileys sock.onWhatsApp returning the admin LID
    const mockResolver = async (phone: string) => {
      if (phone === config.ADMIN_PHONE_NUMBER) {
        return pipelineLid;
      }
      return undefined;
    };

    const res = await executeMessagePipeline(msg, mockResolver);
    assert.equal(res.isUnauthorized, undefined);
    assert.equal(res.shouldReply, true);
    assert.match(res.replyText!, /WhatsApp Control Plane Help/);
  });

  await suite.test('7. Message Pipeline: Stranger LID is strictly rejected even with resolver', async () => {
    const strangerMsg: proto.IWebMessageInfo = {
      key: {
        id: 'STRANGER_LID_MSG_1',
        remoteJid: strangerLidJid,
        fromMe: false,
      },
      message: {
        conversation: '/run whoami',
      },
    };

    const mockResolver = async (phone: string) => {
      return adminLidJid; // Returns admin LID, which does NOT match strangerLidJid
    };

    const res = await executeMessagePipeline(strangerMsg, mockResolver);
    assert.equal(res.isUnauthorized, true);
    assert.equal(res.shouldReply, true);
    assert.equal(res.replyText, '🛑 *Access Denied*: Unauthorized sender.');
  });

  await suite.test('8. Additional Authorized Phone Numbers: Whitelisted and dynamically resolvable', async () => {
    const extraPhone = '888777666555';
    const extraPhoneJid = `${extraPhone}@s.whatsapp.net`;
    const extraLid = '888777666555123@lid';

    // Before adding to authorized, extra phone is rejected
    assert.equal(isSenderAdmin(extraPhoneJid), false);
    assert.equal(isSenderAdmin(extraLid), false);

    // Simulate adding extra phone to AUTHORIZED_PHONE_NUMBERS
    const origAuthorized = config.AUTHORIZED_PHONE_NUMBERS;
    (config as any).AUTHORIZED_PHONE_NUMBERS = [extraPhone];

    try {
      assert.ok(getAllAuthorizedPhones().includes(extraPhone));
      assert.equal(isSenderAdmin(extraPhoneJid), true);

      // Extra LID resolution via pipeline
      const msg: proto.IWebMessageInfo = {
        key: {
          id: 'EXTRA_LID_MSG_1',
          remoteJid: extraLid,
          fromMe: false,
        },
        message: {
          conversation: '/help',
        },
      };

      const mockResolver = async (phone: string) => {
        if (phone === extraPhone) {
          return extraLid;
        }
        return undefined;
      };

      const res = await executeMessagePipeline(msg, mockResolver);
      assert.equal(res.isUnauthorized, undefined);
      assert.equal(res.shouldReply, true);
      assert.equal(isSenderAdmin(extraLid), true);
    } finally {
      (config as any).AUTHORIZED_PHONE_NUMBERS = origAuthorized;
    }
  });
});
