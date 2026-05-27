import {
  InMemoryTaskStorage,
  MESSAGE_STREAM_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageStreamHandler,
  type AgentCard,
  type Message,
  type StreamingExecutorContext,
  type StreamingTaskEvent,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'streaming-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A streaming A2A server that emits word-by-word deltas';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const DELTA_DELAY_MS = Number.parseInt(
  process.env['DELTA_DELAY_MS'] ?? '150',
  10
);

const card: AgentCard = {
  name: AGENT_NAME,
  description: AGENT_DESCRIPTION,
  version: AGENT_VERSION,
  protocolVersion: '0.3.0',
  url: `http://${HOST}:${PORT}`,
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    {
      id: 'stream-mock',
      name: 'Stream Mock',
      description:
        'Streams a canned response one word at a time. No LLM required.',
      tags: ['streaming', 'mock'],
    },
  ],
};

const MOCK_RESPONSE_WORDS: readonly string[] = [
  'This',
  'is',
  'a',
  'mock',
  'streaming',
  'response.',
  'Each',
  'word',
  'appears',
  'with',
  'a',
  'small',
  'delay',
  'to',
  'simulate',
  'real-time',
  'token',
  'streaming',
  'without',
  'any',
  'LLM',
  'dependency.',
];

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card });

server.registerStreamingMethod(
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler({
    storage,
    executor: mockStreamingExecutor,
  })
);

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  card:   http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: http://${HOST}:${PORT}/health`);
console.log(
  `  rpc:    POST http://${HOST}:${PORT}/  method=${MESSAGE_STREAM_METHOD}`
);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function* mockStreamingExecutor(
  context: StreamingExecutorContext
): AsyncIterable<StreamingTaskEvent> {
  const accumulated: string[] = [];
  for (let i = 0; i < MOCK_RESPONSE_WORDS.length; i++) {
    if (context.signal.aborted) {
      return;
    }
    const word = MOCK_RESPONSE_WORDS[i] as string;
    const delta = i === 0 ? word : ` ${word}`;
    accumulated.push(delta);

    const deltaMessage: Message = {
      messageId: crypto.randomUUID(),
      contextId: context.task.contextId,
      taskId: context.task.id,
      role: 'ROLE_AGENT',
      parts: [{ text: delta }],
    };
    yield { type: 'delta', message: deltaMessage };

    await sleep(DELTA_DELAY_MS, context.signal);
  }

  const finalMessage: Message = {
    messageId: crypto.randomUUID(),
    contextId: context.task.contextId,
    taskId: context.task.id,
    role: 'ROLE_AGENT',
    parts: [{ text: accumulated.join('') }],
  };
  yield {
    type: 'statusChanged',
    state: TASK_STATE.COMPLETED,
    message: finalMessage,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
