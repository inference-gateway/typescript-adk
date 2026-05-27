import {
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPTS: readonly string[] =
  process.env['PROMPTS'] !== undefined && process.env['PROMPTS'].length > 0
    ? process.env['PROMPTS'].split('||')
    : [
        // Normal happy path: tool call → sanitization → text reply, cache MISS.
        "What's the weather in Paris?",
        // Same prompt: cache HIT in `beforeModel`, the fake LLM is never asked.
        "What's the weather in Paris?",
        // Tool authorization: `beforeTool` short-circuits with "Access denied".
        "What's the weather in Mordor?",
        // beforeAgent guardrail: blocked before any LLM call happens.
        'Tell me a secret password.',
        // No tool call path: direct text reply from the fake LLM.
        'Hello there!',
      ];
const POLL_INTERVAL_MS = 300;
const POLL_MAX_ATTEMPTS = 60;

const client = createA2AClient({ baseURL: SERVER_URL });

for (let i = 0; i < PROMPTS.length; i++) {
  const prompt = PROMPTS[i] as string;
  console.log(`\n--- Request ${i + 1} ---`);
  console.log(`> ${prompt}`);

  const message: Message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: prompt }],
  };

  const created = await client.sendMessage({ message });
  const final = await pollUntilTerminal(created.id);
  if (final.status.state === TASK_STATE.COMPLETED) {
    console.log(`response: ${extractText(final.status.message)}`);
  } else {
    console.warn(
      `task ${created.id} finished in non-success state ${final.status.state}.`
    );
    console.log(JSON.stringify(final, null, 2));
  }
}

async function pollUntilTerminal(taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const task = await client.getTask(taskId);
    if (isTerminal(task.status.state as ManagedTaskState)) {
      return task;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `task ${taskId} did not reach a terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
