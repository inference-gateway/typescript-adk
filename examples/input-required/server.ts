import {
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

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'input-required-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'A demo agent that pauses to ask for a missing city before answering a weather question.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';

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
      id: 'weather',
      name: 'Weather (demo)',
      description:
        'Answers a weather question, pausing to ask for the city when the user omits one. Returns canned text - no real weather data is fetched.',
      tags: ['weather', 'input-required', 'demo'],
    },
  ],
};

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card });

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
console.log(`  card:   http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: http://${HOST}:${PORT}/health`);
console.log(`  rpc:    POST http://${HOST}:${PORT}/`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
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
      await handleWeatherTask(task);
    } catch (err) {
      console.error(`task ${task.id} failed:`, err);
      const working =
        task.state === TASK_STATE.PENDING
          ? transitionTask(task, TASK_STATE.IN_PROGRESS)
          : task;
      const failed = transitionTask(working, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
    }
  }
}

async function handleWeatherTask(task: ManagedTask): Promise<void> {
  // Both first-time (`PENDING`) and resumed (`IN_PROGRESS`) tasks land here.
  // The `message/send` handler has already transitioned a resume to
  // `IN_PROGRESS`; first-time tasks start in `PENDING` and need an explicit
  // step before reaching `INPUT_REQUIRED` or `COMPLETED`.
  const working =
    task.state === TASK_STATE.PENDING
      ? transitionTask(task, TASK_STATE.IN_PROGRESS)
      : task;
  storage.updateActive(working);

  const userMessages = working.messages.filter((m) => m.role === 'ROLE_USER');
  const latestUserText = extractText(userMessages.at(-1));

  // More than one user message means the client has supplied the follow-up
  // requested during the prior `INPUT_REQUIRED` pause - treat it as the city.
  if (userMessages.length > 1) {
    completeWith(
      working,
      `The weather in ${latestUserText} is sunny and 72°F. (demo response - no real weather data is fetched)`
    );
    return;
  }

  if (
    looksLikeWeatherQuery(latestUserText) &&
    !mentionsLocation(latestUserText)
  ) {
    pauseFor(
      working,
      'I can check the weather for you. Which city would you like the forecast for?'
    );
    return;
  }

  completeWith(
    working,
    "Hi! Ask me about the weather - I'll pause to ask for the city if you omit one."
  );
}

function pauseFor(task: ManagedTask, prompt: string): void {
  const message = buildAgentMessage(task, prompt);
  const withMessage: ManagedTask = {
    ...task,
    messages: [...task.messages, message],
  };
  const paused = transitionTask(withMessage, TASK_STATE.INPUT_REQUIRED, {
    message,
  });
  storage.updateActive(paused);
  console.log(`task ${task.id} paused for input: "${prompt}"`);
}

function completeWith(task: ManagedTask, responseText: string): void {
  const message = buildAgentMessage(task, responseText);
  const withMessage: ManagedTask = {
    ...task,
    messages: [...task.messages, message],
  };
  const completed = transitionTask(withMessage, TASK_STATE.COMPLETED, {
    message,
  });
  if (!isTerminal(completed.state)) {
    throw new Error('task did not reach a terminal state');
  }
  storage.storeDeadLetter(completed);
  console.log(`task ${task.id} completed: "${responseText}"`);
}

function buildAgentMessage(task: ManagedTask, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: task.contextId,
    taskId: task.id,
    role: 'ROLE_AGENT',
    parts: [{ text }],
  };
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

function looksLikeWeatherQuery(text: string): boolean {
  return /weather|forecast|temperature/i.test(text);
}

function mentionsLocation(text: string): boolean {
  return /\b(?:in|at|for)\s+\w+/i.test(text);
}
