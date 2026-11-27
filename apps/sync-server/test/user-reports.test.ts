import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  httpCommitTransport,
  loginAccount,
  registerAccount,
  syncReplica,
} from '@zichan/db';
import { openLedger } from '@zichan/db/node';
import {
  newId,
  unlockLedgerKeyEnvelope,
  type Asset,
  type Category,
  type Transaction,
} from '@zichan/core';
import { buildMessage } from '../src/smtp-client.js';
import { createTestSyncServer, OWNER_SETUP_TOKEN } from './support/server-fixture.js';

describe('SMTP HTML multipart message builder', () => {
  it('builds a valid multipart/alternative payload when html is provided', () => {
    const raw = buildMessage({
      from: 'noreply@example.com',
      fromName: 'Zichan',
      to: ['user@example.com'],
      subject: '【资产账本】发薪月报',
      body: '总支出：¥100.00',
      html: '<html><body><h1>发薪月报</h1><p>总支出：¥100.00</p></body></html>',
      messageId: '<test@zichan>',
      date: 'Thu, 10 Nov 2026 01:00:00 GMT',
    });
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="zichan-');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
  });
});

describe('user report & notification preferences, HTML email, and push channels', () => {
  it('persists preferences, masks Bark deviceKey, delivers payday monthly report & inactivity reminder once', async () => {
    const sentEmails: Array<{ to: string; subject: string; body: string; html?: string }> = [];
    const sentPushes: Array<{ name: string; format: string; deviceKey?: string; title: string; text: string }> = [];
    let currentClock = new Date('2026-11-10T01:30:00.000Z'); // 09:30 Asia/Shanghai on 2026-11-10 (payday!)

    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-user-reports-'));
    const server = createTestSyncServer({
      dataDir,
      custodyKeyPath: join(dataDir, 'custody.key'),
      accountEmailSender: async (to, subject, body, html) => {
        sentEmails.push({ to, subject, body, html });
      },
      notificationPushSender: async (channel, message) => {
        sentPushes.push({
          name: channel.name,
          format: channel.format,
          deviceKey: channel.deviceKey,
          title: message.title,
          text: message.text,
        });
      },
      notificationClock: () => currentClock,
    });
    await server.ready;
    await server.started;
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    try {
      await registerAccount(url, 'owner', 'owner-pass-01', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'alice', 'alice-pass-01');
      const alice = await loginAccount(url, 'alice', 'alice-pass-01', {
        deviceId: 'alice-device-01',
        deviceName: 'Alice',
      });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.accessToken}`,
      };

      // Verify email for alice
      const reqCode = await fetch(`${url}/api/auth/email/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'alice@example.com' }),
      });
      expect(reqCode.status).toBe(200);
      const codeMatch = /(\d{8})/.exec(sentEmails.at(-1)?.body ?? '');
      expect(codeMatch?.[1]).toBeTruthy();
      const verify = await fetch(`${url}/api/auth/email/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: codeMatch![1] }),
      });
      expect(verify.status).toBe(200);
      sentEmails.length = 0;

      // Initialize managed custody ledger & push real encrypted transactions
      const init = await fetch(`${url}/api/v3/protection/initialize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'managed' }),
      });
      expect(init.status).toBe(200);
      const protection = await init.json() as { secret: string; envelope: { ledgerId: string } & Record<string, unknown> };
      const session = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope as never);

      const author = await openLedger({ deviceId: 'ALICE-AUTHOR' });
      try {
        await author.adoptLedgerId(protection.envelope.ledgerId);
        const cny: Asset = {
          id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, symbol: '¥', isActive: true,
        } as Asset;
        await author.assets.put(cny);
        const catFood: Category = {
          id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          name: '餐饮', type: 'expense', isActive: true,
        } as Category;
        await author.categories.put(catFood);
        const catDinner: Category = {
          id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          name: '聚餐', type: 'expense', parentId: catFood.id, isActive: true,
        } as Category;
        await author.categories.put(catDinner);
        const tx: Transaction = {
          id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
          date: '2026-11-05', type: 'expense', assetId: cny.id, amount: '88.50',
          category: catDinner.id, note: '火锅',
        } as Transaction;
        await author.transactions.put(tx);
        await fetch(`${url}/api/v3/replica/bind`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ledgerId: protection.envelope.ledgerId }),
        });
        const transport = httpCommitTransport({
          baseUrl: url,
          token: alice.accessToken,
          cryptoSession: session,
          keyEnvelope: protection.envelope as never,
        });
        await syncReplica(author, transport, url);
      } finally {
        await author.close();
      }

      // Save preferences: payday monthly (10th, 9:00), inactivity (3 days, 9:00), + Bark push
      const putRes = await fetch(`${url}/api/auth/notifications`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          timezone: 'Asia/Shanghai',
          privacyMode: false,
          emailEnabled: true,
          daily: { enabled: false, hour: 21, skipIfEmpty: true },
          weekly: { enabled: false, dayOfWeek: 1, hour: 9 },
          monthly: { enabled: true, mode: 'payday', paydayDay: 10, hour: 9 },
          inactivity: { enabled: true, days: 3, cooldownDays: 3, hour: 9 },
          pushChannels: [
            { kind: 'webhook', name: 'my-bark', format: 'bark', url: 'https://api.day.app/push', deviceKey: 'secret-bark-key-123', group: '资产账本', enabled: true },
          ],
        }),
      });
      expect(putRes.status).toBe(200);
      const putJson = await putRes.json() as { preferences: { pushChannels: Array<{ deviceKey?: string }> } };
      // Device key must be masked on response
      expect(putJson.preferences.pushChannels[0]?.deviceKey).toBe('********');

      // Re-saving with masked placeholder must keep the real secret intact
      const rePut = await fetch(`${url}/api/auth/notifications`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(putJson.preferences),
      });
      expect(rePut.status).toBe(200);

      // Run scheduler at 2026-11-10 09:30 Asia/Shanghai:
      // 1) Payday monthly report for 2026-10-10 .. 2026-11-09 is due!
      // 2) Last tx was 2026-11-05 (5 days ago >= 3 days), so inactivity reminder is also due!
      const pass1 = await server.flushUserNotifications();
      expect(pass1).toEqual({ processedUsers: 1, deliveries: 2 });

      expect(sentEmails).toHaveLength(2);
      const monthlyMail = sentEmails.find((m) => m.subject.includes('发薪月报'));
      expect(monthlyMail?.to).toBe('alice@example.com');
      expect(monthlyMail?.body).toContain('2026-10-10 至 2026-11-09');
      expect(monthlyMail?.body).toContain('¥88.50');
      expect(monthlyMail?.html).toContain('<!doctype html>');
      expect(monthlyMail?.html).toContain('火锅');

      const inactivityMail = sentEmails.find((m) => m.subject.includes('没有记账'));
      expect(inactivityMail?.body).toContain('2026-11-05');
      expect(inactivityMail?.html).toContain('已经 5 天没有记账啦');

      // Bark push received both notifications with the unmasked stored deviceKey
      expect(sentPushes).toHaveLength(2);
      expect(sentPushes[0]?.deviceKey).toBe('secret-bark-key-123');

      // Idempotency: running again on the same day must not send duplicates
      const pass2 = await server.flushUserNotifications();
      expect(pass2).toEqual({ processedUsers: 0, deliveries: 0 });
      expect(sentEmails).toHaveLength(2);

      // Cooldown: advancing 1 day (2026-11-11) should still respect 3-day cooldown for inactivity
      currentClock = new Date('2026-11-11T01:30:00.000Z');
      const pass3 = await server.flushUserNotifications();
      expect(pass3).toEqual({ processedUsers: 0, deliveries: 0 });

      // Manual preview endpoint returns HTML without delivering email/push
      const previewRes = await fetch(`${url}/api/auth/notifications/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'monthly' }),
      });
      expect(previewRes.status).toBe(200);
      const previewBody = await previewRes.json() as { subject: string; html: string };
      expect(previewBody.html).toContain('<!doctype html>');
      expect(sentEmails).toHaveLength(2);

      // Manual test send endpoint
      const testRes = await fetch(`${url}/api/auth/notifications/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ kind: 'monthly' }),
      });
      expect(testRes.status).toBe(200);
      const testBody = await testRes.json() as { status: string; results: Array<{ state: string }> };
      expect(testBody.status).toBe('sent');
      expect(testBody.results.every((r) => r.state === 'sent')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('auto-triggers payday_auto monthly report when two salary income entries exist', async () => {
    const sentEmails: Array<{ to: string; subject: string; body: string; html?: string }> = [];
    const dataDir = mkdtempSync(join(tmpdir(), 'zichan-payday-auto-'));
    const server = createTestSyncServer({
      dataDir,
      custodyKeyPath: join(dataDir, 'custody.key'),
      accountEmailSender: async (to, subject, body, html) => { sentEmails.push({ to, subject, body, html }); },
      notificationClock: () => new Date('2026-11-11T02:00:00.000Z'), // 10:00 Asia/Shanghai
    });
    await server.ready;
    await server.started;
    await new Promise<void>((resolve) => server.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;

    try {
      await registerAccount(url, 'owner', 'owner-pass-01', { ownerSetupToken: OWNER_SETUP_TOKEN });
      await registerAccount(url, 'bob', 'bob-pass-01');
      const bob = await loginAccount(url, 'bob', 'bob-pass-01', { deviceId: 'bob-dev-1', deviceName: 'Bob' });
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.accessToken}` };

      await fetch(`${url}/api/auth/email/request`, { method: 'POST', headers, body: JSON.stringify({ email: 'bob@example.com' }) });
      const code = /(\d{8})/.exec(sentEmails.at(-1)?.body ?? '')![1]!;
      await fetch(`${url}/api/auth/email/verify`, { method: 'POST', headers, body: JSON.stringify({ code }) });
      sentEmails.length = 0;

      const init = await fetch(`${url}/api/v3/protection/initialize`, { method: 'POST', headers, body: JSON.stringify({ mode: 'managed' }) });
      const protection = await init.json() as { secret: string; envelope: { ledgerId: string } & Record<string, unknown> };
      const session = await unlockLedgerKeyEnvelope(protection.secret, protection.envelope as never);

      const author = await openLedger({ deviceId: 'BOB-AUTHOR' });
      try {
        await author.adoptLedgerId(protection.envelope.ledgerId);
        const cny: Asset = { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, symbol: '¥', isActive: true } as Asset;
        await author.assets.put(cny);
        const incParent: Category = { id: 'income_work', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '工作收入', type: 'income', isActive: true } as Category;
        const incSalary: Category = { id: 'salary', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '工资', type: 'income', parentId: incParent.id, isActive: true } as Category;
        const expParent: Category = { id: 'expense_food', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '餐饮', type: 'expense', isActive: true } as Category;
        const expLeaf: Category = { id: 'food', createdAt: '', updatedAt: '', version: 1, isDeleted: false, name: '堂食', type: 'expense', parentId: expParent.id, isActive: true } as Category;
        await author.categories.put(incParent);
        await author.categories.put(incSalary);
        await author.categories.put(expParent);
        await author.categories.put(expLeaf);

        // Two salary dates (Oct 9 early due to weekend -> Nov 10) + one expense in between
        await author.transactions.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, date: '2026-10-09', type: 'income', assetId: cny.id, amount: '15000.00', category: incSalary.id } as Transaction);
        await author.transactions.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, date: '2026-10-22', type: 'expense', assetId: cny.id, amount: '320.00', category: expLeaf.id, note: '烧烤' } as Transaction);
        await author.transactions.put({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false, date: '2026-11-10', type: 'income', assetId: cny.id, amount: '15000.00', category: incSalary.id } as Transaction);

        await fetch(`${url}/api/v3/replica/bind`, { method: 'POST', headers, body: JSON.stringify({ ledgerId: protection.envelope.ledgerId }) });
        await syncReplica(author, httpCommitTransport({ baseUrl: url, token: bob.accessToken, cryptoSession: session, keyEnvelope: protection.envelope as never }), url);
      } finally {
        await author.close();
      }

      await fetch(`${url}/api/auth/notifications`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          timezone: 'Asia/Shanghai',
          emailEnabled: true,
          monthly: { enabled: true, mode: 'payday_auto', paydayDay: 10, hour: 9 },
        }),
      });

      const pass1 = await server.flushUserNotifications();
      expect(pass1).toEqual({ processedUsers: 1, deliveries: 1 });
      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.body).toContain('2026-10-09 至 2026-11-09');
      expect(sentEmails[0]!.body).toContain('¥320.00');
      expect(sentEmails[0]!.html).toContain('智能发薪月');

      // Second pass is idempotent — no duplicate sent for the same salary cycle
      const pass2 = await server.flushUserNotifications();
      expect(pass2).toEqual({ processedUsers: 1, deliveries: 0 });
      expect(sentEmails).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
