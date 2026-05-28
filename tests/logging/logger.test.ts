import { describe, expect, it } from 'vitest';
import {
  NOOP_LOGGER,
  childLogger,
  createLogger,
  type Logger,
} from '../../src/logging/index.js';

interface LogLine {
  level: number;
  msg: string;
  [field: string]: unknown;
}

function captureLines(): {
  stream: { write: (chunk: string) => void };
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  return {
    stream: {
      write(chunk: string): void {
        for (const part of chunk.split('\n')) {
          if (part.length === 0) continue;
          lines.push(JSON.parse(part) as LogLine);
        }
      },
    },
    lines,
  };
}

const LEVEL = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
} as const;

describe('NOOP_LOGGER', () => {
  it('is frozen and exposes the four required methods', () => {
    expect(Object.isFrozen(NOOP_LOGGER)).toBe(true);
    expect(typeof NOOP_LOGGER.debug).toBe('function');
    expect(typeof NOOP_LOGGER.info).toBe('function');
    expect(typeof NOOP_LOGGER.warn).toBe('function');
    expect(typeof NOOP_LOGGER.error).toBe('function');
  });

  it('child() returns itself - calls become a no-op chain', () => {
    const child = NOOP_LOGGER.child?.({ requestId: 'r1' });
    expect(child).toBe(NOOP_LOGGER);
  });

  it('does not throw when called', () => {
    expect(() => NOOP_LOGGER.info('hello', { x: 1 })).not.toThrow();
  });
});

describe('childLogger helper', () => {
  it('returns a child via .child() when the logger supports it', () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const fake: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child(bindings) {
        calls.push(bindings);
        return fake;
      },
    };
    const result = childLogger(fake, { requestId: 'r1' });
    expect(result).toBe(fake);
    expect(calls).toEqual([{ requestId: 'r1' }]);
  });

  it('falls back to the original logger when child() is absent', () => {
    const fake: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const result = childLogger(fake, { requestId: 'r1' });
    expect(result).toBe(fake);
  });
});

describe('createLogger - level selection', () => {
  it("defaults to 'info' when DEBUG is not set", () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    logger.debug('drop me');
    logger.info('keep me');
    expect(lines.map((l) => l.msg)).toEqual(['keep me']);
  });

  it("raises level to 'debug' when DEBUG is set", () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: { DEBUG: '1' },
      destination: stream,
    });
    logger.debug('keep me');
    logger.info('also keep');
    expect(lines.map((l) => l.msg)).toEqual(['keep me', 'also keep']);
    expect(lines[0]?.level).toBe(LEVEL.debug);
  });

  it("treats DEBUG=false / DEBUG=0 / DEBUG='' as 'not set'", () => {
    for (const value of ['false', '0', '']) {
      const { stream, lines } = captureLines();
      const logger = createLogger({
        pretty: false,
        env: { DEBUG: value },
        destination: stream,
      });
      logger.debug('drop me');
      logger.info('keep me');
      expect(lines.map((l) => l.msg)).toEqual(['keep me']);
    }
  });

  it('explicit options.level overrides DEBUG', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      level: 'warn',
      env: { DEBUG: '1' },
      destination: stream,
    });
    logger.info('drop me');
    logger.warn('keep me');
    expect(lines.map((l) => l.msg)).toEqual(['keep me']);
  });
});

describe('createLogger - structured fields', () => {
  it('merges a plain-object first argument into the log line', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    logger.info('hello', { requestId: 'r1', taskId: 't1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('hello');
    expect(lines[0]?.['requestId']).toBe('r1');
    expect(lines[0]?.['taskId']).toBe('t1');
  });

  it('serializes Error via pino std `err` serializer', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    const err = new Error('boom');
    logger.error('failure', err);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.msg).toBe('failure');
    const errObj = line['err'] as { type?: string; message?: string };
    expect(errObj.type).toBe('Error');
    expect(errObj.message).toBe('boom');
  });

  it('does not merge arrays into the log line as if they were objects', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    logger.info('hello', [1, 2, 3]);
    expect(lines).toHaveLength(1);
    // Array passed as second arg must not be merged as `{ 0: 1, 1: 2, 2: 3 }`
    // and must not show up under a numeric key.
    expect(lines[0]?.['0']).toBeUndefined();
    expect(lines[0]?.['1']).toBeUndefined();
    expect(lines[0]?.['2']).toBeUndefined();
  });

  it('emits messages with no extra args verbatim', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    logger.info('just a message');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('just a message');
  });
});

describe('createLogger - bindings and child loggers', () => {
  it('applies top-level bindings to every line', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      bindings: { service: 'adk' },
      destination: stream,
    });
    logger.info('one');
    logger.info('two', { extra: true });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.['service']).toBe('adk');
    expect(lines[1]?.['service']).toBe('adk');
    expect(lines[1]?.['extra']).toBe(true);
  });

  it('child() returns a logger that includes parent + own bindings', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      bindings: { service: 'adk' },
      destination: stream,
    });
    const reqLogger = logger.child?.({ requestId: 'r1' });
    expect(reqLogger).toBeDefined();
    reqLogger?.info('scoped');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['service']).toBe('adk');
    expect(lines[0]?.['requestId']).toBe('r1');
  });

  it('child() loggers can be further chained for task scope', () => {
    const { stream, lines } = captureLines();
    const logger = createLogger({
      pretty: false,
      env: {},
      destination: stream,
    });
    const taskLogger = logger
      .child?.({ requestId: 'r1' })
      .child?.({ taskId: 't1' });
    taskLogger?.info('task started');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['requestId']).toBe('r1');
    expect(lines[0]?.['taskId']).toBe('t1');
    expect(lines[0]?.msg).toBe('task started');
  });
});
