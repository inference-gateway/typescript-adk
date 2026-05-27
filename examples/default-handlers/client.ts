import {
  AGENT_EVENT_TYPE,
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type CloudEvent,
  type ManagedTaskState,
  type Message,
  type Task,
  type TaskStatusUpdateEvent,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const SEND_PROMPT =
  process.env['SEND_PROMPT'] ??
  'Hello via message/send — please walk this task to COMPLETED.';
const STREAM_PROMPT =
  process.env['STREAM_PROMPT'] ??
  'Hello via message/stream — please walk this task to COMPLETED.';
const POLL_INTERVAL_MS = 300;
const POLL_MAX_ATTEMPTS = 60;

const client = createA2AClient({ baseURL: SERVER_URL });

console.log('=== message/send (background path) ===');
const sendMessage: Message = {
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text: SEND_PROMPT }],
};
console.log(`POST ${SERVER_URL}/  message/send  "${SEND_PROMPT}"`);
const created = await client.sendMessage({ message: sendMessage });
console.log(`created task id=${created.id} state=${created.status.state}`);
const completed = await pollUntilTerminal(created.id);
console.log(`final state: ${completed.status.state}`);
console.log(`final task:\n${JSON.stringify(completed, null, 2)}`);

console.log('\n=== message/stream (streaming path) ===');
const streamRequest = {
  jsonrpc: JSONRPC_VERSION,
  id: crypto.randomUUID(),
  method: MESSAGE_STREAM_METHOD,
  params: {
    message: {
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text: STREAM_PROMPT }],
    } satisfies Message,
  },
};
console.log(`POST ${SERVER_URL}/  message/stream  "${STREAM_PROMPT}"`);

const response = await fetch(`${SERVER_URL}/`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify(streamRequest),
});

if (!response.ok) {
  console.error(`HTTP ${response.status} ${response.statusText}`);
  console.error(await response.text());
  process.exit(1);
}

const contentType = response.headers.get('content-type') ?? '';
if (!contentType.startsWith('text/event-stream')) {
  console.error(`unexpected content-type: ${contentType}`);
  console.error(await response.text());
  process.exit(1);
}

if (response.body === null) {
  console.error('response had no body');
  process.exit(1);
}

let frameCount = 0;
let finalStatus: TaskStatusUpdateEvent | null = null;

for await (const event of readSSEEvents(response.body)) {
  frameCount += 1;
  if (event.type === AGENT_EVENT_TYPE.TASK_STATUS_CHANGED) {
    const data = event.data as TaskStatusUpdateEvent;
    console.log(
      `[frame ${frameCount}] task.status.changed state=${data.status.state} final=${data.final}`
    );
    if (data.final === true) {
      finalStatus = data;
    }
  } else {
    console.log(`[frame ${frameCount}] type=${event.type}`);
  }
}

console.log(`stream complete: ${frameCount} frame(s)`);
if (finalStatus !== null) {
  console.log(`final status:\n${JSON.stringify(finalStatus, null, 2)}`);
}

async function pollUntilTerminal(taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const task = await client.getTask(taskId);
    if (isTerminal(task.status.state as ManagedTaskState)) {
      if (task.status.state !== TASK_STATE.COMPLETED) {
        console.warn(
          `task ${taskId} reached non-success terminal state ${task.status.state}`
        );
      }
      return task;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `task ${taskId} did not reach a terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`
  );
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
          console.error(`failed to parse SSE frame: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
