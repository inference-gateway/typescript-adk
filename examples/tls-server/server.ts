import {
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
  isTerminal,
  loadServerTLSConfigFromEnv,
  transitionTask,
  type AgentCard,
  type ManagedTask,
  type Message,
  type ServerTLSConfig,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'tls-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'An A2A server that terminates TLS locally and echoes messages';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8443', 10);
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';

const tls: ServerTLSConfig | undefined = loadServerTLSConfigFromEnv();
if (tls === undefined) {
  console.error(
    'TLS_ENABLED must be true and TLS_CERT_PATH / TLS_KEY_PATH must be set.\n' +
      "Hint: run './generate-certs.sh' then\n" +
      '  TLS_ENABLED=true \\\n' +
      '  TLS_CERT_PATH=./certs/cert.pem \\\n' +
      '  TLS_KEY_PATH=./certs/key.pem \\\n' +
      '  pnpm --filter @inference-gateway/adk-example-tls-server start:server'
  );
  process.exit(1);
}

const card: AgentCard = {
  name: AGENT_NAME,
  description: AGENT_DESCRIPTION,
  version: AGENT_VERSION,
  protocolVersion: '0.3.0',
  url: `https://${HOST}:${PORT}`,
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    {
      id: 'echo',
      name: 'Echo',
      description: 'Echoes the user message back unchanged, over TLS.',
      tags: ['echo', 'tls'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card, tls });

server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const abort = new AbortController();
const worker = runEchoWorker(abort.signal).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('echo worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`tls-agent listening on https://${HOST}:${PORT}`);
console.log(`  card:   https://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: https://${HOST}:${PORT}/health`);
console.log(`  rpc:    POST https://${HOST}:${PORT}/`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function runEchoWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let task: ManagedTask;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    try {
      await handleEchoTask(task);
    } catch (err) {
      console.error(`task ${task.id} failed:`, err);
      const failed = transitionTask(task, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
    }
  }
}

async function handleEchoTask(task: ManagedTask): Promise<void> {
  const inProgress = transitionTask(task, TASK_STATE.IN_PROGRESS);
  storage.updateActive(inProgress);

  const userText = extractUserText(inProgress.messages);
  const responseText =
    userText.length > 0
      ? `Echo (over TLS): ${userText}`
      : "Hello over TLS! Send me a message and I'll echo it back.";

  const responseMessage: Message = {
    messageId: crypto.randomUUID(),
    contextId: inProgress.contextId,
    taskId: inProgress.id,
    role: 'ROLE_AGENT',
    parts: [{ text: responseText }],
  };

  const withResponse: ManagedTask = {
    ...inProgress,
    messages: [...inProgress.messages, responseMessage],
  };
  const completed = transitionTask(withResponse, TASK_STATE.COMPLETED, {
    message: responseMessage,
  });

  if (!isTerminal(completed.state)) {
    throw new Error('task did not reach a terminal state');
  }
  storage.storeDeadLetter(completed);
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
