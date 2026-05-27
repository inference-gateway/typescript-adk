import {
  AgentBuilder,
  ChatCompletionToolType,
  DefaultBackgroundTaskHandler,
  DefaultToolBox,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  MessageRole,
  OpenAICompatibleLLMClient,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
  createTool,
  isTerminal,
  transitionTask,
  type AgentCard,
  type ChatMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type LLMMessage,
  type LLMTool,
  type ManagedTask,
  type Message,
  type ToolDefinition,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'ai-powered-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'An LLM-backed A2A agent with weather and time tools.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const SYSTEM_PROMPT =
  process.env['A2A_AGENT_SYSTEM_PROMPT'] ??
  'You are a helpful AI assistant with access to weather and time tools. Be concise and friendly in your responses.';

const PROVIDER = required('A2A_AGENT_CLIENT_PROVIDER');
const MODEL = required('A2A_AGENT_CLIENT_MODEL');
const BASE_URL = process.env['A2A_AGENT_CLIENT_BASE_URL'];
const API_KEY =
  process.env['A2A_AGENT_CLIENT_API_KEY'] ??
  process.env[`${PROVIDER.toUpperCase()}_API_KEY`];

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
      name: 'Weather lookup',
      description:
        'Reports current weather for a named location. Returns canned data - no real weather service is contacted.',
      tags: ['weather', 'demo'],
    },
    {
      id: 'time',
      name: 'Current time',
      description: 'Reports the current server-side date and time.',
      tags: ['time', 'demo'],
    },
  ],
};

const llmClient = new OpenAICompatibleLLMClient({
  provider: PROVIDER,
  model: MODEL,
  ...(BASE_URL !== undefined ? { baseURL: BASE_URL } : {}),
  ...(API_KEY !== undefined ? { apiKey: API_KEY } : {}),
});

const agent = new AgentBuilder()
  .withLLMClient(llmClient)
  .withSystemPrompt(SYSTEM_PROMPT)
  .build();

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
          description: 'The city name, e.g. "Tokyo" or "Berlin".',
        },
      },
      required: ['location'],
    },
    execute: async (rawArgs) => {
      const args = parseArgs<{ readonly location?: string }>(rawArgs);
      const location = args.location ?? 'unknown';
      return JSON.stringify({
        location,
        temperature: '22°C',
        condition: 'sunny',
        humidity: '65%',
      });
    },
  })
);

toolBox.addTool(
  createTool({
    name: 'get_current_time',
    description: 'Get the current server-side date and time.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      const now = new Date();
      return JSON.stringify({
        current_time: now.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    },
  })
);

const handler = new DefaultBackgroundTaskHandler({
  llmClient: adaptLLMClient(agent.getLLMClient()),
  toolBox,
  systemPrompt: agent.getSystemPrompt(),
  maxIterations: agent.getMaxIterations(),
  maxConversationHistory: agent.getMaxConversationHistory(),
});
handler.setEnableUsageMetadata(true);

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
console.log(`  provider: ${PROVIDER}, model: ${MODEL}`);
console.log(`  card:     http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health:   http://${HOST}:${PORT}/health`);
console.log(`  rpc:      POST http://${HOST}:${PORT}/`);

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
    console.log(`task ${task.id} dequeued, dispatching to LLM...`);

    const triggering = task.messages[task.messages.length - 1] as Message;
    const result = await handler.handle({
      task,
      message: triggering,
      signal,
    });

    if (isTerminal(result.state)) {
      storage.storeDeadLetter(result);
      console.log(`task ${task.id} -> ${result.state}`);
    } else {
      const failed = transitionTask(result, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
      console.warn(
        `task ${task.id} did not reach a terminal state (got ${result.state}); recorded as FAILED`
      );
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`missing required environment variable: ${name}`);
    console.error(
      'See examples/ai-powered/README.md or .env.example for the full list.'
    );
    process.exit(1);
  }
  return value;
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

/**
 * Adapter from {@link OpenAICompatibleLLMClient} (wire-shaped, snake_case,
 * `chatCompletion`) to the structural {@link LLMClient} interface consumed by
 * {@link DefaultBackgroundTaskHandler} (camelCase, `createCompletion`).
 *
 * The TS ADK does not yet ship this bridge built-in (the Go ADK wires it
 * internally via `OpenAICompatibleAgent.RunWithStream`); this example
 * implements the minimal one-shot variant.
 */
function adaptLLMClient(client: OpenAICompatibleLLMClient): LLMClient {
  return {
    async createCompletion(
      opts: CreateCompletionOptions
    ): Promise<CompletionResult> {
      const wireMessages = opts.messages.map(toWireMessage);
      const wireTools = opts.tools?.map(toWireTool);
      const response = await client.chatCompletion(wireMessages, {
        ...(wireTools !== undefined && wireTools.length > 0
          ? { tools: wireTools }
          : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      const choice = response.choices[0];
      const msg = choice?.message;
      const content =
        msg !== undefined && typeof msg.content === 'string'
          ? msg.content
          : undefined;
      const toolCalls = msg?.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      const usage =
        response.usage !== undefined
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined;
      return {
        message: {
          ...(content !== undefined ? { content } : {}),
          ...(toolCalls !== undefined && toolCalls.length > 0
            ? { toolCalls }
            : {}),
        },
        ...(usage !== undefined ? { usage } : {}),
      };
    },
  };
}

function toWireMessage(message: ChatMessage): LLMMessage {
  switch (message.role) {
    case 'system':
      return { role: MessageRole.system, content: message.content };
    case 'user':
      return { role: MessageRole.user, content: message.content };
    case 'assistant': {
      const toolCalls = message.toolCalls?.map((tc) => ({
        id: tc.id,
        type: ChatCompletionToolType.function,
        function: { name: tc.name, arguments: tc.arguments },
      }));
      return {
        role: MessageRole.assistant,
        content: message.content ?? '',
        ...(toolCalls !== undefined && toolCalls.length > 0
          ? { tool_calls: toolCalls }
          : {}),
      };
    }
    case 'tool':
      return {
        role: MessageRole.tool,
        content: message.content,
        tool_call_id: message.toolCallId,
      };
  }
}

function toWireTool(tool: ToolDefinition): LLMTool {
  return {
    type: ChatCompletionToolType.function,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: false,
    },
  };
}
