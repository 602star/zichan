import { describe, expect, it } from 'vitest';
import { newId, type Payee, type Category } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { exportLedger, importLedger, memoryCommitTransport, syncReplica } from '../src/index.js';

const base = () => ({ id: newId(), version: 1, createdAt: '', updatedAt: '', isDeleted: false });
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

describe('entity icon persistence', () => {
  it('syncs uploaded icons, preserves them in exports, and propagates reset', async () => {
    const a = await openLedger({ deviceId: 'icon-a' });
    const b = await openLedger({ deviceId: 'icon-b' });
    const restored = await openLedger();
    try {
      await b.adoptLedgerId(await a.getLedgerId());
      const payee = await a.payees.put({ ...base(), name: '图标商家', icon: image, isActive: true } as Payee);
      const category = await a.categories.put({ ...base(), name: '图标分类', type: 'expense', icon: image, isActive: true } as Category);
      const transport = memoryCommitTransport();
      await syncReplica(a, transport, 'memory');
      expect(await syncReplica(b, transport, 'memory')).toMatchObject({ invalid: 0, conflicts: 0 });
      expect((await b.payees.get(payee.id))?.icon).toBe(image);
      expect((await b.categories.get(category.id))?.icon).toBe(image);
      await importLedger(restored, await exportLedger(a));
      expect((await restored.payees.get(payee.id))?.icon).toBe(image);
      expect((await restored.categories.get(category.id))?.icon).toBe(image);
      await a.payees.put({ ...payee, icon: '' });
      await a.categories.put({ ...category, icon: 'lucide:coffee' });
      await syncReplica(a, transport, 'memory');
      expect((await a.payees.get(payee.id))?.icon).toBe('');
      expect(await syncReplica(b, transport, 'memory')).toMatchObject({ invalid: 0, conflicts: 0 });
      expect((await b.payees.get(payee.id))?.icon).toBe('');
      expect((await b.categories.get(category.id))?.icon).toBe('lucide:coffee');
    } finally { await a.close(); await b.close(); await restored.close(); }
  });

  it('rejects remote URLs, SVG, and oversized image values without changing saved data', async () => {
    const store = await openLedger();
    try {
      const payee = await store.payees.put({ ...base(), name: '安全商家', isActive: true } as Payee);
      for (const icon of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${'A'.repeat(33000)}`]) {
        await expect(store.payees.put({ ...payee, icon })).rejects.toThrow('图标');
      }
      expect((await store.payees.get(payee.id))?.icon).toBeUndefined();
    } finally { await store.close(); }
  });
});
