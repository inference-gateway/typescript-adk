import {
  DefaultBackgroundTaskHandler,
  DefaultToolBox,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
  createTool,
  isTerminal,
  transitionTask,
  type AfterAgentCallback,
  type AfterModelCallback,
  type AfterToolCallback,
  type AgentCard,
  type BeforeAgentCallback,
  type BeforeModelCallback,
  type BeforeToolCallback,
  type Callbacks,
  type ChatMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'callbacks-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'Demo agent wiring all six callback hook points: caching, guardrail, audit log.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);

const BLOCKED_INPUT_PATTERN = /\b(secret|password|confidential)\b/i;
const BLOCKED_LOCATIONS: ReadonlySet<string> = new Set(['Mordor', 'Atlantis']);

// Side-channel for the worker to share the triggering user text with the
// `beforeAgent` callback. The callback only receives a `CallbackContext`
// (no task/messages), so we look up by `taskId` from this closure-captured map.
// The worker clears the entry once `handle()` returns to keep the map bounded.
const userInputs = new Map<string, string>();

// Module-level prompt cache exercised by the `beforeModel` callback. Real
// deployments would back this with Redis or similar; an in-memory Map keeps the
// example deterministic and dependency-free.
const promptCache = new Map<string, CompletionResult>();

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
      id: 'callbacks-demo',
      name: 'Callbacks demo',
      description:
        'Answers weather questions with a fake LLM while exercising every callback hook (guardrail, cache, audit, sanitization).',
      tags: ['callbacks', 'demo'],
    },
  ],
};

const toolBox = new DefaultToolBox();
toolBox.addTool(
  createTool({
    name: 'get_weather',
    description: 'Get current weather information for a named location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The city name, e.g. "Paris" or "Tokyo".',
        },
      },
      required: ['location'],
    },
    execute: async (rawArgs) => {
      const args = parseArgs<{ readonly location?: string }>(rawArgs);
      const location = args.location ?? 'unknown';
      return JSON.stringify({
        location,
        temperature: '22C',
        condition: 'sunny',
        humidity: '65%',
        api_key: 'sk-demo-shhh-this-should-be-redacted',
      });
    },
  })
);

// 1. beforeAgent - guardrail: refuse inputs containing forbidden keywords and
//    return a canned `Message` so the surrounding handler short-circuits the
//    entire LLM loop and the after-agent chain.
const guardrailBeforeAgent: BeforeAgentCallback = (context) => {
  const userText = userInputs.get(context.taskId) ?? '';
  const match = BLOCKED_INPUT_PATTERN.exec(userText);
  if (match !== null) {
    console.log(
      `[guardrail] blocked input matching /${BLOCKED_INPUT_PATTERN.source}/ (task=${context.taskId.slice(0, 8)})`
    );
    return {
      messageId: crypto.randomUUID(),
      role: 'ROLE_AGENT',
      contextId: context.contextId,
      taskId: context.taskId,
      parts: [
        {
          text: 'Sorry - I cannot help with requests involving secrets, passwords, or confidential data.',
        },
      ],
    };
  }
  console.log(`[guardrail] input cleared (task=${context.taskId.slice(0, 8)})`);
  return undefined;
};

// 2. beforeModel - cache: serve a known prompt straight from memory and skip
//    the LLM call entirely.
const cacheBeforeModel: BeforeModelCallback = (_context, request) => {
  const key = cacheKey(request.messages);
  const cached = promptCache.get(key);
  if (cached !== undefined) {
    console.log(`[cache] HIT for key="${key}"`);
    return cached;
  }
  console.log(`[cache] MISS for key="${key}"`);
  return undefined;
};

// 3. afterModel - audit log: log token usage and shape of the response.
const auditAfterModel: AfterModelCallback = (_context, response) => {
  const usage = response.usage;
  const usageText =
    usage !== undefined
      ? `tokens=${usage.totalTokens ?? usage.promptTokens + usage.completionTokens}`
      : 'tokens=?';
  const hasToolCalls = (response.message.toolCalls ?? []).length > 0;
  console.log(
    `[audit] llm response received (${usageText}, tool_calls=${hasToolCalls ? 'yes' : 'no'})`
  );
  return undefined;
};

// 4. beforeTool - authorization: short-circuit blocked locations without
//    invoking the underlying tool. The returned string is fed back to the LLM
//    as the tool result.
const authorizationBeforeTool: BeforeToolCallback = (context, toolCall) => {
  if (toolCall.name === 'get_weather') {
    const args = parseArgs<{ readonly location?: string }>(toolCall.arguments);
    if (args.location !== undefined && BLOCKED_LOCATIONS.has(args.location)) {
      console.log(
        `[authorization] blocked tool call ${toolCall.name}(location="${args.location}") (task=${context.taskId.slice(0, 8)})`
      );
      return `Access denied: weather lookup for "${args.location}" is not permitted.`;
    }
  }
  console.log(`[authorization] allowed tool call ${toolCall.name}`);
  return undefined;
};

// 5. afterTool - sanitization: redact a sensitive field from the tool result
//    before it is fed back to the LLM.
const sanitizationAfterTool: AfterToolCallback = (
  _context,
  toolCall,
  result
) => {
  if (toolCall.name !== 'get_weather') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if ('api_key' in parsed) {
      delete parsed['api_key'];
      console.log(
        `[sanitization] redacted api_key field from ${toolCall.name} result`
      );
      return JSON.stringify(parsed);
    }
  } catch {
    return undefined;
  }
  return undefined;
};

// 6. afterAgent - audit footer: append a trailing line to the final agent
//    message so callers can see the after-agent chain replaced the output.
const footerAfterAgent: AfterAgentCallback = (context, output) => {
  const original = extractText(output);
  const footer = `\n\n- audited by ${AGENT_NAME} (task=${context.taskId.slice(0, 8)})`;
  console.log('[audit] appending footer to agent output');
  return {
    messageId: crypto.randomUUID(),
    role: 'ROLE_AGENT',
    contextId: context.contextId,
    taskId: context.taskId,
    parts: [{ text: `${original}${footer}` }],
  };
};

const callbacks: Callbacks = {
  beforeAgent: [guardrailBeforeAgent],
  afterAgent: [footerAfterAgent],
  beforeModel: [cacheBeforeModel],
  afterModel: [auditAfterModel],
  beforeTool: [authorizationBeforeTool],
  afterTool: [sanitizationAfterTool],
};

const handler = new DefaultBackgroundTaskHandler({
  llmClient: createFakeLLMClient(promptCache),
  toolBox,
  callbacks,
  agentName: AGENT_NAME,
});

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
    storage.updateActive(task);

    const triggering = task.messages[task.messages.length - 1] as Message;
    const userText = extractText(triggering);

    userInputs.set(task.id, userText);
    console.log(`\ntask ${task.id.slice(0, 8)} dequeued: "${userText}"`);
    let result: ManagedTask;
    try {
      result = await handler.handle({
        task,
        message: triggering,
        signal,
      });
    } finally {
      userInputs.delete(task.id);
    }

    if (isTerminal(result.state)) {
      storage.storeDeadLetter(result);
      console.log(`task ${task.id.slice(0, 8)} -> ${result.state}`);
    } else {
      const failed = transitionTask(result, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
      console.warn(
        `task ${task.id.slice(0, 8)} did not reach a terminal state (got ${result.state}); recorded as FAILED`
      );
    }
  }
}

function parseArgs<T>(raw: string): T {
  if (raw.length === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
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

function cacheKey(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === 'user') {
      return msg.content.toLowerCase().trim();
    }
  }
  return '';
}

/**
 * Deterministic, no-network fake LLM. Mirrors the shape the
 * {@link DefaultBackgroundTaskHandler} expects from a real OpenAI-compatible
 * client so the example is fully self-contained and CI-runnable.
 *
 *  - "weather in <city>"           → tool call to `get_weather`, then text.
 *  - any other text                → direct text reply, no tool call.
 *
 * Also seeds the supplied cache on terminal text responses so a repeated
 * prompt observably hits the `beforeModel` cache.
 *
 * Exposed as a factory (rather than a class) so its definition is hoisted
 * above the handler that wires it in.
 */
function createFakeLLMClient(cache: Map<string, CompletionResult>): LLMClient {
  return {
    async createCompletion(
      opts: CreateCompletionOptions
    ): Promise<CompletionResult> {
      const userText = lastUserText(opts.messages);
      const toolResult = lastToolText(opts.messages);

      // If a tool result is already in the conversation, this is the
      // second-pass call - produce the final text reply.
      if (toolResult !== undefined) {
        const text = summarizeWeather(toolResult, userText);
        const result: CompletionResult = {
          message: { content: text },
          usage: { promptTokens: 24, completionTokens: 16, totalTokens: 40 },
        };
        cache.set(userText.toLowerCase().trim(), result);
        return result;
      }

      const weatherMatch =
        /weather (?:in|for|at) ([\p{L} ]+?)(?:\?|$|\.)/iu.exec(userText);
      if (weatherMatch !== null) {
        const location = (weatherMatch[1] ?? 'unknown').trim();
        return {
          message: {
            toolCalls: [
              {
                id: `call_${crypto.randomUUID().slice(0, 8)}`,
                name: 'get_weather',
                arguments: JSON.stringify({ location }),
              },
            ],
          },
          usage: { promptTokens: 32, completionTokens: 12, totalTokens: 44 },
        };
      }

      const result: CompletionResult = {
        message: {
          content:
            "Hi! Ask me about the weather in a city - e.g. 'What's the weather in Paris?'.",
        },
        usage: { promptTokens: 20, completionTokens: 24, totalTokens: 44 },
      };
      cache.set(userText.toLowerCase().trim(), result);
      return result;
    },
  };
}

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === 'user') {
      return msg.content;
    }
  }
  return '';
}

function lastToolText(messages: readonly ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === 'tool') {
      return msg.content;
    }
  }
  return undefined;
}

function summarizeWeather(toolResult: string, userText: string): string {
  try {
    const parsed = JSON.parse(toolResult) as Record<string, unknown>;
    const location =
      (parsed['location'] as string | undefined) ?? 'that location';
    const temperature = (parsed['temperature'] as string | undefined) ?? '?';
    const condition = (parsed['condition'] as string | undefined) ?? 'unknown';
    return `The weather in ${location} is ${condition} and ${temperature}.`;
  } catch {
    return `Tool said: ${toolResult} (re: "${userText}")`;
  }
}
