import {
  AGENT_EVENT_TYPE,
  JSONRPC_VERSION,
  MESSAGE_STREAM_METHOD,
  TASK_STATE,
  type AgentIterationCompletedEventData,
  type AgentToolEventData,
  type AgentToolFailedEventData,
  type AgentToolResultEventData,
  type CloudEvent,
  type Message,
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
let iterationCount = 0;
let toolCallCount = 0;
let finalStatus: TaskStatusUpdateEvent | null = null;

for await (const event of readSSEEvents(response.body)) {
  switch (event.type) {
    case AGENT_EVENT_TYPE.TASK_STATUS_CHANGED: {
      const data = event.data as TaskStatusUpdateEvent;
      if (data.status.state === TASK_STATE.IN_PROGRESS && data.final !== true) {
        // First IN_PROGRESS frame opens the stream — re-emitted periodically as
        // a keep-alive. Only log the first one to keep output readable.
        if (finalStatus === null && deltaCount === 0) {
          console.log(
            `[task ${data.taskId}] status=IN_PROGRESS final=${data.final}`
          );
          console.log('---');
        }
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
    case AGENT_EVENT_TYPE.ITERATION_COMPLETED: {
      const data = event.data as AgentIterationCompletedEventData;
      iterationCount = data.iteration;
      break;
    }
    case AGENT_EVENT_TYPE.TOOL_STARTED: {
      const data = event.data as AgentToolEventData;
      toolCallCount += 1;
      process.stdout.write(
        `\n[tool ${data.toolName} started] args=${data.arguments ?? '{}'}\n`
      );
      break;
    }
    case AGENT_EVENT_TYPE.TOOL_COMPLETED: {
      const data = event.data as AgentToolEventData;
      process.stdout.write(`[tool ${data.toolName} completed]\n`);
      break;
    }
    case AGENT_EVENT_TYPE.TOOL_FAILED: {
      const data = event.data as AgentToolFailedEventData;
      process.stdout.write(
        `[tool ${data.toolName} failed] error=${data.error}\n`
      );
      break;
    }
    case AGENT_EVENT_TYPE.TOOL_RESULT: {
      const data = event.data as AgentToolResultEventData;
      process.stdout.write(
        `[tool ${data.toolName} -> ${data.isError ? 'error' : 'ok'}] ${data.result}\n`
      );
      break;
    }
    case AGENT_EVENT_TYPE.INPUT_REQUIRED: {
      const message = event.data as Message;
      const prompt = extractText(message);
      process.stdout.write(`\n[input required] ${prompt}\n`);
      break;
    }
    default:
      console.log(`[unknown event] type=${event.type}`);
  }
}

console.log(
  `stream complete: ${deltaCount} delta event(s), ${iterationCount} iteration(s), ${toolCallCount} tool call(s)`
);
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

function extractText(message: Message): string {
  for (const part of message.parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      return part.text;
    }
  }
  return '';
}
