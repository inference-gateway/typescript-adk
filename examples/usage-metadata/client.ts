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
const SEND_PROMPTS: readonly string[] =
  process.env['SEND_PROMPTS'] !== undefined &&
  process.env['SEND_PROMPTS'].length > 0
    ? process.env['SEND_PROMPTS'].split('||')
    : [
        "What's the weather in Paris?", // tool call -> 2 LLM iterations, 1 tool call
        'Hello there!', // no tool -> 1 LLM iteration
      ];
const STREAM_PROMPT =
  process.env['STREAM_PROMPT'] ?? "What's the weather in Tokyo?";
const POLL_INTERVAL_MS = 250;
const POLL_MAX_ATTEMPTS = 60;

const client = createA2AClient({ baseURL: SERVER_URL });

console.log('=== message/send (background path) ===');
for (let i = 0; i < SEND_PROMPTS.length; i++) {
  const prompt = SEND_PROMPTS[i] as string;
  console.log(`\n--- send ${i + 1} ---`);
  console.log(`> ${prompt}`);
  const message: Message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: prompt }],
  };
  const created = await client.sendMessage({ message });
  const final = await pollUntilTerminal(created.id);
  console.log(`final state: ${final.status.state}`);
  console.log(`response: ${extractText(final.status.message)}`);
  console.log('task.metadata:');
  console.log(JSON.stringify(final.metadata ?? null, null, 2));
}

console.log('\n=== message/stream (streaming path) ===');
console.log(`> ${STREAM_PROMPT}`);
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

let finalStatus: TaskStatusUpdateEvent | null = null;
let streamTaskId: string | undefined;

for await (const event of readSSEEvents(response.body)) {
  if (event.type === AGENT_EVENT_TYPE.TASK_STATUS_CHANGED) {
    const data = event.data as TaskStatusUpdateEvent;
    streamTaskId = data.taskId;
    console.log(
      `[status] state=${data.status.state} final=${data.final}${data.metadata !== undefined ? '  metadata=yes' : ''}`
    );
    if (data.final === true) {
      finalStatus = data;
    }
  } else if (event.type === AGENT_EVENT_TYPE.DELTA) {
    // skip noisy per-delta logging
  } else {
    console.log(`[event] ${event.type}`);
  }
}

if (finalStatus !== null) {
  console.log(`\nfinal stream status: ${finalStatus.status.state}`);
  console.log('task.metadata (from terminal status event):');
  console.log(JSON.stringify(finalStatus.metadata ?? null, null, 2));
}

// Confirm the same metadata is reachable via tasks/get on the persisted task.
if (streamTaskId !== undefined) {
  const persisted = await client.getTask(streamTaskId);
  console.log('\ntask.metadata (from tasks/get):');
  console.log(JSON.stringify(persisted.metadata ?? null, null, 2));
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

function extractText(message: Message | undefined): string {
  if (message === undefined) return '';
  for (const part of message.parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      return part.text;
    }
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
