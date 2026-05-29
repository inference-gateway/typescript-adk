import {
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';
const PROMPT =
  process.env['PROMPT'] ?? 'Hello! Tell me about your static configuration.';

const POLL_INTERVAL_MS = 300;
const POLL_MAX_ATTEMPTS = 60;

const client = createA2AClient({ baseURL: SERVER_URL });

// ---------------------------------------------------------------------------
// 1. Fetch the agent card to show the static configuration loaded from JSON.
// ---------------------------------------------------------------------------
console.log('=== Agent Card (loaded from agent-card.json) ===');
const agentCard = await client.getAgentCard();
console.log(JSON.stringify(agentCard, null, 2));

console.log(`\nAgent: ${agentCard.name}`);
console.log(`Version: ${agentCard.version}`);
console.log(`Description: ${agentCard.description}`);
console.log(`Skills: ${agentCard.skills.map((s) => s.name).join(', ')}`);

// ---------------------------------------------------------------------------
// 2. Send a message and poll until the task reaches a terminal state.
// ---------------------------------------------------------------------------
console.log(`\n=== Sending message ===`);
console.log(`POST ${SERVER_URL}/  message/send  "${PROMPT}"`);

const sendMessage: Message = {
  messageId: crypto.randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text: PROMPT }],
};

const created = await client.sendMessage({ message: sendMessage });
console.log(`created task id=${created.id} state=${created.status.state}`);

const completed = await pollUntilTerminal(created.id);
console.log(`\nfinal state: ${completed.status.state}`);
console.log(`final task:\n${JSON.stringify(completed, null, 2)}`);

console.log('\n=== Static agent card demonstration completed ===');
console.log(
  'The agent card above was loaded from agent-card.json using withAgentCardFromFile().',
);
console.log(
  '${VAR} placeholders in that JSON were resolved against process.env at server startup.',
);

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------
async function pollUntilTerminal(taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const task = await client.getTask(taskId);
    if (isTerminal(task.status.state as ManagedTaskState)) {
      return task;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `task ${taskId} did not reach a terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
