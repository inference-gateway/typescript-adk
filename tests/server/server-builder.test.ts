import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A2AServer,
  A2AServerBuilder,
  A2AServerBuilderError,
  MESSAGE_SEND_METHOD,
  MESSAGE_STREAM_METHOD,
  NOOP_LOGGER,
  TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
  type BackgroundTaskHandler,
  type Logger,
  type OpenAICompatibleAgent,
  type StreamingTaskHandler,
  type TaskResultProcessor,
} from '../../src/server/index.js';
import {
  DefaultArtifactService,
  InMemoryArtifactStorage,
  type ArtifactService,
} from '../../src/artifacts/index.js';
import { InMemoryTaskStorage } from '../../src/storage/in-memory.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function backgroundCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'background-agent',
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
    ...overrides,
  };
}

function streamingCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return backgroundCard({
    name: 'streaming-agent',
    capabilities: { streaming: true },
    ...overrides,
  });
}

const noopBackgroundHandler: BackgroundTaskHandler = ({ task }) => task;

const noopStreamingHandler: StreamingTaskHandler = async function* () {
  // never yields
};

describe('A2AServerBuilder constructor', () => {
  it('accepts an empty config and falls back to NOOP_LOGGER', () => {
    const builder = new A2AServerBuilder({});
    expect(builder.getLogger()).toBe(NOOP_LOGGER);
    expect(builder.getAgentCard()).toBeUndefined();
    expect(builder.getBackgroundTaskHandler()).toBeUndefined();
    expect(builder.getStreamingTaskHandler()).toBeUndefined();
  });

  it('accepts a logger as the second positional argument', () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const builder = new A2AServerBuilder({}, logger);
    expect(builder.getLogger()).toBe(logger);
  });

  it('preserves the storage override for use during build()', () => {
    const storage = new InMemoryTaskStorage();
    const builder = new A2AServerBuilder({ storage })
      .withAgentCard(backgroundCard())
      .withBackgroundTaskHandler(noopBackgroundHandler);
    const server = builder.build();
    expect(server).toBeInstanceOf(A2AServer);
  });
});

describe('A2AServerBuilder fluent chaining', () => {
  it('returns the same instance from every with* method', () => {
    const builder = new A2AServerBuilder({});
    const after = builder
      .withAgentCard(backgroundCard())
      .withBackgroundTaskHandler(noopBackgroundHandler)
      .withTaskResultProcessor({ process: (t) => t })
      .withAgent({ id: 'gpt-4' })
      .withArtifactService(
        new DefaultArtifactService({ storage: new InMemoryArtifactStorage() })
      )
      .withLogger(NOOP_LOGGER);
    expect(after).toBe(builder);
  });

  it('stores agent / artifact service / processor on the builder', () => {
    const agent: OpenAICompatibleAgent = { id: 'gpt-4o-mini' };
    const service: ArtifactService = new DefaultArtifactService({
      storage: new InMemoryArtifactStorage(),
    });
    const processor: TaskResultProcessor = { process: (t) => t };
    const builder = new A2AServerBuilder({})
      .withAgent(agent)
      .withArtifactService(service)
      .withTaskResultProcessor(processor);
    expect(builder.getAgent()).toBe(agent);
    expect(builder.getArtifactService()).toBe(service);
    expect(builder.getTaskResultProcessor()).toBe(processor);
  });

  it('overwrites previously-set handlers when called twice', () => {
    const first: BackgroundTaskHandler = ({ task }) => task;
    const second: BackgroundTaskHandler = ({ task }) => task;
    const builder = new A2AServerBuilder({})
      .withBackgroundTaskHandler(first)
      .withBackgroundTaskHandler(second);
    expect(builder.getBackgroundTaskHandler()).toBe(second);
  });

  it('withDefaultBackgroundTaskHandler installs a non-undefined handler', () => {
    const builder = new A2AServerBuilder({}).withDefaultBackgroundTaskHandler();
    expect(builder.getBackgroundTaskHandler()).toBeDefined();
    expect(builder.getStreamingTaskHandler()).toBeUndefined();
  });

  it('withDefaultStreamingTaskHandler installs a non-undefined handler', () => {
    const builder = new A2AServerBuilder({}).withDefaultStreamingTaskHandler();
    expect(builder.getStreamingTaskHandler()).toBeDefined();
    expect(builder.getBackgroundTaskHandler()).toBeUndefined();
  });

  it('withDefaultTaskHandlers installs both', () => {
    const builder = new A2AServerBuilder({}).withDefaultTaskHandlers();
    expect(builder.getBackgroundTaskHandler()).toBeDefined();
    expect(builder.getStreamingTaskHandler()).toBeDefined();
  });
});

describe('A2AServerBuilder.build validation', () => {
  it('throws when no agent card has been configured', () => {
    const builder = new A2AServerBuilder({}).withBackgroundTaskHandler(
      noopBackgroundHandler
    );
    expect(() =>
      (builder as unknown as A2AServerBuilder<true, true>).build()
    ).toThrow(A2AServerBuilderError);
    expect(() =>
      (builder as unknown as A2AServerBuilder<true, true>).build()
    ).toThrow(/agent card/);
  });

  it('throws when no task handler has been configured', () => {
    const builder = new A2AServerBuilder({}).withAgentCard(backgroundCard());
    expect(() =>
      (builder as unknown as A2AServerBuilder<true, true>).build()
    ).toThrow(A2AServerBuilderError);
    expect(() =>
      (builder as unknown as A2AServerBuilder<true, true>).build()
    ).toThrow(/task handler/);
  });

  it('throws when card advertises streaming but no streaming handler is configured', () => {
    const builder = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withBackgroundTaskHandler(noopBackgroundHandler);
    expect(() => builder.build()).toThrow(A2AServerBuilderError);
    expect(() => builder.build()).toThrow(/streaming/);
  });

  it('throws when card does not advertise streaming but no background handler is configured', () => {
    const builder = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withStreamingTaskHandler(noopStreamingHandler);
    expect(() => builder.build()).toThrow(A2AServerBuilderError);
    expect(() => builder.build()).toThrow(/background/);
  });

  it('treats capabilities.streaming === false the same as missing', () => {
    const builder = new A2AServerBuilder({})
      .withAgentCard(backgroundCard({ capabilities: { streaming: false } }))
      .withStreamingTaskHandler(noopStreamingHandler);
    expect(() => builder.build()).toThrow(/background/);
  });
});

describe('A2AServerBuilder.build success paths', () => {
  it('builds a server when a streaming card has a streaming handler', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withStreamingTaskHandler(noopStreamingHandler)
      .build();
    expect(server).toBeInstanceOf(A2AServer);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(true);
    expect(server.hasMethod(MESSAGE_SEND_METHOD)).toBe(false);
    expect(server.hasMethod('tasks/cancel')).toBe(true);
  });

  it('builds a server when a non-streaming card has a background handler', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withBackgroundTaskHandler(noopBackgroundHandler)
      .build();
    expect(server.hasMethod(MESSAGE_SEND_METHOD)).toBe(true);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(false);
  });

  it('registers both methods when both handlers are configured', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withBackgroundTaskHandler(noopBackgroundHandler)
      .withStreamingTaskHandler(noopStreamingHandler)
      .build();
    expect(server.hasMethod(MESSAGE_SEND_METHOD)).toBe(true);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(true);
  });

  it('builds with withDefaultTaskHandlers on a streaming card', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(streamingCard())
      .withDefaultTaskHandlers()
      .build();
    expect(server.hasMethod(MESSAGE_SEND_METHOD)).toBe(true);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(true);
  });

  it('does not register push notification methods when capability is absent', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(backgroundCard())
      .withBackgroundTaskHandler(noopBackgroundHandler)
      .build();
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD)).toBe(
      false
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD)).toBe(
      false
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD)).toBe(
      false
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD)).toBe(
      false
    );
  });

  it('registers all four push notification methods when capability is enabled', () => {
    const server = new A2AServerBuilder({})
      .withAgentCard(
        backgroundCard({ capabilities: { pushNotifications: true } })
      )
      .withBackgroundTaskHandler(noopBackgroundHandler)
      .build();
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD)).toBe(
      true
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD)).toBe(
      true
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD)).toBe(
      true
    );
    expect(server.hasMethod(TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD)).toBe(
      true
    );
  });

  it('passes the storage override through to the underlying handlers', async () => {
    const storage = new InMemoryTaskStorage();
    const server = new A2AServerBuilder({ storage })
      .withAgentCard(streamingCard())
      .withDefaultTaskHandlers()
      .build();
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: MESSAGE_SEND_METHOD,
        params: {
          message: {
            messageId: 'm-1',
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(storage.getStats().totalTasks).toBe(1);
    await server.close();
  });

  it('uses the configured cacheControl on the agent card response', async () => {
    const server = new A2AServerBuilder({ cacheControl: 'no-store' })
      .withAgentCard(streamingCard())
      .withDefaultStreamingTaskHandler()
      .build();
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/agent-card.json`
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.text();
    await server.close();
  });

  it('uses the configured jsonRpcPath when set', async () => {
    const server = new A2AServerBuilder({ jsonRpcPath: '/rpc' })
      .withAgentCard(streamingCard())
      .withDefaultStreamingTaskHandler()
      .build();
    await server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const onRoot = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'm',
            role: 'ROLE_USER',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });
    expect(onRoot.status).toBe(404);
    await onRoot.text();
    await server.close();
  });
});

describe('A2AServerBuilder compile-time phantom-type guards', () => {
  it('rejects build() when prerequisites are missing (verified by @ts-expect-error)', () => {
    const card = streamingCard();

    // The chained build() calls below are type-checked by tsc; they don't run
    // at test time. The `if (false)` keeps them off the runtime path while
    // still forcing the compiler to evaluate them.
    if (Math.random() < 0) {
      // @ts-expect-error - build() requires both HasCard and HasHandler to be true
      new A2AServerBuilder({}).build();

      // @ts-expect-error - missing handler
      new A2AServerBuilder({}).withAgentCard(card).build();

      // @ts-expect-error - missing card
      new A2AServerBuilder({}).withDefaultStreamingTaskHandler().build();
    }

    // OK in both orders
    const a = new A2AServerBuilder({})
      .withAgentCard(card)
      .withDefaultStreamingTaskHandler()
      .build();
    const b = new A2AServerBuilder({})
      .withDefaultStreamingTaskHandler()
      .withAgentCard(card)
      .build();
    expect(a).toBeInstanceOf(A2AServer);
    expect(b).toBeInstanceOf(A2AServer);
  });
});

describe('A2AServerBuilder.withAgentCardFromFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'a2a-builder-card-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a card from disk and stores it on the builder', () => {
    const path = join(tmpDir, 'card.json');
    writeFileSync(path, JSON.stringify(streamingCard()));
    const builder = new A2AServerBuilder({})
      .withAgentCardFromFile(path)
      .withStreamingTaskHandler(noopStreamingHandler);
    const card = builder.getAgentCard();
    expect(card?.name).toBe('streaming-agent');
  });

  it('applies overrides over file contents', () => {
    const path = join(tmpDir, 'card.json');
    writeFileSync(path, JSON.stringify(streamingCard()));
    const builder = new A2AServerBuilder({})
      .withAgentCardFromFile(path, { name: 'override-name' })
      .withStreamingTaskHandler(noopStreamingHandler);
    expect(builder.getAgentCard()?.name).toBe('override-name');
  });

  it('builds a working server end-to-end from a file-loaded card', () => {
    const path = join(tmpDir, 'card.json');
    writeFileSync(path, JSON.stringify(streamingCard()));
    const server = new A2AServerBuilder({})
      .withAgentCardFromFile(path)
      .withDefaultStreamingTaskHandler()
      .build();
    expect(server).toBeInstanceOf(A2AServer);
    expect(server.hasMethod(MESSAGE_STREAM_METHOD)).toBe(true);
  });

  it('propagates errors from loadAgentCardFromFile (missing file)', () => {
    expect(() =>
      new A2AServerBuilder({}).withAgentCardFromFile(
        join(tmpDir, 'does-not-exist.json')
      )
    ).toThrow();
  });
});
