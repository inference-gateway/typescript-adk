import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentBuilder,
  ChatCompletionToolType,
  DefaultArtifactService,
  DefaultBackgroundTaskHandler,
  DefaultToolBox,
  FilesystemArtifactStorage,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  MessageRole,
  OpenAICompatibleLLMClient,
  TASK_GET_METHOD,
  TASK_STATE,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
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

const AGENT_NAME =
  process.env['A2A_AGENT_NAME'] ?? 'artifacts-autonomous-tool-agent';
const AGENT_DESCRIPTION =
  process.env['A2A_AGENT_DESCRIPTION'] ??
  'An LLM-backed A2A agent that uses the reserved create_artifact tool to surface generated content as downloadable artifacts.';
const AGENT_VERSION = process.env['A2A_AGENT_VERSION'] ?? '0.0.0';
const HOST = process.env['A2A_SERVER_HOST'] ?? '127.0.0.1';
const PORT = Number.parseInt(process.env['A2A_SERVER_PORT'] ?? '8080', 10);
const SYSTEM_PROMPT =
  process.env['A2A_AGENT_SYSTEM_PROMPT'] ??
  'You are a helpful assistant. When asked to produce a document, report, code snippet, or any other discrete output, ALWAYS call the create_artifact tool with the content rather than inlining it into your reply. Use a descriptive filename with the correct extension (e.g. "report.md", "data.json"). After the tool returns, summarise what you produced and reference the artifact by filename.';
const ARTIFACTS_ROOT =
  process.env['ARTIFACTS_ROOT'] ?? join(tmpdir(), 'adk-artifacts-autonomous');
const ARTIFACTS_BASE_URL =
  process.env['ARTIFACTS_BASE_URL'] ?? `http://${HOST}:${PORT}/artifacts`;

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
      id: 'artifact-author',
      name: 'Artifact author',
      description:
        'Generates documents, reports, code snippets, or other discrete outputs and surfaces them as downloadable artifacts via the reserved create_artifact tool.',
      tags: ['artifacts', 'autonomous', 'llm'],
    },
  ],
};

const artifactStorage = new FilesystemArtifactStorage({
  root: ARTIFACTS_ROOT,
  baseUrl: ARTIFACTS_BASE_URL,
});
const artifactService = new DefaultArtifactService({
  storage: artifactStorage,
});

// `enableCreateArtifact: true` pre-registers the reserved `create_artifact`
// tool on the toolbox. The DefaultBackgroundTaskHandler intercepts calls to
// this tool, persists the content via `artifactService.createFileArtifact`,
// pushes the resulting Artifact onto a per-handler state bag, and attaches it
// to `task.artifacts` when the loop terminates.
const toolBox = new DefaultToolBox({
  enableCreateArtifact: true,
  artifactService,
});

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

const handler = new DefaultBackgroundTaskHandler({
  llmClient: adaptLLMClient(agent.getLLMClient()),
  toolBox,
  systemPrompt: agent.getSystemPrompt(),
  maxIterations: agent.getMaxIterations(),
  maxConversationHistory: agent.getMaxConversationHistory(),
});
handler.setEnableUsageMetadata(true);

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card, artifactStorage });

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
console.log(`  provider:       ${PROVIDER}, model: ${MODEL}`);
console.log(`  artifacts root: ${ARTIFACTS_ROOT}`);
console.log(`  artifacts base: ${ARTIFACTS_BASE_URL}`);
console.log(
  `  card:           http://${HOST}:${PORT}/.well-known/agent-card.json`
);
console.log(`  health:         http://${HOST}:${PORT}/health`);
console.log(`  rpc:            POST http://${HOST}:${PORT}/`);
console.log(
  `  download:       GET  http://${HOST}:${PORT}/artifacts/:artifactId/:filename`
);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  console.log(`\nreceived ${signal}, shutting down...`);
  abort.abort();
  await worker;
  await server.close();
  await artifactService.close();
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
    console.log(`task ${task.id.slice(0, 8)} dequeued, dispatching to LLM...`);

    const triggering = task.messages[task.messages.length - 1] as Message;
    const result = await handler.handle({
      task,
      message: triggering,
      signal,
    });

    if (isTerminal(result.state)) {
      storage.storeDeadLetter(result);
      const artifactCount = result.artifacts.length;
      console.log(
        `task ${task.id.slice(0, 8)} -> ${result.state} (artifacts attached: ${artifactCount})`
      );
    } else {
      const failed = transitionTask(result, TASK_STATE.FAILED);
      storage.storeDeadLetter(failed);
      console.warn(
        `task ${task.id.slice(0, 8)} did not reach a terminal state (got ${result.state}); recorded as FAILED`
      );
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`missing required environment variable: ${name}`);
    console.error(
      'See examples/artifacts-autonomous-tool/.env.example for the full list.'
    );
    process.exit(1);
  }
  return value;
}

/**
 * Adapter from {@link OpenAICompatibleLLMClient} (wire-shaped, snake_case,
 * `chatCompletion`) to the structural {@link LLMClient} interface consumed by
 * {@link DefaultBackgroundTaskHandler} (camelCase, `createCompletion`).
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
      return { role: MessageRole.System, content: message.content };
    case 'user':
      return { role: MessageRole.User, content: message.content };
    case 'assistant': {
      const toolCalls = message.toolCalls?.map((tc) => ({
        id: tc.id,
        type: ChatCompletionToolType.function,
        function: { name: tc.name, arguments: tc.arguments },
      }));
      return {
        role: MessageRole.Assistant,
        content: message.content ?? '',
        ...(toolCalls !== undefined && toolCalls.length > 0
          ? { tool_calls: toolCalls }
          : {}),
      };
    }
    case 'tool':
      return {
        role: MessageRole.Tool,
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
