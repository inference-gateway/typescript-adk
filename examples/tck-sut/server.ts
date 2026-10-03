import {
  HTTPPushNotificationSender,
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
  isTerminal,
  toWireTask,
  transitionTask,
  type AgentCard,
  type Artifact,
  type ManagedTask,
  type Message,
  type Part,
  type StreamingExecutorContext,
  type StreamingTaskEvent,
} from '@inference-gateway/adk';

// A2A TCK system under test: implements the a2aproject/a2a-tck scenarios
// (scenarios/*.feature), selecting the behaviour by the messageId prefix the
// TCK sends. See README.md for running the TCK against it.

const HOST = '127.0.0.1';
const PORT = 9999;
const STREAMING_TIMEOUT_MS = 2_000;

const FILE_PART: Part = {
  raw: Buffer.from('tck').toString('base64'),
  mediaType: 'text/plain',
  filename: 'output.txt',
};

const ARTIFACT_PARTS: ReadonlyArray<readonly [string, Part]> = [
  ['tck-artifact-text', { text: 'Generated text content' }],
  [
    'tck-artifact-file-url',
    {
      url: 'https://example.com/output.txt',
      mediaType: 'text/plain',
      filename: 'output.txt',
    },
  ],
  ['tck-artifact-file', FILE_PART],
  ['tck-artifact-data', { data: { key: 'value', count: 42 } }],
];

const STREAMED_PARTS: ReadonlyArray<readonly [string, Part]> = [
  ['tck-stream-001', { text: 'Stream hello from TCK' }],
  ['tck-stream-003', { text: 'Stream task lifecycle' }],
  ['tck-stream-ordering-001', { text: 'Ordered output' }],
  ['tck-stream-artifact-text', { text: 'Streamed text content' }],
  ['tck-stream-artifact-file', FILE_PART],
];

const card: AgentCard = {
  name: 'tck-sut',
  description: 'System under test for the A2A TCK',
  version: '1.0.0',
  supportedInterfaces: [
    {
      url: `http://${HOST}:${PORT}/`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
  ],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  capabilities: { streaming: true, pushNotifications: true },
  skills: [
    {
      id: 'tck',
      name: 'TCK Conformance',
      description: 'Handles TCK conformance test messages',
      tags: ['tck'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const cancellationRegistry = new TaskCancellationRegistry();
const eventBusRegistry = new TaskEventBusRegistry();
const pushSender = new HTTPPushNotificationSender();

const server = createA2AServer({
  card: {
    ...card,
    capabilities: { ...card.capabilities, extendedAgentCard: true },
  },
  extendedCard: card,
});
server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage, respondToMessage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
server.registerMethod(
  TASK_CANCEL_METHOD,
  createTaskCancelHandler({ storage, registry: cancellationRegistry })
);
server.registerStreamingMethod(
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler({
    storage,
    executor: streamTask,
    cancellationRegistry,
    eventBusRegistry,
  })
);
server.registerStreamingMethod(
  TASK_RESUBSCRIBE_METHOD,
  createTaskResubscribeHandler({ storage, eventBusRegistry })
);
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

const abort = new AbortController();
const worker = runWorker(abort.signal);

await server.listen(PORT, HOST);
console.log(`tck-sut listening on http://${HOST}:${PORT}`);

const shutdown = async (): Promise<void> => {
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

/**
 * Answers the tck-message-response scenario with a direct Message, leaving
 * every other prefix to the task flow.
 */
function respondToMessage(message: Message): Message | undefined {
  if (!message.messageId.startsWith('tck-message-response')) {
    return undefined;
  }
  return {
    messageId: crypto.randomUUID(),
    ...(message.contextId !== undefined
      ? { contextId: message.contextId }
      : {}),
    role: 'ROLE_AGENT',
    parts: [{ text: 'Direct message response' }],
  };
}

/** Implements the core_operations.feature scenarios. */
function handleTask(task: ManagedTask, message: Message): ManagedTask {
  const id = message.messageId;
  if (id.startsWith('tck-reject-task')) {
    throw new Error('rejected');
  }
  if (id.startsWith('tck-input-required')) {
    return transitionTask(task, TASK_STATE.INPUT_REQUIRED);
  }
  if (id.startsWith('tck-complete-task')) {
    return complete(task, 'Hello from TCK');
  }
  const part = partFor(ARTIFACT_PARTS, id);
  if (part === undefined) {
    return complete(task, `Unhandled messageId prefix: ${id}`);
  }
  return complete({
    ...task,
    artifacts: [...task.artifacts, newArtifact(part)],
  });
}

/**
 * Implements the streaming.feature scenarios and falls back to the core
 * scenarios for any other prefix. The framework streams the initial
 * IN_PROGRESS status and completes the task when the iterable ends.
 */
async function* streamTask(
  context: StreamingExecutorContext
): AsyncIterable<StreamingTaskEvent> {
  const id = context.message.messageId;
  if (id.startsWith('tck-stream-002')) {
    return;
  }
  if (id.startsWith('test-resubscribe-message-id')) {
    await sleep(2 * STREAMING_TIMEOUT_MS, context.signal);
    return;
  }
  if (id.startsWith('tck-stream-artifact-chunked')) {
    const chunk = newArtifact({ text: 'chunk-1 ' });
    yield {
      type: 'artifactCreated',
      artifact: chunk,
      append: false,
      lastChunk: false,
    };
    yield {
      type: 'artifactCreated',
      artifact: { ...chunk, parts: [{ text: 'chunk-2' }] },
      append: true,
      lastChunk: true,
    };
    return;
  }
  const part = partFor(STREAMED_PARTS, id);
  if (part !== undefined) {
    yield {
      type: 'artifactCreated',
      artifact: newArtifact(part),
      lastChunk: true,
    };
    return;
  }
  const result = handleTask(context.task, context.message);
  for (const artifact of result.artifacts.slice(
    context.task.artifacts.length
  )) {
    yield { type: 'artifactCreated', artifact, lastChunk: true };
  }
  yield {
    type: 'statusChanged',
    state: result.state,
    ...(result.status.message !== undefined
      ? { message: result.status.message }
      : {}),
  };
}

/**
 * Dequeues SendMessage tasks, runs {@link handleTask} and stores the result,
 * delivering push notifications for every state it records. Tasks a
 * SendStreamingMessage request already moved on are skipped; the stream owns
 * them.
 */
async function runWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let task: ManagedTask;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    if (storage.getTask(task.id)?.state !== task.state) {
      continue;
    }
    const working =
      task.state === TASK_STATE.PENDING
        ? transitionTask(task, TASK_STATE.IN_PROGRESS)
        : task;
    storage.updateActive(working);
    const message = working.messages[working.messages.length - 1] as Message;
    let result: ManagedTask;
    try {
      result = handleTask(working, message);
    } catch (err) {
      result = transitionTask(working, TASK_STATE.FAILED, {
        message: agentMessage(
          working,
          err instanceof Error ? err.message : String(err)
        ),
      });
    }
    if (isTerminal(result.state)) {
      storage.storeDeadLetter(result);
    } else {
      storage.updateActive(result);
    }
    void pushSender.deliverTaskUpdate(
      storage.listPushConfigs(result.id),
      toWireTask(result)
    );
  }
}

function complete(task: ManagedTask, text?: string): ManagedTask {
  if (text === undefined) {
    return transitionTask(task, TASK_STATE.COMPLETED);
  }
  const reply = agentMessage(task, text);
  return transitionTask(
    { ...task, messages: [...task.messages, reply] },
    TASK_STATE.COMPLETED,
    { message: reply }
  );
}

function agentMessage(task: ManagedTask, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: task.contextId,
    taskId: task.id,
    role: 'ROLE_AGENT',
    parts: [{ text }],
  };
}

function newArtifact(part: Part): Artifact {
  return { artifactId: crypto.randomUUID(), parts: [part] };
}

function partFor(
  table: ReadonlyArray<readonly [string, Part]>,
  messageId: string
): Part | undefined {
  return table.find(([prefix]) => messageId.startsWith(prefix))?.[1];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
