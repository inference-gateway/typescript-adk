import type { OpenAICompatibleLLMClient } from '../llm/client.js';
import type { ToolBox } from '../server/default-background-task-handler.js';
import type { Callbacks } from './callbacks.js';

/**
 * Default system prompt advertised to the LLM when the builder does not set
 * one explicitly. Matches the Go ADK's `AgentConfig.SystemPrompt` default in
 * `adk/server/config/config.go` verbatim so behavior is consistent across
 * languages.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT =
  'You are a helpful AI assistant processing an A2A (Agent-to-Agent) task. Please provide helpful and accurate responses.';

/**
 * Marker interface for an OpenAI-compatible LLM agent. Mirrors the Go ADK's
 * `OpenAICompatibleAgent` interface (`adk/server/agent.go`). Concrete agents
 * implement this and expose their wired pieces (LLM client, tool box,
 * callbacks, system prompt, sampling params) through additional accessors
 * defined on the implementation class - see {@link OpenAICompatibleAgentImpl}.
 *
 * Kept minimal on purpose so tests and ad-hoc callers can satisfy it with a
 * bare `{ id }` literal without constructing a real client.
 */
export interface OpenAICompatibleAgent {
  /** Stable identifier (typically `<provider>/<model>`). Diagnostic only. */
  readonly id: string;
}

/**
 * Construction options for {@link OpenAICompatibleAgentImpl}. Typically
 * populated by {@link import('./agent-builder.js').AgentBuilder.build};
 * constructing directly is supported but discouraged - the builder applies
 * defaults and validates required fields.
 */
export interface OpenAICompatibleAgentImplOptions {
  /** Pre-built LLM client; carries provider/model/baseURL/apiKey/etc. */
  readonly llmClient: OpenAICompatibleLLMClient;
  /** Tool registry. Optional - omit for a tool-free agent. */
  readonly toolBox?: ToolBox;
  /** Lifecycle callbacks. Optional. */
  readonly callbacks?: Callbacks;
  /** System prompt prepended to every LLM call. */
  readonly systemPrompt: string;
  /** Upper bound on chat-completion iterations. Must be positive. */
  readonly maxIterations: number;
  /**
   * Upper bound on conversation messages forwarded to the LLM per iteration.
   * Must be positive.
   */
  readonly maxConversationHistory: number;
  /** Sampling temperature. Optional - the model provider chooses if unset. */
  readonly temperature?: number;
  /** Top-p sampling. Optional. */
  readonly topP?: number;
  /** Upper bound on tokens emitted per LLM response. Optional. */
  readonly maxTokens?: number;
}

/**
 * Concrete OpenAI-compatible agent: a configuration holder bundling the wired
 * LLM client, tool box, lifecycle callbacks, system prompt, and sampling
 * parameters. Produced by
 * {@link import('./agent-builder.js').AgentBuilder.build}.
 *
 * Mirrors the Go ADK's `OpenAICompatibleAgentImpl` (`adk/server/agent.go`).
 * The TS implementation is currently a configuration container - the
 * agentic iteration loop lives in
 * {@link import('../server/default-background-task-handler.js').DefaultBackgroundTaskHandler}
 * and consumes the configuration through the accessors here. A future
 * iteration will move the loop onto the agent itself, matching the Go shape.
 */
export class OpenAICompatibleAgentImpl implements OpenAICompatibleAgent {
  readonly id: string;
  private readonly llmClient: OpenAICompatibleLLMClient;
  private readonly toolBox: ToolBox | undefined;
  private readonly callbacks: Callbacks | undefined;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly maxConversationHistory: number;
  private readonly temperature: number | undefined;
  private readonly topP: number | undefined;
  private readonly maxTokens: number | undefined;

  constructor(options: OpenAICompatibleAgentImplOptions) {
    if (options.maxIterations <= 0) {
      throw new RangeError(
        'OpenAICompatibleAgentImpl maxIterations must be a positive integer'
      );
    }
    if (options.maxConversationHistory <= 0) {
      throw new RangeError(
        'OpenAICompatibleAgentImpl maxConversationHistory must be a positive integer'
      );
    }

    this.llmClient = options.llmClient;
    this.toolBox = options.toolBox;
    this.callbacks = options.callbacks;
    this.systemPrompt = options.systemPrompt;
    this.maxIterations = options.maxIterations;
    this.maxConversationHistory = options.maxConversationHistory;
    this.temperature = options.temperature;
    this.topP = options.topP;
    this.maxTokens = options.maxTokens;
    this.id = `${options.llmClient.getProvider()}/${options.llmClient.getModel()}`;
  }

  /** Configured LLM client. */
  getLLMClient(): OpenAICompatibleLLMClient {
    return this.llmClient;
  }

  /** Configured tool registry, when one was supplied. */
  getToolBox(): ToolBox | undefined {
    return this.toolBox;
  }

  /** Configured lifecycle callbacks, when supplied. */
  getCallbacks(): Callbacks | undefined {
    return this.callbacks;
  }

  /** System prompt advertised on every LLM call. */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /** Upper bound on chat-completion iterations. */
  getMaxIterations(): number {
    return this.maxIterations;
  }

  /** Upper bound on conversation messages forwarded to the LLM per iteration. */
  getMaxConversationHistory(): number {
    return this.maxConversationHistory;
  }

  /** Sampling temperature, if explicitly configured. */
  getTemperature(): number | undefined {
    return this.temperature;
  }

  /** Top-p sampling, if explicitly configured. */
  getTopP(): number | undefined {
    return this.topP;
  }

  /** Max tokens per LLM response, if explicitly configured. */
  getMaxTokens(): number | undefined {
    return this.maxTokens;
  }
}
