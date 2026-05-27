import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPE,
  TaskEventBus,
  TaskEventBusRegistry,
  type CloudEvent,
} from '../../src/server/index.js';

function makeStatusEvent(id: string): CloudEvent {
  return {
    specversion: '1.0',
    id,
    source: 'test',
    type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
    data: { taskId: 'task-1' },
  };
}

function makeDeltaEvent(id: string): CloudEvent {
  return {
    specversion: '1.0',
    id,
    source: 'test',
    type: AGENT_EVENT_TYPE.DELTA,
    data: { chunk: id },
  };
}

describe('TaskEventBus', () => {
  it('delivers events to every subscribed listener in subscription order', () => {
    const bus = new TaskEventBus();
    const received: Array<{ subscriber: string; id: string }> = [];

    bus.subscribe(
      (e) => received.push({ subscriber: 'a', id: e.id }),
      () => {
        // close
      }
    );
    bus.subscribe(
      (e) => received.push({ subscriber: 'b', id: e.id }),
      () => {
        // close
      }
    );

    bus.publish(makeDeltaEvent('evt-1'));
    bus.publish(makeDeltaEvent('evt-2'));

    expect(received).toEqual([
      { subscriber: 'a', id: 'evt-1' },
      { subscriber: 'b', id: 'evt-1' },
      { subscriber: 'a', id: 'evt-2' },
      { subscriber: 'b', id: 'evt-2' },
    ]);
  });

  it('buffers only the most recent task.status.changed event for replay', () => {
    const bus = new TaskEventBus();
    expect(bus.lastStatus).toBeUndefined();

    bus.publish(makeStatusEvent('status-1'));
    expect(bus.lastStatus?.id).toBe('status-1');

    bus.publish(makeDeltaEvent('delta-1'));
    expect(bus.lastStatus?.id).toBe('status-1');

    bus.publish(makeStatusEvent('status-2'));
    expect(bus.lastStatus?.id).toBe('status-2');
  });

  it('hands the current replay buffer to new subscribers via the subscription handle', () => {
    const bus = new TaskEventBus();
    bus.publish(makeStatusEvent('status-1'));

    const subscription = bus.subscribe(
      () => {
        // event
      },
      () => {
        // close
      }
    );
    expect(subscription.lastStatus?.id).toBe('status-1');
  });

  it('unsubscribe removes the listener from future publishes', () => {
    const bus = new TaskEventBus();
    const received: string[] = [];
    const subscription = bus.subscribe(
      (e) => received.push(e.id),
      () => {
        // close
      }
    );

    bus.publish(makeDeltaEvent('evt-1'));
    subscription.unsubscribe();
    bus.publish(makeDeltaEvent('evt-2'));

    expect(received).toEqual(['evt-1']);
  });

  it('isolates a faulting listener so other listeners keep receiving events', () => {
    const bus = new TaskEventBus();
    const received: string[] = [];

    bus.subscribe(
      () => {
        throw new Error('boom');
      },
      () => {
        // close
      }
    );
    bus.subscribe(
      (e) => received.push(e.id),
      () => {
        // close
      }
    );

    bus.publish(makeDeltaEvent('evt-1'));
    bus.publish(makeDeltaEvent('evt-2'));
    expect(received).toEqual(['evt-1', 'evt-2']);
  });

  it('close() notifies every subscriber and ignores subsequent publishes', () => {
    const bus = new TaskEventBus();
    const closed: string[] = [];
    const received: string[] = [];

    bus.subscribe(
      (e) => received.push(e.id),
      () => closed.push('a')
    );
    bus.subscribe(
      (e) => received.push(e.id),
      () => closed.push('b')
    );

    bus.publish(makeDeltaEvent('evt-1'));
    expect(received).toHaveLength(2);

    bus.close();
    expect(closed).toEqual(['a', 'b']);
    expect(bus.closed).toBe(true);

    bus.publish(makeDeltaEvent('evt-2'));
    expect(received).toHaveLength(2);
  });

  it('close() is idempotent', () => {
    const bus = new TaskEventBus();
    const closed: number[] = [];
    bus.subscribe(
      () => {
        // event
      },
      () => closed.push(1)
    );

    bus.close();
    bus.close();
    bus.close();
    expect(closed).toEqual([1]);
  });

  it('subscribe() on a closed bus immediately invokes onClose and exposes the final replay buffer', () => {
    const bus = new TaskEventBus();
    bus.publish(makeStatusEvent('status-1'));
    bus.close();

    let closeCalled = false;
    const subscription = bus.subscribe(
      () => {
        // event
      },
      () => {
        closeCalled = true;
      }
    );

    expect(closeCalled).toBe(true);
    expect(subscription.lastStatus?.id).toBe('status-1');
    expect(() => subscription.unsubscribe()).not.toThrow();
  });

  it('listenerCount reflects the current subscriber count', () => {
    const bus = new TaskEventBus();
    expect(bus.listenerCount).toBe(0);
    const a = bus.subscribe(
      () => {
        // event
      },
      () => {
        // close
      }
    );
    const b = bus.subscribe(
      () => {
        // event
      },
      () => {
        // close
      }
    );
    expect(bus.listenerCount).toBe(2);
    a.unsubscribe();
    expect(bus.listenerCount).toBe(1);
    b.unsubscribe();
    expect(bus.listenerCount).toBe(0);
  });
});

describe('TaskEventBusRegistry', () => {
  it('getOrCreate returns the same bus on subsequent calls for the same id', () => {
    const registry = new TaskEventBusRegistry();
    const a = registry.getOrCreate('task-1');
    const b = registry.getOrCreate('task-1');
    expect(a).toBe(b);
  });

  it('get returns undefined for unknown task ids', () => {
    const registry = new TaskEventBusRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('delete removes a registered bus without closing it', () => {
    const registry = new TaskEventBusRegistry();
    const bus = registry.getOrCreate('task-1');
    expect(registry.has('task-1')).toBe(true);
    expect(registry.delete('task-1')).toBe(true);
    expect(registry.has('task-1')).toBe(false);
    expect(bus.closed).toBe(false);
    expect(registry.delete('task-1')).toBe(false);
  });

  it('size reports the number of registered buses', () => {
    const registry = new TaskEventBusRegistry();
    expect(registry.size()).toBe(0);
    registry.getOrCreate('task-1');
    registry.getOrCreate('task-2');
    expect(registry.size()).toBe(2);
    registry.delete('task-1');
    expect(registry.size()).toBe(1);
  });

  it('clear() drops every bus without closing them', () => {
    const registry = new TaskEventBusRegistry();
    const a = registry.getOrCreate('task-1');
    const b = registry.getOrCreate('task-2');
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
  });
});
