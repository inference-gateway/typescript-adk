import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultArtifactService,
  FilesystemArtifactStorage,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
  isTerminal,
  transitionTask,
  type AgentCard,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_NAME =
  process.env['A2A_AGENT_NAME'] ?? 'artifacts-filesystem-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A2A agent that turns each request into a stored text artifact on disk via FilesystemArtifactStorage.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const ARTIFACTS_ROOT =
  process.env['ARTIFACTS_ROOT'] ?? join(tmpdir(), 'adk-artifacts-filesystem');
const ARTIFACTS_BASE_URL =
  process.env['ARTIFACTS_BASE_URL'] ?? `http://${HOST}:${PORT}/artifacts`;

const card: AgentCard = {
  name: AGENT_NAME,
  description: AGENT_DESCRIPTION,
  version: AGENT_VERSION,
  protocolVersion: '0.3.0',
  url: `http://${HOST}:${PORT}`,
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    {
      id: 'note-to-file',
      name: 'Note to file',
      description:
        'Persists the incoming user message as a text artifact on the local filesystem and replies with the download URL.',
      tags: ['artifacts', 'filesystem', 'demo'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const artifactStorage = new FilesystemArtifactStorage({
  root: ARTIFACTS_ROOT,
  baseUrl: ARTIFACTS_BASE_URL,
});
const artifactService = new DefaultArtifactService({
  storage: artifactStorage,
});

const server = createA2AServer({ card, artifactStorage });

server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const abort = new AbortController();
const worker = runWorker(abort.signal).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  artifacts root: ${ARTIFACTS_ROOT}`);
console.log(`  artifacts base: ${ARTIFACTS_BASE_URL}`);
console.log(
  `  card:           http://${HOST}:${PORT}/.well-known/agent-card.json`
);
console.log(`  health:         http://${HOST}:${PORT}/health`);
console.log(`  rpc:            POST http://${HOST}:${PORT}/`);
console.log(
  `  download:       GET  http://${HOST}:${PORT}/artifacts/:artifactId/:filename`
);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  await artifactService.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function runWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let task: ManagedTask;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    try {
      await handleNoteTask(task, signal);
    } catch (err) {
      console.error(`task ${task.id} failed:`, err);
      const failed = transitionTask(task, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
    }
  }
}

async function handleNoteTask(
  task: ManagedTask,
  signal: AbortSignal
): Promise<void> {
  const inProgress = transitionTask(task, TASK_STATE.IN_PROGRESS);
  storage.updateActive(inProgress);

  const userText = extractUserText(inProgress.messages);
  const noteBody =
    userText.length > 0
      ? userText
      : 'Hello! Send any text and I will write it to disk as an artifact.';
  const filename = `note-${inProgress.id.slice(0, 8)}.txt`;

  const artifact = await artifactService.createFileArtifact(
    'User note',
    'Plain-text note persisted via FilesystemArtifactStorage.',
    filename,
    new TextEncoder().encode(noteBody),
    { signal }
  );

  const downloadUrl =
    typeof artifact.parts[0]?.file?.fileWithUri === 'string'
      ? artifact.parts[0].file.fileWithUri
      : '(no uri)';

  const replyMessage: Message = {
    messageId: crypto.randomUUID(),
    contextId: inProgress.contextId,
    taskId: inProgress.id,
    role: 'ROLE_AGENT',
    parts: [
      {
        text: `Saved your note as ${filename}. Download it from ${downloadUrl}.`,
      },
    ],
  };

  const withReply: ManagedTask = {
    ...inProgress,
    messages: [...inProgress.messages, replyMessage],
    artifacts: [...inProgress.artifacts, artifact],
  };
  const completed = transitionTask(withReply, TASK_STATE.COMPLETED, {
    message: replyMessage,
  });

  if (!isTerminal(completed.state)) {
    throw new Error('task did not reach a terminal state');
  }
  storage.storeDeadLetter(completed);
  console.log(
    `task ${task.id.slice(0, 8)} -> COMPLETED (artifact ${artifact.artifactId.slice(0, 8)} -> ${downloadUrl})`
  );
}

function extractUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== 'ROLE_USER') continue;
    for (const part of msg.parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        return part.text;
      }
    }
  }
  return '';
}
