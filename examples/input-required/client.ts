import {
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL =
  nonEmpty(process.env['SERVER_URL']) ?? 'http://127.0.0.1:8080';
const PROMPT = nonEmpty(process.env['PROMPT']) ?? "What's the weather?";
const FOLLOW_UP = nonEmpty(process.env['FOLLOW_UP']) ?? 'Berlin';
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 20;

const client = createA2AClient({ baseURL: SERVER_URL });

const initial: Message = {
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text: PROMPT }],
};

console.log(`POST ${SERVER_URL}/  message/send  "${PROMPT}"`);
const created = await client.sendMessage({ message: initial });
console.log(`created task id=${created.id} state=${created.status.state}`);

const paused = await pollUntilStop(created.id);
console.log(`polled task state=${paused.status.state}`);

if (paused.status.state === TASK_STATE.INPUT_REQUIRED) {
  const prompt = extractText(paused.status.message);
  console.log(`agent asked: "${prompt}"`);

  const contextId = paused.contextId;
  if (typeof contextId !== 'string' || contextId.length === 0) {
    throw new Error('paused task is missing contextId; cannot resume');
  }

  const resumeMessage: Message = {
    messageId: crypto.randomUUID(),
    contextId,
    role: 'ROLE_USER',
    parts: [{ text: FOLLOW_UP }],
  };

  console.log(
    `POST ${SERVER_URL}/  message/send  "${FOLLOW_UP}" (resume, contextId=${contextId})`
  );
  const resumed = await client.sendMessage({ message: resumeMessage });
  console.log(`resumed task id=${resumed.id} state=${resumed.status.state}`);

  const final = await pollUntilTerminal(resumed.id);
  console.log(JSON.stringify(final, null, 2));
} else if (isTerminal(paused.status.state as ManagedTaskState)) {
  console.log(JSON.stringify(paused, null, 2));
} else {
  throw new Error(`unexpected non-stop task state ${paused.status.state}`);
}

async function pollUntilStop(taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const task = await client.getTask(taskId);
    const state = task.status.state as ManagedTaskState;
    if (state === TASK_STATE.INPUT_REQUIRED || isTerminal(state)) {
      return task;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `task ${taskId} did not reach INPUT_REQUIRED or a terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`
  );
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

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
