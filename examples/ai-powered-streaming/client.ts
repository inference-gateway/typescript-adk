import {
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  TASK_STATE,
  type Message,
  type StreamResponse,
  type TaskStatusUpdateEvent,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPT =
  process.env['PROMPT'] ??
  "What's the weather in New York? Suggest a few activities that would suit it.";

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
  if (event.task !== undefined) {
    console.log(`[task ${event.task.id}] status=${event.task.status.state}`);
    console.log('---');
    continue;
  }
  const data = event.statusUpdate;
  if (data === undefined) {
    console.log(`[other event] ${Object.keys(event).join(', ')}`);
    continue;
  }
  const message = data.status.message;
  if (data.status.state === TASK_STATE.IN_PROGRESS && message !== undefined) {
    deltaCount += 1;
    for (const part of message.parts) {
      if (typeof part.text === 'string') {
        process.stdout.write(part.text);
        accumulated.push(part.text);
      }
    }
  } else if (data.status.state === TASK_STATE.INPUT_REQUIRED) {
    const prompt = message !== undefined ? extractText(message) : '';
    process.stdout.write(`\n[input required] ${prompt}\n`);
    finalStatus = data;
  } else if (
    /TASK_STATE_(COMPLETED|FAILED|CANCELED|REJECTED)$/.test(data.status.state)
  ) {
    console.log('\n---');
    console.log(`[task ${data.taskId}] status=${data.status.state}`);
    finalStatus = data;
  }
}

console.log(`stream complete: ${deltaCount} delta event(s)`);
console.log(`assembled text: ${JSON.stringify(accumulated.join(''))}`);
if (finalStatus !== null) {
  console.log(`final status: ${JSON.stringify(finalStatus, null, 2)}`);
}

async function* readSSEEvents(
  body: ReadableStream<Uint8Array>
): AsyncIterable<StreamResponse> {
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
          yield (JSON.parse(payload) as { result: StreamResponse }).result;
        } catch (err) {
          console.error(`failed to parse SSE frame: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractText(message: Message): string {
  for (const part of message.parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      return part.text;
    }
  }
  return '';
}
