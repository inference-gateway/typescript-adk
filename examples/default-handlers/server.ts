import {
  A2AServerBuilder,
  InMemoryTaskStorage,
  TASK_GET_METHOD,
  TASK_STATE,
  createTaskGetHandler,
  isTerminal,
  transitionTask,
  type AgentCard,
  type BackgroundTaskHandler,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'default-handlers-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A2A server wired up with A2AServerBuilder.withDefaultTaskHandlers() — exposes both message/send and message/stream with the built-in stub handlers.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);

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
      id: 'default-handlers-demo',
      name: 'Default handlers demo',
      description:
        'Demonstrates the builder-installed default task handlers. message/send walks tasks PENDING -> IN_PROGRESS -> COMPLETED via the background stub; message/stream emits a single statusChanged(COMPLETED) frame via the streaming stub.',
      tags: ['default-handlers', 'demo'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const builder = new A2AServerBuilder({ storage })
  .withAgentCard(card)
  .withDefaultTaskHandlers();
const server = builder.build();

server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const backgroundHandler = builder.getBackgroundTaskHandler();
if (backgroundHandler === undefined) {
  throw new Error(
    'unexpected: withDefaultTaskHandlers() did not install a background handler'
  );
}

const abort = new AbortController();
const worker = runWorker(abort.signal, backgroundHandler).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  card:   http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: http://${HOST}:${PORT}/health`);
console.log(`  rpc:    POST http://${HOST}:${PORT}/`);
console.log(`  methods: ${server.registeredMethods().sort().join(', ')}`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

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
    console.log(`task ${task.id.slice(0, 8)} dequeued (message/send path)`);

    let result: ManagedTask;
    try {
      result = await handler({ task, message: triggering, signal });
    } catch (err) {
      console.error(`task ${task.id} handler threw:`, err);
      result = transitionTask(task, TASK_STATE.FAILED);
    }

    if (!isTerminal(result.state)) {
      result = transitionTask(result, TASK_STATE.FAILED);
      console.warn(
        `task ${task.id.slice(0, 8)} did not reach a terminal state; recorded as FAILED`
      );
    }
    storage.storeDeadLetter(result);
    console.log(`task ${task.id.slice(0, 8)} -> ${result.state}`);
  }
}
