import { describe, expect, it } from 'vitest';
import { TaskCancellationRegistry } from '../../src/server/task-cancellation.js';

describe('TaskCancellationRegistry', () => {
  it('reports zero size and no membership before any registration', () => {
    const registry = new TaskCancellationRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.has('task-1')).toBe(false);
  });

  it('register adds the controller and exposes it via has/size', () => {
    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    expect(registry.has('task-1')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('register replaces the prior controller for the same task id', () => {
    const registry = new TaskCancellationRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.register('task-1', first);
    registry.register('task-1', second);

    expect(registry.size()).toBe(1);
    registry.cancel('task-1');

    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it('unregister drops the controller without aborting it', () => {
    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    expect(registry.unregister('task-1')).toBe(true);
    expect(registry.has('task-1')).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it('unregister returns false for unknown task ids', () => {
    const registry = new TaskCancellationRegistry();
    expect(registry.unregister('missing')).toBe(false);
  });

  it('cancel aborts the registered controller and drops it from the registry', () => {
    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    const reason = new Error('user cancelled');
    expect(registry.cancel('task-1', reason)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
    expect(registry.has('task-1')).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it('cancel returns false when no controller is registered for the id', () => {
    const registry = new TaskCancellationRegistry();
    expect(registry.cancel('task-missing')).toBe(false);
  });

  it('cancel can be invoked without a reason', () => {
    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    expect(registry.cancel('task-1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('clear drops every controller without aborting them', () => {
    const registry = new TaskCancellationRegistry();
    const a = new AbortController();
    const b = new AbortController();
    registry.register('task-a', a);
    registry.register('task-b', b);

    registry.clear();

    expect(registry.size()).toBe(0);
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
  });

  it('cancel of a different task does not affect another registered controller', () => {
    const registry = new TaskCancellationRegistry();
    const a = new AbortController();
    const b = new AbortController();
    registry.register('task-a', a);
    registry.register('task-b', b);

    registry.cancel('task-a');

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(registry.has('task-a')).toBe(false);
    expect(registry.has('task-b')).toBe(true);
  });
});
