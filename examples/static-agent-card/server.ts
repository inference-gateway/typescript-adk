import {
  A2AServerBuilder,
  InMemoryTaskStorage,
  TASK_GET_METHOD,
  TASK_STATE,
  createTaskGetHandler,
  isTerminal,
  transitionTask,
  type BackgroundTaskHandler,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_CARD_FILE =
  process.env['A2A_AGENT_CARD_FILE'] ?? 'agent-card.json';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);

const storage = new InMemoryTaskStorage();

// ---------------------------------------------------------------------------
// The agent card is loaded from a JSON file instead of being hardcoded in
// TypeScript.  `${VAR}` placeholders in the JSON are resolved against
// `process.env` at the time `withAgentCardFromFile` is called — see
// `loadAgentCardFromFile` in `src/agent/card.ts`.
//
// The `overrides` parameter lets you pin fields (like `url`) at runtime
// regardless of what the file contains after placeholder resolution.
// ---------------------------------------------------------------------------
const builder = new A2AServerBuilder({ storage })
  .withAgentCardFromFile(AGENT_CARD_FILE, {
    url: `http://${HOST}:${PORT}`,
  })
  .withDefaultBackgroundTaskHandler();
const server = builder.build();

server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const backgroundHandler = builder.getBackgroundTaskHandler();
if (backgroundHandler === undefined) {
  throw new Error('expected withDefaultBackgroundTaskHandler() to install a handler');
}

const abort = new AbortController();
const worker = runEchoWorker(abort.signal, backgroundHandler).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`static-agent-card listening on http://${HOST}:${PORT}`);
console.log(`  card:   http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: http://${HOST}:${PORT}/health`);
console.log(`  rpc:    POST http://${HOST}:${PORT}/`);
console.log(`  config: ${AGENT_CARD_FILE}`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Minimal echo worker — same pattern as the other examples.  Each dequeued
// task is walked through PENDING → IN_PROGRESS → COMPLETED with an echo
// response that mentions the static-card configuration.
// ---------------------------------------------------------------------------
async function runEchoWorker(
  signal: AbortSignal,
  handler: BackgroundTaskHandler,
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
    console.log(`task ${task.id.slice(0, 8)} dequeued`);

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
        `task ${task.id.slice(0, 8)} did not reach a terminal state; recorded as FAILED`,
      );
    }
    storage.storeDeadLetter(result);
    console.log(`task ${task.id.slice(0, 8)} -> ${result.state}`);
  }
}
