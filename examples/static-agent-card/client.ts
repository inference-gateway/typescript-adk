import {
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
  type Message,
  type Task,
} from '@inference-gateway/adk';

const SERVER_URL = process.env['SERVER_URL'] ?? 'http://127.0.0.1:8080';

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
// 2. Send one message that routes to each skill the agent card declares.
//    The server picks the skill by matching keywords in the user text; setting
//    PROMPT overrides the first prompt below.
// ---------------------------------------------------------------------------
const prompts: readonly string[] = [
  process.env['PROMPT'] ?? 'Tell me about your static configuration.',
  'Please echo this sentence back to me verbatim.',
];

for (const prompt of prompts) {
  console.log(`\n=== Sending message ===`);
  console.log(`POST ${SERVER_URL}/  message/send  "${prompt}"`);

  const sendMessage: Message = {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: prompt }],
  };

  const created = await client.sendMessage({ message: sendMessage });
  console.log(`created task id=${created.id} state=${created.status.state}`);

  const completed = await pollUntilTerminal(created.id);
  console.log(`final state: ${completed.status.state}`);
  const agentReply = lastAgentText(completed);
  if (agentReply !== undefined) {
    console.log(`agent reply:\n${agentReply}`);
  }
}

console.log('\n=== Static agent card demonstration completed ===');
console.log(
  'The agent card above was loaded from agent-card.json using loadAgentCardFromFile().'
);
console.log(
  '${VAR} placeholders in that JSON were resolved against process.env at server startup.'
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
    `task ${taskId} did not reach a terminal state within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS}ms`
  );
}

function lastAgentText(task: Task): string | undefined {
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg === undefined || msg.role !== 'ROLE_AGENT') continue;
    const text = msg.parts
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter((s) => s.length > 0)
      .join('\n');
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
