import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A2AServer,
  AGENT_CARD_PATH,
  HEALTH_PATH,
  REQUEST_ID_HEADER,
  type Logger,
} from '../../src/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'logger-agent',
    description: 'Agent under test',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input back to the caller.',
        tags: [],
      },
    ],
  };
}

async function startServer(
  server: A2AServer
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

function spyLogger(): Logger {
  const child = (): Logger => spyLogger();
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child,
  };
}

describe('A2AServer + logger integration', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('exposes the configured logger via getLogger()', () => {
    const logger = spyLogger();
    const server = new A2AServer({ card: makeCard(), logger });
    expect(server.getLogger()).toBe(logger);
  });

  it('returns NOOP_LOGGER when no logger is configured', () => {
    const server = new A2AServer({ card: makeCard() });
    const logger = server.getLogger();
    expect(typeof logger.info).toBe('function');
    // NOOP_LOGGER.child returns itself.
    expect(logger.child?.({ requestId: 'r1' })).toBe(logger);
  });

  it('echoes an incoming x-request-id on the response', async () => {
    const logger = spyLogger();
    const server = new A2AServer({ card: makeCard(), logger });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`, {
      headers: { [REQUEST_ID_HEADER]: 'integration-test' },
    });
    await res.text();
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('integration-test');
  });

  it('generates a new x-request-id when none is supplied', async () => {
    const logger = spyLogger();
    const server = new A2AServer({ card: makeCard(), logger });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    await res.text();
    const id = res.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });

  it('does not echo x-request-id when no logger is configured', async () => {
    const server = new A2AServer({ card: makeCard() });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    await res.text();
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeNull();
  });

  it('still echoes x-request-id on /health even though it is not logged', async () => {
    const logger = spyLogger();
    const server = new A2AServer({ card: makeCard(), logger });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
    await res.text();
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/[0-9a-f-]{36}/);
  });
});
