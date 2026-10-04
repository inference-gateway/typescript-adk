import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentCardValidationError } from '../../src/agent/card.js';
import { createTask } from '../../src/agent/task.js';
import {
  USAGE_EXTENSION_URI,
  USAGE_METADATA_KEY,
  withUsageExtension,
} from '../../src/agent/usage-extension.js';
import {
  A2AServer,
  AGENT_CARD_PATH,
  DEFAULT_AGENT_CARD_CACHE_CONTROL,
  JSONRPC_ERROR_CODES,
  TASK_GET_METHOD,
  createA2AServer,
  createTaskGetHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'discovery-agent',
    description: 'Agent under test',
    version: '1.2.3',
    supportedInterfaces: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: true },
    skills: [
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input back to the caller.',
        tags: [],
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

  it('sends ETag and Last-Modified and answers a matching If-None-Match with 304', async () => {
    const server = createA2AServer({ card: makeCard() });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const first = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    await first.text();
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('last-modified')).toBeTruthy();

    const revalidated = await fetch(`${baseUrl}${AGENT_CARD_PATH}`, {
      headers: { 'If-None-Match': etag ?? '' },
    });
    await revalidated.text();
    expect(revalidated.status).toBe(304);
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

  it.each([
    ['agent card', (card: AgentCard) => ({ card })],
    [
      'extended agent card',
      (card: AgentCard) => ({ card: makeCard(), extendedCard: card }),
    ],
  ])('refuses an %s whose interface url carries credentials', (_, config) => {
    const card = makeCard({
      supportedInterfaces: [
        {
          url: 'https://user:s3cret@agent.example.com/a2a',
          protocolBinding: 'JSONRPC',
          protocolVersion: '1.0',
        },
      ],
    });
    expect(() => createA2AServer(config(card))).toThrow(
      expect.objectContaining({
        name: AgentCardValidationError.name,
        field: 'supportedInterfaces[0].url',
        message: expect.not.stringContaining('s3cret'),
      })
    );
  });

  it('round-trips a card containing skills and capabilities verbatim', async () => {
    const card = makeCard({
      capabilities: {
        streaming: true,
        pushNotifications: false,
      },
      skills: [
        {
          id: 'summarize',
          name: 'Summarize',
          description: 'Summarize a block of text.',
          tags: [],
        },
        {
          id: 'translate',
          name: 'Translate',
          description: 'Translate text between languages.',
          tags: [],
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

describe('A2AServer A2A-Version negotiation', () => {
  it.each([
    ['1.0', undefined],
    ['', undefined],
    [undefined, undefined],
    ['0.3', JSONRPC_ERROR_CODES.VERSION_NOT_SUPPORTED_ERROR],
    ['2.0', JSONRPC_ERROR_CODES.VERSION_NOT_SUPPORTED_ERROR],
  ])('A2A-Version %j answers with error code %j', async (version, code) => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod('Ping', () => 'pong');
    const { baseUrl, close } = await startServer(server);
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(version !== undefined ? { 'A2A-Version': version } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'Ping' }),
      });
      const body = (await res.json()) as {
        id: number;
        error?: { code: number };
      };
      expect(body.id).toBe(7);
      expect(body.error?.code).toBe(code);
    } finally {
      await close();
    }
  });
});

describe('A2AServer JSON-RPC path', () => {
  it('dispatches POST <jsonRpcPath>/ like POST <jsonRpcPath>', async () => {
    const server = createA2AServer({ card: makeCard(), jsonRpcPath: '/a2a' });
    server.registerMethod('Ping', () => 'pong');
    const { baseUrl, close } = await startServer(server);
    try {
      const res = await fetch(`${baseUrl}/a2a/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'Ping' }),
      });
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: 'pong',
      });
    } finally {
      await close();
    }
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

describe('A2AServer usage extension', () => {
  it.each([
    ['not requested', true, undefined, false],
    ['requested alone', true, USAGE_EXTENSION_URI, true],
    [
      'requested in a list',
      true,
      `https://example.com/ext/other/v1, ${USAGE_EXTENSION_URI}`,
      true,
    ],
    ['only another extension', true, 'https://example.com/ext/other/v1', false],
    ['requested but not declared', false, USAGE_EXTENSION_URI, false],
  ])(
    '%s: GetTask returns usage only when the extension is active',
    async (_name, declared, header, active) => {
      const storage = new InMemoryTaskStorage();
      storage.storeDeadLetter(
        createTask({
          id: 'usage-task',
          contextId: 'ctx-1',
          metadata: { [USAGE_METADATA_KEY]: { prompt_tokens: 7 }, other: true },
        })
      );
      const card = declared ? withUsageExtension(makeCard()) : makeCard();
      const server = createA2AServer({ card });
      server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
      const { baseUrl, close } = await startServer(server);
      try {
        const res = await fetch(`${baseUrl}/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(header !== undefined ? { 'A2A-Extensions': header } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: TASK_GET_METHOD,
            params: { id: 'usage-task' },
          }),
        });
        const body = (await res.json()) as {
          result: { metadata?: Record<string, unknown> };
        };

        expect(body.result.metadata?.[USAGE_METADATA_KEY] !== undefined).toBe(
          active
        );
        expect(body.result.metadata?.['other']).toBe(true);
        expect(res.headers.get('A2A-Extensions')).toBe(
          active ? USAGE_EXTENSION_URI : null
        );
        expect(
          storage.getTask('usage-task')?.metadata?.[USAGE_METADATA_KEY]
        ).toBeDefined();
      } finally {
        await close();
      }
    }
  );
});
