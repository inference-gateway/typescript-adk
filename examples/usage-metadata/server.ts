import {
  DefaultBackgroundTaskHandler,
  DefaultStreamingTaskHandler,
  DefaultToolBox,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  MESSAGE_STREAM_METHOD,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createMessageStreamHandler,
  createTaskGetHandler,
  createTool,
  isTerminal,
  transitionTask,
  type AgentCard,
  type ChatMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type ManagedTask,
  type Message,
} from '@inference-gateway/adk';

const AGENT_NAME = process.env['A2A_AGENT_NAME'] ?? 'usage-metadata-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'Demo agent showing per-task usage metadata (token counts + execution stats) attached to task.metadata on completion.';
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
      id: 'usage-metadata-demo',
      name: 'Usage metadata demo',
      description:
        'Answers weather questions with a fake LLM and attaches token usage + execution stats to task.metadata on completion. Exposes both message/send and message/stream.',
      tags: ['usage', 'metadata', 'observability', 'demo'],
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
      });
    },
  })
);

const backgroundHandler = new DefaultBackgroundTaskHandler({
  llmClient: createFakeLLMClient(),
  toolBox,
  agentName: AGENT_NAME,
});
backgroundHandler.setEnableUsageMetadata(true);

const streamingHandler = new DefaultStreamingTaskHandler({
  llmClient: createFakeLLMClient(),
  toolBox,
  agentName: AGENT_NAME,
});
streamingHandler.setEnableUsageMetadata(true);

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card });

server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
server.registerStreamingMethod(
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler({
    storage,
    executor: streamingHandler.asHandler(),
  })
);

const abort = new AbortController();
const worker = runBackgroundWorker(abort.signal).catch((err) => {
  if (abort.signal.aborted) return;
  console.error('background worker crashed:', err);
  process.exitCode = 1;
});

await server.listen(PORT, HOST);
console.log(`${AGENT_NAME} listening on http://${HOST}:${PORT}`);
console.log(`  card:   http://${HOST}:${PORT}/.well-known/agent-card.json`);
console.log(`  health: http://${HOST}:${PORT}/health`);
console.log(`  rpc:    POST http://${HOST}:${PORT}/`);
console.log(`  methods: ${server.registeredMethods().sort().join(', ')}`);
console.log(`  usage metadata: enabled on both handlers`);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function runBackgroundWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let task: ManagedTask;
    try {
      task = await storage.dequeue(signal);
    } catch {
      return;
    }
    storage.updateActive(task);

    const triggering = task.messages[task.messages.length - 1] as Message;
    console.log(`\ntask ${task.id.slice(0, 8)} dequeued (message/send path)`);

    let result: ManagedTask;
    try {
      result = await backgroundHandler.handle({
        task,
        message: triggering,
        signal,
      });
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
    console.log(
      `task ${task.id.slice(0, 8)} -> ${result.state}  metadata=${JSON.stringify(result.metadata ?? null)}`
    );
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

/**
 * Deterministic, no-network fake LLM. Each response carries a `usage` payload
 * so the {@link DefaultBackgroundTaskHandler} / {@link DefaultStreamingTaskHandler}
 * UsageTracker has something to accumulate.
 *
 *  - "weather in <city>"  →  tool call to `get_weather` (32/12 tokens), then a
 *                            second-pass text reply (24/16 tokens). Iteration
 *                            count therefore lands at 2 and tool_calls at 1.
 *  - any other text       →  direct text reply (20/24 tokens), iteration 1.
 */
function createFakeLLMClient(): LLMClient {
  return {
    async createCompletion(
      opts: CreateCompletionOptions
    ): Promise<CompletionResult> {
      const userText = lastUserText(opts.messages);
      const toolResult = lastToolText(opts.messages);

      if (toolResult !== undefined) {
        const text = summarizeWeather(toolResult, userText);
        return {
          message: { content: text },
          usage: { promptTokens: 24, completionTokens: 16, totalTokens: 40 },
        };
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

      return {
        message: {
          content:
            "Hi! Ask me about the weather in a city - e.g. 'What's the weather in Paris?'.",
        },
        usage: { promptTokens: 20, completionTokens: 24, totalTokens: 44 },
      };
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
