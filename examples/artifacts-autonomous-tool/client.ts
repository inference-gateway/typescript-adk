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
const PROMPTS: readonly string[] =
  process.env['PROMPTS'] !== undefined && process.env['PROMPTS'].length > 0
    ? process.env['PROMPTS'].split('||')
    : [
        'Write a 3-paragraph executive summary of the Apollo 11 mission and surface it as a Markdown artifact.',
        'Generate a JSON file with the names and birth years of the first five US presidents and save it as an artifact.',
      ];
const POLL_INTERVAL_MS = 500;
const POLL_MAX_ATTEMPTS = 120;

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
  console.log(`task ${created.id} created (state=${created.status.state})`);

  const final = await pollUntilTerminal(created.id);
  if (final.status.state !== TASK_STATE.COMPLETED) {
    console.warn(
      `task ${created.id} finished in non-success state ${final.status.state}.`
    );
    console.log(JSON.stringify(final, null, 2));
    continue;
  }

  console.log(`response: ${extractText(final.status.message)}`);
  const artifacts = final.artifacts ?? [];
  console.log(`artifacts attached: ${artifacts.length}`);
  for (const artifact of artifacts) {
    const uri = extractUri(artifact);
    console.log(`  ${artifact.artifactId} -> ${uri ?? '(no uri)'}`);
    if (uri !== undefined) {
      await previewDownload(uri);
    }
  }
}

async function previewDownload(uri: string): Promise<void> {
  const response = await fetch(uri);
  if (!response.ok) {
    console.error(
      `  download failed: ${response.status} ${response.statusText}`
    );
    return;
  }
  const text = await response.text();
  const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  console.log(`  content-type: ${response.headers.get('content-type')}`);
  console.log(`  content (${text.length} bytes): ${preview}`);
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
      return task;
    }
    process.stdout.write('.');
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
