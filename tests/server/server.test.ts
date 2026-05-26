import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  A2AServer,
  AGENT_CARD_PATH,
  DEFAULT_AGENT_CARD_CACHE_CONTROL,
  createA2AServer,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'discovery-agent',
    description: 'Agent under test',
    version: '1.2.3',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: true },
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input back to the caller.',
      },
    ],
    ...overrides,
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
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => server.close(),
  };
}

describe('A2AServer agent card discovery', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('serves the public agent card as JSON on /.well-known/agent-card.json', async () => {
    const card = makeCard();
    const server = createA2AServer({ card });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const body = (await res.json()) as AgentCard;
    expect(body).toEqual(card);
  });

  it('sets the default Cache-Control header', async () => {
    const server = createA2AServer({ card: makeCard() });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    await res.text();
    expect(res.headers.get('cache-control')).toBe(
      DEFAULT_AGENT_CARD_CACHE_CONTROL
    );
  });

  it('allows the Cache-Control header to be overridden via config', async () => {
    const override = 'public, max-age=300';
    const server = createA2AServer({
      card: makeCard(),
      cacheControl: override,
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    await res.text();
    expect(res.headers.get('cache-control')).toBe(override);
  });

  it('ignores a query string on the discovery path', async () => {
    const card = makeCard();
    const server = createA2AServer({ card });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}?nocache=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentCard;
    expect(body.name).toBe(card.name);
  });

  it('returns 404 for unknown paths', async () => {
    const server = createA2AServer({ card: makeCard() });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('returns 404 for non-GET methods on the discovery path', async () => {
    const server = createA2AServer({ card: makeCard() });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('round-trips a card containing skills and capabilities verbatim', async () => {
    const card = makeCard({
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: [
        {
          id: 'summarize',
          name: 'Summarize',
          description: 'Summarize a block of text.',
        },
        {
          id: 'translate',
          name: 'Translate',
          description: 'Translate text between languages.',
        },
      ],
    });
    const server = createA2AServer({ card });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentCard;
    expect(body).toEqual(card);
  });
});

describe('A2AServer lifecycle', () => {
  let server: A2AServer | undefined;

  beforeEach(() => {
    server = undefined;
  });

  afterEach(async () => {
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        // server was already closed or never started
      }
    }
  });

  it('reports its listening address after listen() resolves', async () => {
    server = createA2AServer({ card: makeCard() });
    expect(server.address()).toBeNull();

    await server.listen(0, '127.0.0.1');
    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(addr?.port).toBeGreaterThan(0);
  });

  it('rejects from listen() when the port is already in use', async () => {
    const first = createA2AServer({ card: makeCard() });
    await first.listen(0, '127.0.0.1');
    const port = first.address()?.port ?? 0;
    expect(port).toBeGreaterThan(0);

    const second = createA2AServer({ card: makeCard() });
    server = second;
    await expect(second.listen(port, '127.0.0.1')).rejects.toThrow();

    await first.close();
  });

  it('stops accepting new connections after close()', async () => {
    server = createA2AServer({ card: makeCard() });
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    await server.close();

    const url = `http://127.0.0.1:${port}${AGENT_CARD_PATH}`;
    await expect(fetch(url)).rejects.toThrow();
    server = undefined;
  });
});
