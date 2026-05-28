import {
  A2AServerBuilder,
  DefaultArtifactService,
  InMemoryArtifactStorage,
  InMemoryTaskStorage,
  TASK_GET_METHOD,
  TASK_STATE,
  createTaskGetHandler,
  isTerminal,
  transitionTask,
  type AgentCard,
  type ArtifactService,
  type BackgroundTaskHandler,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_NAME =
  process.env['A2A_AGENT_NAME'] ?? 'artifacts-with-default-handlers-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A2A server combining A2AServerBuilder.withDefaultStreamingTaskHandler() with a custom artifact-attaching background handler. Both message/send and message/stream are exposed.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const ARTIFACTS_BASE_URL =
  process.env['ARTIFACTS_BASE_URL'] ?? 'memory://artifacts';

const card: AgentCard = {
  name: AGENT_NAME,
  description: AGENT_DESCRIPTION,
  version: AGENT_VERSION,
  protocolVersion: '0.3.0',
  url: `http://${HOST}:${PORT}`,
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    {
      id: 'artifact-on-every-request',
      name: 'Artifact on every request',
      description:
        'Persists each incoming user message as a text artifact, attaches it to the task, and transitions the task to COMPLETED.',
      tags: ['artifacts', 'default-handlers', 'builder'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const artifactStorage = new InMemoryArtifactStorage({
  baseUrl: ARTIFACTS_BASE_URL,
});
const artifactService: ArtifactService = new DefaultArtifactService({
  storage: artifactStorage,
});

// `withDefaultStreamingTaskHandler()` installs the protocol-level streaming
// stub (a single `statusChanged(COMPLETED)` SSE frame).
//
// `withBackgroundTaskHandler(...)` replaces the analogous background stub with
// a custom handler that uses the artifact service to attach an artifact to
// every task.
//
// `withArtifactService(...)` is wired for symmetry with the Go ADK — the TS
// builder currently does not propagate it to the HTTP route, so this example
// drives artifact attachment from inside the custom handler. Use the
// lower-level `createA2AServer({ card, artifactStorage })` (see
// `examples/artifacts-filesystem/`) when you also need clients to download
// bytes through the ADK server's `/artifacts/:artifactId/:filename` route.
const builder = new A2AServerBuilder({ storage })
  .withAgentCard(card)
  .withArtifactService(artifactService)
  .withDefaultStreamingTaskHandler()
  .withBackgroundTaskHandler(createArtifactAttachingHandler(artifactService));

const server = builder.build();
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const backgroundHandler = builder.getBackgroundTaskHandler();
if (backgroundHandler === undefined) {
  throw new Error('builder did not install a background handler');
}

const abort = new AbortController();
const worker = runWorker(abort.signal, backgroundHandler).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  artifacts base: ${ARTIFACTS_BASE_URL}  (in-memory store)`);
console.log(
  `  card:           http://${HOST}:${PORT}/.well-known/agent-card.json`
);
console.log(`  health:         http://${HOST}:${PORT}/health`);
console.log(`  rpc:            POST http://${HOST}:${PORT}/`);
console.log(
  `  methods:        ${server.registeredMethods().sort().join(', ')}`
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

function createArtifactAttachingHandler(
  svc: ArtifactService
): BackgroundTaskHandler {
  return async ({ task, message, signal }) => {
    void message;
    const inProgress =
      task.state === TASK_STATE.PENDING
        ? transitionTask(task, TASK_STATE.IN_PROGRESS)
        : task;

    const userText = extractUserText(inProgress.messages);
    const noteBody =
      userText.length > 0
        ? userText
        : 'Hello from the with-default-handlers + artifacts example.';
    const filename = `note-${inProgress.id.slice(0, 8)}.txt`;

    const artifact = await svc.createFileArtifact(
      'User note',
      'Plain-text note persisted via the configured ArtifactService.',
      filename,
      new TextEncoder().encode(noteBody),
      { signal }
    );

    const downloadUri =
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
          text: `Saved your note as ${filename}. (URI: ${downloadUri})`,
        },
      ],
    };

    const withReply: ManagedTask = {
      ...inProgress,
      messages: [...inProgress.messages, replyMessage],
      artifacts: [...inProgress.artifacts, artifact],
    };
    return transitionTask(withReply, TASK_STATE.COMPLETED, {
      message: replyMessage,
    });
  };
}

async function runWorker(
  signal: AbortSignal,
  handler: BackgroundTaskHandler
): Promise<void> {
  while (!signal.aborted) {
    let task: ManagedTask;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    storage.updateActive(task);

    const triggering = task.messages[task.messages.length - 1] as Message;
    let result: ManagedTask;
    try {
      result = await handler({ task, message: triggering, signal });
    } catch (err) {
      console.error(`task ${task.id} handler threw:`, err);
      result = transitionTask(task, TASK_STATE.FAILED);
    }
    if (!isTerminal(result.state)) {
      result = transitionTask(result, TASK_STATE.FAILED);
    }
    storage.storeDeadLetter(result);
    console.log(
      `task ${task.id.slice(0, 8)} -> ${result.state} (artifacts attached: ${result.artifacts.length})`
    );
  }
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
