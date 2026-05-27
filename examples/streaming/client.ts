import {
  AGENT_EVENT_TYPE,
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  TASK_STATE,
  type CloudEvent,
  type Message,
  type TaskStatusUpdateEvent,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPT =
  process.env['PROMPT'] ??
  'Please write a short paragraph and stream it to me word by word.';

const requestBody = {
  jsonrpc: JSONRPC_VERSION,
  id: crypto.randomUUID(),
  method: MESSAGE_STREAM_METHOD,
  params: {
    message: {
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text: PROMPT }],
    } satisfies Message,
  },
};

console.log(`POST ${SERVER_URL}/  ${MESSAGE_STREAM_METHOD}  "${PROMPT}"`);

const response = await fetch(`${SERVER_URL}/`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify(requestBody),
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

const accumulated: string[] = [];
let deltaCount = 0;
let finalStatus: TaskStatusUpdateEvent | null = null;

for await (const event of readSSEEvents(response.body)) {
  switch (event.type) {
    case AGENT_EVENT_TYPE.TASK_STATUS_CHANGED: {
      const data = event.data as TaskStatusUpdateEvent;
      if (data.status.state === TASK_STATE.IN_PROGRESS) {
        console.log(
          `[task ${data.taskId}] status=IN_PROGRESS final=${data.final}`
        );
        console.log('---');
      } else if (data.final === true) {
        console.log('\n---');
        console.log(
          `[task ${data.taskId}] status=${data.status.state} final=true`
        );
        finalStatus = data;
      }
      break;
    }
    case AGENT_EVENT_TYPE.DELTA: {
      const message = event.data as Message;
      deltaCount += 1;
      for (const part of message.parts) {
        if (typeof part.text === 'string') {
          process.stdout.write(part.text);
          accumulated.push(part.text);
        }
      }
      break;
    }
    default:
      console.log(`[unknown event] type=${event.type}`);
  }
}

console.log(`\nstream complete: ${deltaCount} delta event(s)`);
console.log(`assembled text: ${JSON.stringify(accumulated.join(''))}`);
if (finalStatus !== null) {
  console.log(`final status: ${JSON.stringify(finalStatus, null, 2)}`);
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
