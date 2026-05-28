import {
  TASK_STATE,
  createA2AClient,
  isTerminal,
  type Artifact,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPT =
  process.env['PROMPT'] ??
  'Hello from the MinIO artifacts example - please write this note to the bucket.';
const POLL_INTERVAL_MS = 300;
const POLL_MAX_ATTEMPTS = 40;

const client = createA2AClient({ baseURL: SERVER_URL });

const sendMessage: Message = {
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text: PROMPT }],
};
console.log(`POST ${SERVER_URL}/  message/send  "${PROMPT}"`);
const created = await client.sendMessage({ message: sendMessage });
console.log(`created task id=${created.id} state=${created.status.state}`);

const completed = await pollUntilTerminal(created.id);
console.log(`final state: ${completed.status.state}`);

const artifacts = completed.artifacts ?? [];
console.log(`artifacts attached: ${artifacts.length}`);
for (const artifact of artifacts) {
  const uri = extractUri(artifact);
  console.log(`  ${artifact.artifactId} -> ${uri ?? '(no uri)'}`);
  if (uri !== undefined) {
    await downloadAndPrint(uri);
  }
}

async function downloadAndPrint(uri: string): Promise<void> {
  const response = await fetch(uri);
  if (!response.ok) {
    console.error(
      `  download failed: ${response.status} ${response.statusText}`
    );
    return;
  }
  const text = await response.text();
  console.log(`  content-type: ${response.headers.get('content-type')}`);
  console.log(`  content: ${text}`);
}

function extractUri(artifact: Artifact): string | undefined {
  for (const part of artifact.parts) {
    if (typeof part.file?.fileWithUri === 'string') {
      return part.file.fileWithUri;
    }
  }
  return undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
