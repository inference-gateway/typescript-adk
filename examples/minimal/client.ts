import {
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPT =
  process.env['PROMPT'] ??
  'Hello, this is a test message. Please respond with a greeting.';
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 20;

const client = createA2AClient({ baseURL: SERVER_URL });

const message: Message = {
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text: PROMPT }],
};

console.log(`POST ${SERVER_URL}/  message/send  "${PROMPT}"`);
const created = await client.sendMessage({ message });
console.log(`created task id=${created.id} state=${created.status.state}`);

const completed = await pollUntilTerminal(created.id);
console.log(JSON.stringify(completed, null, 2));

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
