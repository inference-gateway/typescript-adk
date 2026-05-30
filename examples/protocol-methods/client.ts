import {
  AGENT_EVENT_TYPE,
  A2AClientError,
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  TASK_RESUBSCRIBE_METHOD,
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type AgentCard,
  type CloudEvent,
  type ManagedTaskState,
  type Message,
  type PushNotificationConfig,
  type Task,
  type TaskPushNotificationConfig,
  type TaskStatusUpdateEvent,
} from '@inference-gateway/adk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const POLL_INTERVAL_MS = 200;
const POLL_MAX_ATTEMPTS = 150;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function fail(label: string, detail?: string): void {
  failed += 1;
  console.log(`  ✗ ${label}${detail !== undefined ? `: ${detail}` : ''}`);
}

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilTerminal(
  client: ReturnType<typeof createA2AClient>,
  taskId: string
): Promise<Task> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const task = await client.getTask(taskId);
    if (isTerminal(task.status.state as ManagedTaskState)) {
      return task;
    }
    process.stdout.write('.');
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `task ${taskId} did not reach terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`
  );
}

function extractText(message: Message | undefined): string {
  if (message === undefined) return '';
  for (const part of message.parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      return part.text;
    }
  }
  return '';
}

async function jsonRpcCall<T>(
  method: string,
  params: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const response = await fetch(`${SERVER_URL}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  const envelope = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (envelope.error !== undefined) {
    throw new Error(
      `JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`
    );
  }
  if (envelope.result === undefined) {
    throw new Error('missing result in JSON-RPC response');
  }
  return envelope.result as T;
}

async function* readSSEEvents(
  body: ReadableStream<Uint8Array>
): AsyncIterable<CloudEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) break;
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw.startsWith('data: ')) continue;
        const payload = raw.slice('data: '.length);
        try {
          yield JSON.parse(payload) as CloudEvent;
        } catch (err) {
          console.error(
            `  [warn] failed to parse SSE frame: ${(err as Error).message}`
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Main walkthrough
// ---------------------------------------------------------------------------

console.log('══════════════════════════════════════════════════════════');
console.log('  A2A Protocol Methods Walkthrough');
console.log(`  Server: ${SERVER_URL}`);
console.log('══════════════════════════════════════════════════════════\n');

const client = createA2AClient({ baseURL: SERVER_URL });

// -----------------------------------------------------------------------
// 1. agent/getAgentCard – unauthenticated card discovery
// -----------------------------------------------------------------------
console.log('── 1. agent/getAgentCard ────────────────────────────────');

let agentCard: AgentCard;
try {
  agentCard = await client.getAgentCard();
  assert(typeof agentCard.name === 'string', 'card.name is a string');
  assert(
    agentCard.capabilities.streaming === true,
    'card.capabilities.streaming === true'
  );
  assert(
    agentCard.capabilities.pushNotifications === true,
    'card.capabilities.pushNotifications === true'
  );
  assert(
    agentCard.capabilities.stateTransitionHistory === true,
    'card.capabilities.stateTransitionHistory === true'
  );
  assert(
    agentCard.supportsExtendedAgentCard === undefined ||
      agentCard.supportsExtendedAgentCard === true,
    'card.supportsExtendedAgentCard is absent or true'
  );
  console.log(`  name:        ${agentCard.name}`);
  console.log(`  description: ${agentCard.description}`);
  console.log(`  version:     ${agentCard.version}`);
  console.log(`  streaming:   ${agentCard.capabilities.streaming}`);
  console.log(`  pushNotes:   ${agentCard.capabilities.pushNotifications}`);
} catch (err) {
  fail('getAgentCard', String(err));
}

// -----------------------------------------------------------------------
// 2. agent/getHealth – liveness probe
// -----------------------------------------------------------------------
console.log('\n── 2. agent/getHealth ────────────────────────────────────');

try {
  const health = await client.getHealth();
  assert(typeof health.status === 'string', 'health.status is a string');
  assert(health.status === 'healthy', 'health.status === "healthy"');
  console.log(`  status: ${health.status}`);
} catch (err) {
  fail('getHealth', String(err));
}

// -----------------------------------------------------------------------
// 3. agent/getAuthenticatedExtendedCard – extended card
// -----------------------------------------------------------------------
console.log('\n── 3. agent/getAuthenticatedExtendedCard ─────────────────');

try {
  const extended = await jsonRpcCall<AgentCard>(
    'agent/getAuthenticatedExtendedCard',
    {}
  );
  assert(typeof extended.name === 'string', 'extended card name is a string');
  assert(
    extended.name.includes('extended'),
    'extended card name includes "(extended)"'
  );
  assert(
    extended.capabilities.streaming === true,
    'extended card capabilities.streaming === true'
  );
  console.log(`  name:        ${extended.name}`);
  console.log(`  description: ${extended.description}`);
} catch (err) {
  fail('getAuthenticatedExtendedCard', String(err));
}

// -----------------------------------------------------------------------
// 4. message/send – create a task
// -----------------------------------------------------------------------
console.log('\n── 4. message/send ───────────────────────────────────────');

const PROMPT = process.env['PROMPT'] ?? 'Hello, protocol-methods agent!';

let createdTask: Task;
try {
  const message: Message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: PROMPT }],
  };
  createdTask = await client.sendMessage({ message });
  assert(typeof createdTask.id === 'string', 'task.id is a string');
  assert(createdTask.id.length > 0, 'task.id is non-empty');
  assert(
    createdTask.status.state === TASK_STATE.PENDING,
    `task.status.state === PENDING (got ${createdTask.status.state})`
  );
  console.log(`  task id:    ${createdTask.id}`);
  console.log(`  state:      ${createdTask.status.state}`);
  console.log(`  contextId:  ${createdTask.contextId ?? '(none)'}`);
} catch (err) {
  fail('sendMessage', String(err));
  console.log('  (remaining steps skipped – sendMessage failed)');
  process.exit(1);
}

// -----------------------------------------------------------------------
// 5. tasks/get – retrieve the created task (initially)
// -----------------------------------------------------------------------
console.log('\n── 5. tasks/get (immediately after send) ────────────────');

try {
  const fetched = await client.getTask(createdTask.id);
  assert(fetched.id === createdTask.id, 'returned task id matches');
  console.log(`  task id:    ${fetched.id}`);
  console.log(`  state:      ${fetched.status.state}`);
  console.log(`  history:    ${(fetched.history ?? []).length} message(s)`);
} catch (err) {
  fail('getTask', String(err));
}

// -----------------------------------------------------------------------
// 6. Poll tasks/get until terminal – then verify completion
// -----------------------------------------------------------------------
console.log('\n── 6. tasks/get (poll until terminal) ───────────────────');

try {
  const terminal = await pollUntilTerminal(client, createdTask.id);
  assert(
    terminal.status.state === TASK_STATE.COMPLETED,
    `task reached COMPLETED (state=${terminal.status.state})`
  );
  assert(
    terminal.status.message !== undefined,
    'terminal task has a status.message'
  );
  const responseText = extractText(terminal.status.message);
  assert(responseText.length > 0, 'terminal message has text content');
  console.log(`  task id:    ${terminal.id}`);
  console.log(`  state:      ${terminal.status.state}`);
  console.log(`  response:   ${responseText}`);
} catch (err) {
  fail('pollUntilTerminal', String(err));
}

// -----------------------------------------------------------------------
// 7. tasks/get with historyLength
// -----------------------------------------------------------------------
console.log('\n── 7. tasks/get (with historyLength=1) ──────────────────');

try {
  const sliced = await client.getTask(createdTask.id, { historyLength: 1 });
  assert(sliced.id === createdTask.id, 'task id matches');
  const historyLen = (sliced.history ?? []).length;
  assert(historyLen <= 1, `history has at most 1 message (got ${historyLen})`);
  console.log(`  task id:    ${sliced.id}`);
  console.log(`  history:    ${historyLen} message(s) (capped to 1)`);
} catch (err) {
  fail('getTask with historyLength', String(err));
}

// -----------------------------------------------------------------------
// 8. tasks/list – list tasks with state filter
// -----------------------------------------------------------------------
console.log('\n── 8. tasks/list ─────────────────────────────────────────');

try {
  const { tasks: allTasks, nextCursor } = await jsonRpcCall<{
    tasks: Task[];
    nextCursor?: string;
  }>('tasks/list', {});

  assert(Array.isArray(allTasks), 'result.tasks is an array');
  assert(allTasks.length > 0, 'at least one task is listed');
  console.log(`  total tasks: ${allTasks.length}`);
  for (const t of allTasks) {
    console.log(`    - ${t.id}  (${t.status.state})`);
  }
  if (nextCursor !== undefined) {
    console.log(`  nextCursor:  ${nextCursor}`);
    pass('nextCursor is present (pagination)');
  } else {
    console.log('  nextCursor:  (none, last page)');
  }
} catch (err) {
  fail('tasks/list', String(err));
}

// -----------------------------------------------------------------------
// 9. tasks/list with state filter
// -----------------------------------------------------------------------
console.log('\n── 9. tasks/list (filtered by state=COMPLETED) ──────────');

try {
  const { tasks: completedTasks } = await jsonRpcCall<{
    tasks: Task[];
  }>('tasks/list', { state: TASK_STATE.COMPLETED });

  assert(Array.isArray(completedTasks), 'result.tasks is an array');
  assert(completedTasks.length > 0, 'at least one COMPLETED task');
  for (const t of completedTasks) {
    assert(
      t.status.state === TASK_STATE.COMPLETED,
      `task ${t.id} state is COMPLETED`
    );
  }
  console.log(`  COMPLETED tasks: ${completedTasks.length}`);
} catch (err) {
  fail('tasks/list (filtered)', String(err));
}

// -----------------------------------------------------------------------
// 10. tasks/cancel – cancel a newly-created task
// -----------------------------------------------------------------------
console.log('\n── 10. tasks/cancel ──────────────────────────────────────');

try {
  const cancelMessage: Message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: 'This task will be cancelled.' }],
  };
  const cancelTask = await client.sendMessage({ message: cancelMessage });
  assert(
    cancelTask.status.state === TASK_STATE.PENDING,
    `cancel-task created (PENDING; got ${cancelTask.status.state})`
  );

  const cancelled = await jsonRpcCall<Task>('tasks/cancel', {
    taskId: cancelTask.id,
  });
  assert(cancelled.id === cancelTask.id, 'returned task id matches');
  assert(
    cancelled.status.state === TASK_STATE.CANCELLED,
    `task state is CANCELLED (got ${cancelled.status.state})`
  );
  console.log(`  cancelled task: ${cancelled.id} (${cancelled.status.state})`);

  // Verify it's in the dead-letter store via tasks/get
  const verifyCancelled = await client.getTask(cancelTask.id);
  assert(
    verifyCancelled.status.state === TASK_STATE.CANCELLED,
    'verify cancelled via tasks/get'
  );
} catch (err) {
  fail('tasks/cancel', String(err));
}

// -----------------------------------------------------------------------
// 11. tasks/pushNotificationConfig/set + get + list + delete (CRUD)
// -----------------------------------------------------------------------
console.log('\n── 11. push notification config CRUD ─────────────────────');

const PUSH_URL = 'https://webhook.example.com/a2a-updates';
const PUSH_TOKEN = 'test-webhook-token-abc123';

try {
  // 11a. Set
  const setResult = await jsonRpcCall<TaskPushNotificationConfig>(
    'tasks/pushNotificationConfig/set',
    {
      taskId: createdTask.id,
      pushNotificationConfig: {
        url: PUSH_URL,
        token: PUSH_TOKEN,
      },
    }
  );
  assert(
    typeof setResult.name === 'string' && setResult.name.length > 0,
    'set: returned resource name'
  );
  assert(setResult.pushNotificationConfig.url === PUSH_URL, 'set: url matches');
  const configId = setResult.pushNotificationConfig.id;
  assert(
    typeof configId === 'string' && configId.length > 0,
    'set: config id assigned'
  );
  console.log(`  set: name=${setResult.name} id=${configId}`);

  // 11b. Get
  const getResult = await jsonRpcCall<TaskPushNotificationConfig>(
    'tasks/pushNotificationConfig/get',
    {
      taskId: createdTask.id,
      pushNotificationConfigId: configId,
    }
  );
  assert(getResult.pushNotificationConfig.url === PUSH_URL, 'get: url matches');
  assert(
    getResult.pushNotificationConfig.token === PUSH_TOKEN,
    'get: token matches'
  );
  console.log(`  get: url=${getResult.pushNotificationConfig.url}`);

  // 11c. List
  const listResult = await jsonRpcCall<{ configs: PushNotificationConfig[] }>(
    'tasks/pushNotificationConfig/list',
    { taskId: createdTask.id }
  );
  assert(Array.isArray(listResult.configs), 'list: configs is array');
  assert(listResult.configs.length >= 1, 'list: at least 1 config');
  console.log(`  list: ${listResult.configs.length} config(s)`);

  // 11d. Delete
  const deleteResult = await jsonRpcCall<null>(
    'tasks/pushNotificationConfig/delete',
    {
      taskId: createdTask.id,
      pushNotificationConfigId: configId,
    }
  );
  assert(deleteResult === null, 'delete: returns null');
  console.log('  delete: returned null (success)');

  // Verify deletion
  try {
    await jsonRpcCall<TaskPushNotificationConfig>(
      'tasks/pushNotificationConfig/get',
      {
        taskId: createdTask.id,
        pushNotificationConfigId: configId,
      }
    );
    fail('get after delete', 'should have thrown not-found error');
  } catch {
    pass('get after delete throws (config not found)');
  }
} catch (err) {
  fail('push notification config CRUD', String(err));
}

// -----------------------------------------------------------------------
// 12. message/stream – SSE streaming method
// -----------------------------------------------------------------------
console.log('\n── 12. message/stream ────────────────────────────────────');

let streamTaskId: string | null = null;

try {
  const streamBody = {
    jsonrpc: JSONRPC_VERSION,
    id: crypto.randomUUID(),
    method: MESSAGE_STREAM_METHOD,
    params: {
      message: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text: 'Stream this for me!' }],
      },
    },
  };

  const response = await fetch(`${SERVER_URL}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(streamBody),
  });
  assert(response.ok, 'stream: HTTP 200');
  const contentType = response.headers.get('content-type') ?? '';
  assert(
    contentType.startsWith('text/event-stream'),
    `stream: Content-Type is text/event-stream (got ${contentType})`
  );
  if (response.body === null) {
    throw new Error('stream: response has no body');
  }
  pass('stream: response has body');

  const TERMINAL_STATES = new Set<string>([
    TASK_STATE.COMPLETED,
    TASK_STATE.FAILED,
    TASK_STATE.CANCELLED,
  ]);

  let deltaCount = 0;
  let terminalEvent: TaskStatusUpdateEvent | null = null;

  for await (const event of readSSEEvents(response.body)) {
    if (event.type === AGENT_EVENT_TYPE.DELTA) {
      deltaCount += 1;
      const msg = event.data as Message;
      for (const part of msg.parts) {
        if (typeof part.text === 'string') {
          process.stdout.write(part.text);
        }
      }
    } else if (event.type === AGENT_EVENT_TYPE.TASK_STATUS_CHANGED) {
      const data = event.data as TaskStatusUpdateEvent;
      // Capture as terminal on first sight of either signal: the wire `final`
      // flag, or a terminal state. The server emits both together at end of
      // stream; treating either as terminal makes the walkthrough robust to
      // periodic IN_PROGRESS updates that may interleave with deltas.
      if (data.final === true || TERMINAL_STATES.has(data.status.state)) {
        if (terminalEvent === null) {
          terminalEvent = data;
          streamTaskId = data.taskId;
          console.log(
            `\n  [stream] ${data.status.state} (final=${data.final})`
          );
        }
      } else if (data.status.state === TASK_STATE.IN_PROGRESS) {
        console.log('\n  [stream] IN_PROGRESS');
      }
    }
  }

  assert(deltaCount > 0, `stream: received ${deltaCount} delta(s)`);
  if (terminalEvent === null) {
    fail('stream: received terminal status event');
  } else {
    pass('stream: received terminal status event');
    assert(
      terminalEvent.status.state === TASK_STATE.COMPLETED,
      `stream: final state is COMPLETED (got ${terminalEvent.status.state})`
    );
    console.log(
      `  stream complete: ${deltaCount} delta(s), task ${streamTaskId}`
    );
  }
} catch (err) {
  fail('message/stream', String(err));
}

// -----------------------------------------------------------------------
// 13. tasks/resubscribe – SSE resubscribe to completed task
// -----------------------------------------------------------------------
console.log('\n── 13. tasks/resubscribe ─────────────────────────────────');

if (streamTaskId !== null) {
  try {
    const resubBody = {
      jsonrpc: JSONRPC_VERSION,
      id: crypto.randomUUID(),
      method: TASK_RESUBSCRIBE_METHOD,
      params: { taskId: streamTaskId },
    };

    const response = await fetch(`${SERVER_URL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(resubBody),
    });
    assert(response.ok, 'resubscribe: HTTP 200');
    const ct = response.headers.get('content-type') ?? '';
    assert(
      ct.startsWith('text/event-stream'),
      `resubscribe: Content-Type is text/event-stream`
    );
    if (response.body === null) {
      throw new Error('resubscribe: response has no body');
    }
    pass('resubscribe: response has body');

    let resubEvents = 0;
    for await (const event of readSSEEvents(response.body)) {
      if (event.type === AGENT_EVENT_TYPE.TASK_STATUS_CHANGED) {
        resubEvents += 1;
        const data = event.data as TaskStatusUpdateEvent;
        console.log(
          `  [resubscribe] task=${data.taskId} state=${data.status.state} final=${data.final}`
        );
      }
    }
    assert(resubEvents > 0, `resubscribe: received ${resubEvents} event(s)`);
    console.log(`  resubscribe complete: ${resubEvents} event(s)`);
  } catch (err) {
    fail('tasks/resubscribe', String(err));
  }
} else {
  console.log('  (skipped – no stream task id available)');
}

// -----------------------------------------------------------------------
// 14. tasks/get with non-existent id (error path)
// -----------------------------------------------------------------------
console.log('\n── 14. tasks/get (non-existent id – error path) ─────────');

try {
  await client.getTask('non-existent-task-id');
  fail('getTask(non-existent)', 'should have thrown');
} catch (err) {
  if (err instanceof A2AClientError || String(err).includes('not found')) {
    pass('getTask(non-existent) throws expected error');
    console.log(`  error: ${String(err)}`);
  } else {
    fail('getTask(non-existent)', `unexpected error: ${String(err)}`);
  }
}

// -----------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Walkthrough complete: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
