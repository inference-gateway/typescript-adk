import {
  A2AServerBuilder,
  InMemoryTaskStorage,
  TASK_GET_METHOD,
  TASK_STATE,
  createTaskGetHandler,
  isTerminal,
  loadAgentCardFromFile,
  transitionTask,
  type AgentCard,
  type BackgroundTaskHandler,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_CARD_FILE = process.env['A2A_AGENT_CARD_FILE'] ?? 'agent-card.json';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);

const storage = new InMemoryTaskStorage();

// ---------------------------------------------------------------------------
// Load the agent card up front so the skill-routing handler below can close
// over the resolved card. `${VAR}` placeholders are resolved against
// `process.env` at load time — see `loadAgentCardFromFile` in
// `src/agent/card.ts`. The `overrides` map wins over values from the JSON
// after placeholder substitution, which is useful for genuinely-runtime
// fields like `url`.
//
// `builder.withAgentCardFromFile(filePath, overrides)` is the one-liner sugar
// when you don't need the card outside the builder.
// ---------------------------------------------------------------------------
const card = loadAgentCardFromFile(AGENT_CARD_FILE, {
  overrides: { url: `http://${HOST}:${PORT}` },
});

const builder = new A2AServerBuilder({ storage })
  .withAgentCard(card)
  .withBackgroundTaskHandler(createStaticCardHandler(card));
const server = builder.build();

server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));

const backgroundHandler = builder.getBackgroundTaskHandler();
if (backgroundHandler === undefined) {
  throw new Error('expected withBackgroundTaskHandler() to install a handler');
}

const abort = new AbortController();
const worker = runWorker(abort.signal, backgroundHandler).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`${card.name} listening on http://${HOST}:${PORT}`);
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
// Worker — dequeues each pending task and dispatches it to the configured
// background handler. The handler implements skill-id routing.
// ---------------------------------------------------------------------------
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
        `task ${task.id.slice(0, 8)} did not reach a terminal state; recorded as FAILED`
      );
    }
    storage.storeDeadLetter(result);
    console.log(`task ${task.id.slice(0, 8)} -> ${result.state}`);
  }
}

// ---------------------------------------------------------------------------
// Skill-aware background handler.
//
// The A2A wire protocol does not carry a skill id on each Message — skills are
// metadata advertised on the agent card. So this example routes by matching
// keywords in the user text against the two skills declared in
// `agent-card.json`:
//
//   - "config" / "configuration" / "info" / "about"  → config-info
//   - anything else                                  → echo
//
// The handler closes over the resolved `AgentCard` so the config-info branch
// can surface the values that `${VAR}` placeholders were substituted with.
// ---------------------------------------------------------------------------
function createStaticCardHandler(card: AgentCard): BackgroundTaskHandler {
  return ({ task, message }) => {
    let next = task;
    if (next.state === TASK_STATE.PENDING) {
      next = transitionTask(next, TASK_STATE.IN_PROGRESS);
    }

    const userText = extractText(message.parts);
    const skillId = routeSkill(userText);
    const responseText = renderResponse(skillId, userText, card);

    const responseMessage: Message = {
      messageId: crypto.randomUUID(),
      role: 'ROLE_AGENT',
      contextId: next.contextId,
      taskId: next.id,
      parts: [{ text: responseText }],
    };

    const withResponse: ManagedTask = {
      ...next,
      messages: [...next.messages, responseMessage],
    };
    return transitionTask(withResponse, TASK_STATE.COMPLETED, {
      message: responseMessage,
    });
  };
}

function routeSkill(userText: string): 'config-info' | 'echo' {
  const lower = userText.toLowerCase();
  if (
    lower.includes('config') ||
    lower.includes('info') ||
    lower.includes('about')
  ) {
    return 'config-info';
  }
  return 'echo';
}

function renderResponse(
  skillId: 'config-info' | 'echo',
  userText: string,
  card: AgentCard
): string {
  if (skillId === 'config-info') {
    const skillList = card.skills
      .map((s) => `  - ${s.id}: ${s.name}`)
      .join('\n');
    return [
      '[skill=config-info] Configuration loaded from agent-card.json:',
      `  name:        ${card.name}`,
      `  version:     ${card.version}`,
      `  description: ${card.description}`,
      `  url:         ${card.url ?? '(unset)'}`,
      `  skills:`,
      skillList,
    ].join('\n');
  }
  const body = userText.length > 0 ? userText : '(empty message)';
  return `[skill=echo] You said: ${body}`;
}

function extractText(parts: Message['parts']): string {
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .filter((s) => s.length > 0)
    .join('\n');
}
