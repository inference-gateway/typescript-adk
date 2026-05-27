import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPE,
  CLOUDEVENTS_CONTENT_TYPE,
  CLOUDEVENTS_SPEC_VERSION,
  DEFAULT_AGENT_EVENT_SOURCE,
  DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE,
  createCloudEvent,
} from '../../src/server/cloudevents.js';

describe('AGENT_EVENT_TYPE constants', () => {
  it('matches the Go ADK adk.agent.* event-type set verbatim', () => {
    expect(AGENT_EVENT_TYPE).toEqual({
      DELTA: 'adk.agent.delta',
      ITERATION_COMPLETED: 'adk.agent.iteration.completed',
      TOOL_STARTED: 'adk.agent.tool.started',
      TOOL_COMPLETED: 'adk.agent.tool.completed',
      TOOL_FAILED: 'adk.agent.tool.failed',
      TOOL_RESULT: 'adk.agent.tool.result',
      INPUT_REQUIRED: 'adk.agent.input.required',
      TASK_STATUS_CHANGED: 'adk.agent.task.status.changed',
      TASK_INTERRUPTED: 'adk.agent.task.interrupted',
      STREAM_FAILED: 'adk.agent.stream.failed',
    });
  });

  it('exposes the canonical CloudEvents v1.0 media type constant', () => {
    expect(CLOUDEVENTS_CONTENT_TYPE).toBe('application/cloudevents+json');
    expect(CLOUDEVENTS_SPEC_VERSION).toBe('1.0');
    expect(DEFAULT_AGENT_EVENT_SOURCE).toBe('adk/agent');
    expect(DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE).toBe('application/json');
  });
});

describe('createCloudEvent', () => {
  it('builds a complete v1.0 envelope with sane defaults', () => {
    const before = Date.now();
    const event = createCloudEvent({
      type: AGENT_EVENT_TYPE.DELTA,
      data: { content: 'hello' },
    });
    const after = Date.now();

    expect(event.specversion).toBe('1.0');
    expect(event.type).toBe('adk.agent.delta');
    expect(event.source).toBe(DEFAULT_AGENT_EVENT_SOURCE);
    expect(event.datacontenttype).toBe(DEFAULT_CLOUDEVENTS_DATA_CONTENT_TYPE);
    expect(event.data).toEqual({ content: 'hello' });

    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);

    const timestamp = Date.parse(event.time as string);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves caller-supplied id, source, time, subject, and datacontenttype', () => {
    const event = createCloudEvent({
      id: 'evt-1',
      source: 'urn:test:source',
      type: AGENT_EVENT_TYPE.ITERATION_COMPLETED,
      data: { iteration: 3 },
      time: '2026-05-26T12:00:00.000Z',
      subject: 'tasks/abc',
      datacontenttype: 'application/vnd.example+json',
    });

    expect(event).toMatchObject({
      specversion: '1.0',
      id: 'evt-1',
      source: 'urn:test:source',
      type: 'adk.agent.iteration.completed',
      time: '2026-05-26T12:00:00.000Z',
      subject: 'tasks/abc',
      datacontenttype: 'application/vnd.example+json',
      data: { iteration: 3 },
    });
  });

  it('converts a Date instance to RFC 3339', () => {
    const event = createCloudEvent({
      type: AGENT_EVENT_TYPE.DELTA,
      data: null,
      time: new Date('2026-05-26T12:00:00.000Z'),
    });
    expect(event.time).toBe('2026-05-26T12:00:00.000Z');
  });

  it('omits subject when not supplied', () => {
    const event = createCloudEvent({
      type: AGENT_EVENT_TYPE.DELTA,
      data: null,
    });
    expect('subject' in event).toBe(false);
  });

  it('serialises extensions as top-level JSON members', () => {
    const event = createCloudEvent({
      type: AGENT_EVENT_TYPE.ITERATION_COMPLETED,
      data: { iteration: 2 },
      extensions: { iteration: 2, taskid: 'task-1' },
    });

    const parsed = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    expect(parsed['iteration']).toBe(2);
    expect(parsed['taskid']).toBe('task-1');
    expect(parsed['specversion']).toBe('1.0');
    expect(parsed['type']).toBe('adk.agent.iteration.completed');
  });

  it('rejects extensions that collide with a reserved CE attribute name', () => {
    expect(() =>
      createCloudEvent({
        type: AGENT_EVENT_TYPE.DELTA,
        data: null,
        extensions: { specversion: '2.0' as unknown as string },
      })
    ).toThrow(/reserved/);
    expect(() =>
      createCloudEvent({
        type: AGENT_EVENT_TYPE.DELTA,
        data: null,
        extensions: { data: 'oops' },
      })
    ).toThrow(/reserved/);
  });

  it('throws when type is empty', () => {
    expect(() => createCloudEvent({ type: '', data: null })).toThrow(/type/);
  });

  it('throws when source is explicitly empty', () => {
    expect(() =>
      createCloudEvent({ type: AGENT_EVENT_TYPE.DELTA, data: null, source: '' })
    ).toThrow(/source/);
  });

  it('throws when id is explicitly empty', () => {
    expect(() =>
      createCloudEvent({ type: AGENT_EVENT_TYPE.DELTA, data: null, id: '' })
    ).toThrow(/id/);
  });

  it('serialises a structured-mode envelope to canonical JSON', () => {
    const event = createCloudEvent({
      id: 'evt-1',
      type: AGENT_EVENT_TYPE.DELTA,
      data: { text: 'chunk' },
      time: '2026-05-26T12:00:00.000Z',
    });
    const json = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    expect(json).toEqual({
      specversion: '1.0',
      id: 'evt-1',
      source: 'adk/agent',
      type: 'adk.agent.delta',
      time: '2026-05-26T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: { text: 'chunk' },
    });
  });
});
