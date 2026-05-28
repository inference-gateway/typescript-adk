import { describe, expect, it } from 'vitest';
import { createTask } from '../../src/agent/task.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe('InMemoryTaskStorage - push notification configs', () => {
  describe('setPushConfig', () => {
    it('stores a config with the supplied id', () => {
      const storage = new InMemoryTaskStorage();
      const stored = storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com/webhook',
      });

      expect(stored.id).toBe('cfg-1');
      expect(stored.url).toBe('https://example.com/webhook');
      expect(storage.getPushConfig('task-1', 'cfg-1')).toEqual(stored);
    });

    it('assigns a UUID when id is missing', () => {
      const storage = new InMemoryTaskStorage();
      const stored = storage.setPushConfig('task-1', {
        url: 'https://example.com/webhook',
      });

      expect(stored.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(storage.getPushConfig('task-1', stored.id)).toEqual(stored);
    });

    it('assigns a UUID when id is the empty string', () => {
      const storage = new InMemoryTaskStorage();
      const stored = storage.setPushConfig('task-1', {
        id: '',
        url: 'https://example.com/webhook',
      });
      expect(stored.id.length).toBeGreaterThan(0);
      expect(stored.id).not.toBe('');
    });

    it('replaces an existing config with the same id', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com/v1',
      });
      const replaced = storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com/v2',
        token: 'secret',
      });

      expect(replaced.url).toBe('https://example.com/v2');
      expect(replaced.token).toBe('secret');
      expect(storage.listPushConfigs('task-1')).toEqual([replaced]);
    });

    it('keeps configs for different tasks isolated', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://a.example.com',
      });
      storage.setPushConfig('task-2', {
        id: 'cfg-1',
        url: 'https://b.example.com',
      });

      expect(storage.getPushConfig('task-1', 'cfg-1')?.url).toBe(
        'https://a.example.com'
      );
      expect(storage.getPushConfig('task-2', 'cfg-1')?.url).toBe(
        'https://b.example.com'
      );
    });

    it('round-trips token and authentication fields', () => {
      const storage = new InMemoryTaskStorage();
      const stored = storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com/webhook',
        token: 'bearer-xyz',
        authentication: {
          schemes: ['Bearer'],
          credentials: 'secret-credentials',
        },
      });

      expect(stored.token).toBe('bearer-xyz');
      expect(stored.authentication).toEqual({
        schemes: ['Bearer'],
        credentials: 'secret-credentials',
      });
    });
  });

  describe('getPushConfig', () => {
    it('returns undefined for an unknown task', () => {
      const storage = new InMemoryTaskStorage();
      expect(storage.getPushConfig('missing-task', 'cfg-1')).toBeUndefined();
    });

    it('returns undefined for an unknown config id under a known task', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com',
      });
      expect(storage.getPushConfig('task-1', 'cfg-other')).toBeUndefined();
    });
  });

  describe('listPushConfigs', () => {
    it('returns an empty array for an unknown task', () => {
      const storage = new InMemoryTaskStorage();
      expect(storage.listPushConfigs('missing-task')).toEqual([]);
    });

    it('returns every config registered under the task', () => {
      const storage = new InMemoryTaskStorage();
      const a = storage.setPushConfig('task-1', {
        id: 'cfg-a',
        url: 'https://a.example.com',
      });
      const b = storage.setPushConfig('task-1', {
        id: 'cfg-b',
        url: 'https://b.example.com',
      });

      const listed = storage.listPushConfigs('task-1');
      expect(listed).toHaveLength(2);
      expect(listed).toContainEqual(a);
      expect(listed).toContainEqual(b);
    });

    it('returns a fresh array that does not alias storage state', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com',
      });
      const listed = storage.listPushConfigs('task-1');
      listed.pop();
      expect(storage.listPushConfigs('task-1')).toHaveLength(1);
    });
  });

  describe('deletePushConfig', () => {
    it('returns true and removes the config when it exists', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com',
      });
      expect(storage.deletePushConfig('task-1', 'cfg-1')).toBe(true);
      expect(storage.getPushConfig('task-1', 'cfg-1')).toBeUndefined();
      expect(storage.listPushConfigs('task-1')).toEqual([]);
    });

    it('returns false for an unknown task', () => {
      const storage = new InMemoryTaskStorage();
      expect(storage.deletePushConfig('missing-task', 'cfg-1')).toBe(false);
    });

    it('returns false for an unknown config id under a known task', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com',
      });
      expect(storage.deletePushConfig('task-1', 'cfg-other')).toBe(false);
      expect(storage.getPushConfig('task-1', 'cfg-1')).toBeDefined();
    });

    it('leaves other configs intact when deleting one of several', () => {
      const storage = new InMemoryTaskStorage();
      storage.setPushConfig('task-1', {
        id: 'cfg-a',
        url: 'https://a.example.com',
      });
      storage.setPushConfig('task-1', {
        id: 'cfg-b',
        url: 'https://b.example.com',
      });

      expect(storage.deletePushConfig('task-1', 'cfg-a')).toBe(true);
      expect(storage.listPushConfigs('task-1').map((c) => c.id)).toEqual([
        'cfg-b',
      ]);
    });
  });

  describe('deleteContext cascade', () => {
    it('removes push configs for every task in the deleted context', () => {
      const storage = new InMemoryTaskStorage();
      const task = createTask({
        id: 'task-1',
        contextId: 'ctx-1',
        now: fixedClock('2026-05-26T12:00:00.000Z'),
      });
      storage.enqueue(task);
      storage.setPushConfig('task-1', {
        id: 'cfg-1',
        url: 'https://example.com',
      });

      storage.deleteContext('ctx-1');

      expect(storage.listPushConfigs('task-1')).toEqual([]);
      expect(storage.getPushConfig('task-1', 'cfg-1')).toBeUndefined();
    });
  });
});
