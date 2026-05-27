import { OpenAICompatibleLLMClient } from '../llm/client.js';
import type { Provider } from '../llm/types.js';
import {
  DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS,
  DEFAULT_MAX_CONVERSATION_HISTORY,
  type ToolBox,
} from '../server/default-background-task-handler.js';
import {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  OpenAICompatibleAgentImpl,
} from './agent.js';
import type { Callbacks } from './callbacks.js';

/**
 * Thrown by {@link AgentBuilder.build} when required configuration is missing
 * or invalid. Distinct from {@link import('../llm/errors.js').LLMConfigurationError}
 * so callers can pinpoint whether the failure originated in the builder or in
 * downstream LLM-client construction.
 */
export class AgentBuilderError extends Error {
  override readonly name = 'AgentBuilderError';
}

/**
 * Fluent builder that wires an LLM client + tools + callbacks + system prompt
 * + sampling parameters into an {@link OpenAICompatibleAgentImpl}.
 *
 * Mirrors the Go ADK's `AgentBuilder` (`adk/server/agent_builder.go`); the TS
 * variant surfaces each LLM-config field as its own builder method instead of
 * a single `WithConfig` call so callers can compose partial configuration
 * without constructing a full config object.
 *
 * Required fields:
 *  - {@link withProvider} + {@link withModel}, *or*
 *  - {@link withLLMClient} (a pre-built client supplies provider/model itself).
 *
 * Build-time defaults (mirroring the Go ADK):
 *  - `maxIterations`: {@link DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS} (50)
 *  - `maxConversationHistory`: {@link DEFAULT_MAX_CONVERSATION_HISTORY} (20)
 *  - `systemPrompt`: {@link DEFAULT_AGENT_SYSTEM_PROMPT}
 *
 * Example:
 *
 * ```ts
 * const agent = new AgentBuilder()
 *   .withProvider('openai')
 *   .withModel('gpt-4o-mini')
 *   .withTemperature(0.7)
 *   .withSystemPrompt('You are a careful assistant.')
 *   .withToolBox(toolBox)
 *   .build();
 * ```
 */
export class AgentBuilder {
  private provider: Provider | string | undefined;
  private model: string | undefined;
  private temperature: number | undefined;
  private topP: number | undefined;
  private maxTokens: number | undefined;
  private maxIterations: number = DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS;
  private systemPrompt: string = DEFAULT_AGENT_SYSTEM_PROMPT;
  private maxConversationHistory: number = DEFAULT_MAX_CONVERSATION_HISTORY;
  private callbacks: Callbacks | undefined;
  private toolBox: ToolBox | undefined;
  private llmClient: OpenAICompatibleLLMClient | undefined;

  /** Set the LLM provider (e.g. `'openai'`, `'ollama'`, `'groq'`). Required. */
  withProvider(provider: Provider | string): this {
    this.provider = provider;
    return this;
  }

  /** Set the model identifier (e.g. `'gpt-4o-mini'`). Required. */
  withModel(model: string): this {
    this.model = model;
    return this;
  }

  /** Set the sampling temperature. The provider chooses a default when unset. */
  withTemperature(temperature: number): this {
    this.temperature = temperature;
    return this;
  }

  /** Set the top-p sampling threshold. */
  withTopP(topP: number): this {
    this.topP = topP;
    return this;
  }

  /**
   * Set the upper bound on tokens emitted per LLM response. Forwarded both to
   * the LLM client (as `max_tokens` on every request) and stored on the agent
   * for diagnostic access.
   */
  withMaxTokens(maxTokens: number): this {
    this.maxTokens = maxTokens;
    return this;
  }

  /**
   * Override the chat-completion iteration cap. Default:
   * {@link DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS} (50). Must be positive.
   */
  withMaxIterations(maxIterations: number): this {
    this.maxIterations = maxIterations;
    return this;
  }

  /**
   * Override the system prompt advertised to the LLM on every request.
   * Default: {@link DEFAULT_AGENT_SYSTEM_PROMPT}.
   */
  withSystemPrompt(systemPrompt: string): this {
    this.systemPrompt = systemPrompt;
    return this;
  }

  /**
   * Override the conversation-history cap. Default:
   * {@link DEFAULT_MAX_CONVERSATION_HISTORY} (20). Must be positive.
   */
  withMaxConversationHistory(maxConversationHistory: number): this {
    this.maxConversationHistory = maxConversationHistory;
    return this;
  }

  /** Configure lifecycle callbacks. */
  withCallbacks(callbacks: Callbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  /** Configure the tool registry. */
  withToolBox(toolBox: ToolBox): this {
    this.toolBox = toolBox;
    return this;
  }

  /**
   * Inject a pre-built {@link OpenAICompatibleLLMClient}. When set, the
   * builder skips internal LLM-client construction and uses this client
   * verbatim; `withProvider` / `withModel` are no longer required.
   *
   * Mirrors the Go ADK's `WithLLMClient` builder method.
   */
  withLLMClient(llmClient: OpenAICompatibleLLMClient): this {
    this.llmClient = llmClient;
    return this;
  }

  /**
   * Build and return the configured agent.
   *
   * Throws {@link AgentBuilderError} when:
   *  - neither {@link withLLMClient} nor `withProvider`+`withModel` were set;
   *  - `maxIterations` is non-positive;
   *  - `maxConversationHistory` is non-positive.
   */
  build(): OpenAICompatibleAgentImpl {
    if (this.maxIterations <= 0) {
      throw new AgentBuilderError('maxIterations must be a positive integer');
    }
    if (this.maxConversationHistory <= 0) {
      throw new AgentBuilderError(
        'maxConversationHistory must be a positive integer'
      );
    }

    let llmClient: OpenAICompatibleLLMClient;
    if (this.llmClient !== undefined) {
      llmClient = this.llmClient;
    } else {
      if (this.provider === undefined || String(this.provider).length === 0) {
        throw new AgentBuilderError(
          'provider is required - call withProvider() or withLLMClient() before build()'
        );
      }
      if (this.model === undefined || this.model.length === 0) {
        throw new AgentBuilderError(
          'model is required - call withModel() or withLLMClient() before build()'
        );
      }
      llmClient = new OpenAICompatibleLLMClient({
        provider: this.provider,
        model: this.model,
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      });
    }

    return new OpenAICompatibleAgentImpl({
      llmClient,
      systemPrompt: this.systemPrompt,
      maxIterations: this.maxIterations,
      maxConversationHistory: this.maxConversationHistory,
      ...(this.toolBox !== undefined ? { toolBox: this.toolBox } : {}),
      ...(this.callbacks !== undefined ? { callbacks: this.callbacks } : {}),
      ...(this.temperature !== undefined
        ? { temperature: this.temperature }
        : {}),
      ...(this.topP !== undefined ? { topP: this.topP } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
    });
  }
}
