import {
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  MESSAGE_STREAM_METHOD,
  TASK_CANCEL_METHOD,
  TASK_GET_METHOD,
  TASK_LIST_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
  TASK_RESUBSCRIBE_METHOD,
  TASK_STATE,
  TaskCancellationRegistry,
  TaskEventBusRegistry,
  createA2AServer,
  createGetAuthenticatedExtendedCardHandler,
  createMessageSendHandler,
  createMessageStreamHandler,
  createTaskCancelHandler,
  createTaskGetHandler,
  createTaskListHandler,
  createTaskPushNotificationConfigDeleteHandler,
  createTaskPushNotificationConfigGetHandler,
  createTaskPushNotificationConfigListHandler,
  createTaskPushNotificationConfigSetHandler,
  createTaskResubscribeHandler,
  type AgentCard,
  type Message,
  type StreamingExecutorContext,
  type StreamingTaskEvent,
} from '@inference-gateway/adk';

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'protocol-methods-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A full-featured A2A agent exercising every JSON-RPC method.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const DELTA_DELAY_MS = Number.parseInt(
  process.env['DELTA_DELAY_MS'] ?? '100',
  10
);

const MOCK_RESPONSE_WORDS: readonly string[] = [
  'Hello',
  'from',
  'the',
  'protocol-methods',
  'agent.',
  'This',
  'is',
  'a',
  'streaming',
  'response',
  'with',
  'word-by-word',
  'deltas.',
];

// ---------------------------------------------------------------------------
// Agent card – all capabilities enabled
// ---------------------------------------------------------------------------

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
    pushNotifications: true,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: 'echo',
      name: 'Echo',
      description:
        'Echoes the user message back as a completed task. No LLM required.',
      tags: ['echo', 'demo'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Extended card – served via agent/getAuthenticatedExtendedCard
// ---------------------------------------------------------------------------

const extendedCard: AgentCard = {
  ...card,
  name: `${card.name} (extended)`,
  description: `${card.description} [authenticated view]`,
};

// ---------------------------------------------------------------------------
// Storage, cancellation registry, event bus registry
// ---------------------------------------------------------------------------

const storage = new InMemoryTaskStorage();
const cancellationRegistry = new TaskCancellationRegistry();
const eventBusRegistry = new TaskEventBusRegistry();

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

const server = createA2AServer({
  card,
  extendedCard,
});

// ---------------------------------------------------------------------------
// message/send – creates a PENDING task, enqueues it for background processing
// ---------------------------------------------------------------------------

server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);

// ---------------------------------------------------------------------------
// tasks/get – retrieves a task by id (active or dead-letter)
// ---------------------------------------------------------------------------

server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

// ---------------------------------------------------------------------------
// tasks/list – lists tasks with optional state / contextId filter and
//             keyset pagination
// ---------------------------------------------------------------------------

server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));

// ---------------------------------------------------------------------------
// tasks/cancel – cancels a non-terminal task by id
// ---------------------------------------------------------------------------

server.registerMethod(
  TASK_CANCEL_METHOD,
  createTaskCancelHandler({ storage, registry: cancellationRegistry })
);

// ---------------------------------------------------------------------------
// message/stream – SSE streaming method
// ---------------------------------------------------------------------------

server.registerStreamingMethod(
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler({
    storage,
    executor: mockStreamingExecutor,
    cancellationRegistry,
    eventBusRegistry,
  })
);

// ---------------------------------------------------------------------------
// tasks/resubscribe – SSE resubscribe to a task's event stream
// ---------------------------------------------------------------------------

server.registerStreamingMethod(
  TASK_RESUBSCRIBE_METHOD,
  createTaskResubscribeHandler({
    storage,
    eventBusRegistry,
  })
);

// ---------------------------------------------------------------------------
// tasks/pushNotificationConfig/{set,get,list,delete} – push notification
// config CRUD
// ---------------------------------------------------------------------------

server.registerMethod(
  TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
  createTaskPushNotificationConfigSetHandler({ storage })
);

server.registerMethod(
  TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
  createTaskPushNotificationConfigGetHandler({ storage })
);

server.registerMethod(
  TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
  createTaskPushNotificationConfigListHandler({ storage })
);

server.registerMethod(
  TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
  createTaskPushNotificationConfigDeleteHandler({ storage })
);

// ---------------------------------------------------------------------------
// agent/getAuthenticatedExtendedCard – returns the extended card
// ---------------------------------------------------------------------------

server.registerMethod(
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  createGetAuthenticatedExtendedCardHandler({ card: extendedCard })
);

// ---------------------------------------------------------------------------
// Background worker – dequeues PENDING tasks and completes them
// ---------------------------------------------------------------------------

const abort = new AbortController();
const worker = runWorker(abort.signal).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  card:     http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health:   http://${HOST}:${PORT}/health`);
console.log(`  rpc:      POST http://${HOST}:${PORT}/`);
console.log('');
console.log('Registered methods:');
for (const name of server.registeredMethods().sort()) {
  console.log(`  - ${name}`);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Mock streaming executor – emits word-by-word deltas, then a terminal status
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Background worker – completes tasks from the queue
// ---------------------------------------------------------------------------

async function runWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let task;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    storage.updateActive(task);
    console.log(`background: task ${task.id} dequeued, completing...`);

    const completed = {
      ...task,
      state: TASK_STATE.COMPLETED as const,
      status: {
        state: TASK_STATE.COMPLETED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: crypto.randomUUID(),
          contextId: task.contextId,
          taskId: task.id,
          role: 'ROLE_AGENT' as const,
          parts: [{ text: `Echo: ${extractText(task.messages)}` }],
        },
      },
      updatedAt: new Date().toISOString(),
    };
    storage.storeDeadLetter(completed);
    console.log(`background: task ${task.id} -> COMPLETED`);
  }
}

function extractText(
  messages: readonly { readonly parts?: ReadonlyArray<{ readonly text?: string }> }[]
): string {
  for (const msg of messages) {
    if (msg.parts !== undefined) {
      for (const part of msg.parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          return part.text;
        }
      }
    }
  }
  return '(empty)';
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
