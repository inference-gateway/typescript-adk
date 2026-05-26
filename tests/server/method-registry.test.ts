import { describe, expect, it } from 'vitest';
import { MethodRegistry } from '../../src/server/method-registry.js';

describe('MethodRegistry', () => {
  it('registers and retrieves a handler by name', () => {
    const registry = new MethodRegistry();
    const handler = (): string => 'pong';
    registry.register('ping', handler);
    expect(registry.has('ping')).toBe(true);
    expect(registry.get('ping')).toBe(handler);
  });

  it('returns undefined for unknown methods', () => {
    const registry = new MethodRegistry();
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });

  it('overwrites a handler when the same name is registered twice', () => {
    const registry = new MethodRegistry();
    const first = (): number => 1;
    const second = (): number => 2;
    registry.register('m', first);
    registry.register('m', second);
    expect(registry.get('m')).toBe(second);
  });

  it('unregister returns true when a handler was removed', () => {
    const registry = new MethodRegistry();
    registry.register('m', () => 0);
    expect(registry.unregister('m')).toBe(true);
    expect(registry.has('m')).toBe(false);
  });

  it('unregister returns false when no handler existed', () => {
    const registry = new MethodRegistry();
    expect(registry.unregister('nope')).toBe(false);
  });

  it('list returns all registered method names', () => {
    const registry = new MethodRegistry();
    registry.register('a', () => 1);
    registry.register('b', () => 2);
    registry.register('c', () => 3);
    expect(new Set(registry.list())).toEqual(new Set(['a', 'b', 'c']));
  });

  it('clear removes every registered method', () => {
    const registry = new MethodRegistry();
    registry.register('a', () => 1);
    registry.register('b', () => 2);
    registry.clear();
    expect(registry.list()).toEqual([]);
  });

  it('throws when the method name is empty', () => {
    const registry = new MethodRegistry();
    expect(() => registry.register('', () => 0)).toThrow();
  });
});
