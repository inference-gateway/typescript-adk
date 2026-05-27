import { describe, expect, it } from 'vitest';
import {
  AgentBuilder,
  AgentBuilderError,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  OpenAICompatibleAgentImpl,
  type Callbacks,
} from '../../src/agent/index.js';
import {
  OpenAICompatibleLLMClient,
  Provider,
  type LLMResponse,
  type LLMTransport,
} from '../../src/llm/index.js';
import {
  DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS,
  DEFAULT_MAX_CONVERSATION_HISTORY,
  type Tool,
  type ToolBox,
  type ToolContext,
  type ToolDefinition,
} from '../../src/server/index.js';

function fakeTransport(): LLMTransport {
  return {
    async createChatCompletion(): Promise<LLMResponse> {
      throw new Error('not used in builder tests');
    },
    async streamChatCompletion(): Promise<void> {
      throw new Error('not used in builder tests');
    },
  };
}

function fakeLLMClient(model = 'gpt-4o-mini'): OpenAICompatibleLLMClient {
  return new OpenAICompatibleLLMClient({
    provider: Provider.openai,
    model,
    client: fakeTransport(),
  });
}

function noopToolBox(): ToolBox {
  return {
    getTools(): readonly ToolDefinition[] {
      return [];
    },
    async executeTool(
      _name: string,
      _args: string,
      _context: ToolContext
    ): Promise<string> {
      return '';
    },
    getToolNames(): readonly string[] {
      return [];
    },
    hasTool(_name: string): boolean {
      return false;
    },
    getTool(_name: string): Tool | undefined {
      return undefined;
    },
    addTool(_tool: Tool): void {
      throw new Error('not used in builder tests');
    },
  };
}

describe('AgentBuilder', () => {
  describe('build()', () => {
    it('produces an OpenAICompatibleAgentImpl with provider+model', () => {
      const agent = new AgentBuilder()
        .withProvider('openai')
        .withModel('gpt-4o-mini')
        .build();

      expect(agent).toBeInstanceOf(OpenAICompatibleAgentImpl);
      expect(agent.id).toBe('openai/gpt-4o-mini');
    });

    it('applies the Go ADK defaults verbatim', () => {
      const agent = new AgentBuilder()
        .withProvider('openai')
        .withModel('gpt-4o-mini')
        .build();

      expect(agent.getMaxIterations()).toBe(50);
      expect(agent.getMaxConversationHistory()).toBe(20);
      expect(agent.getSystemPrompt()).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    });

    it('exposes the constants from server module for consistency', () => {
      expect(DEFAULT_MAX_CHAT_COMPLETION_ITERATIONS).toBe(50);
      expect(DEFAULT_MAX_CONVERSATION_HISTORY).toBe(20);
    });

    it('matches the Go default system prompt verbatim', () => {
      expect(DEFAULT_AGENT_SYSTEM_PROMPT).toBe(
        'You are a helpful AI assistant processing an A2A (Agent-to-Agent) task. Please provide helpful and accurate responses.'
      );
    });

    it('forwards every override into the produced agent', () => {
      const callbacks: Callbacks = { beforeAgent: [() => undefined] };
      const toolBox = noopToolBox();

      const agent = new AgentBuilder()
        .withProvider('openai')
        .withModel('gpt-4o-mini')
        .withTemperature(0.4)
        .withTopP(0.9)
        .withMaxTokens(512)
        .withMaxIterations(10)
        .withSystemPrompt('be brief')
        .withMaxConversationHistory(5)
        .withCallbacks(callbacks)
        .withToolBox(toolBox)
        .build();

      expect(agent.getTemperature()).toBe(0.4);
      expect(agent.getTopP()).toBe(0.9);
      expect(agent.getMaxTokens()).toBe(512);
      expect(agent.getMaxIterations()).toBe(10);
      expect(agent.getSystemPrompt()).toBe('be brief');
      expect(agent.getMaxConversationHistory()).toBe(5);
      expect(agent.getCallbacks()).toBe(callbacks);
      expect(agent.getToolBox()).toBe(toolBox);
    });

    it('accepts a pre-built LLM client and uses it verbatim', () => {
      const client = fakeLLMClient('gpt-4o');
      const agent = new AgentBuilder().withLLMClient(client).build();

      expect(agent.getLLMClient()).toBe(client);
      expect(agent.id).toBe('openai/gpt-4o');
    });

    it('does not require provider/model when withLLMClient was called', () => {
      const client = fakeLLMClient();
      expect(() =>
        new AgentBuilder().withLLMClient(client).build()
      ).not.toThrow();
    });

    it('returns the builder instance from every with* method (fluent)', () => {
      const builder = new AgentBuilder();
      expect(builder.withProvider('openai')).toBe(builder);
      expect(builder.withModel('gpt-4o-mini')).toBe(builder);
      expect(builder.withTemperature(0.5)).toBe(builder);
      expect(builder.withTopP(0.95)).toBe(builder);
      expect(builder.withMaxTokens(256)).toBe(builder);
      expect(builder.withMaxIterations(20)).toBe(builder);
      expect(builder.withSystemPrompt('hi')).toBe(builder);
      expect(builder.withMaxConversationHistory(15)).toBe(builder);
      expect(builder.withCallbacks({})).toBe(builder);
      expect(builder.withToolBox(noopToolBox())).toBe(builder);
      expect(builder.withLLMClient(fakeLLMClient())).toBe(builder);
    });
  });

  describe('validation', () => {
    it('throws when provider is missing', () => {
      expect(() => new AgentBuilder().withModel('gpt-4o-mini').build()).toThrow(
        AgentBuilderError
      );
      expect(() => new AgentBuilder().withModel('gpt-4o-mini').build()).toThrow(
        /provider is required/
      );
    });

    it('throws when model is missing', () => {
      expect(() => new AgentBuilder().withProvider('openai').build()).toThrow(
        AgentBuilderError
      );
      expect(() => new AgentBuilder().withProvider('openai').build()).toThrow(
        /model is required/
      );
    });

    it('throws when provider is an empty string', () => {
      expect(() =>
        new AgentBuilder().withProvider('').withModel('gpt-4o-mini').build()
      ).toThrow(/provider is required/);
    });

    it('throws when model is an empty string', () => {
      expect(() =>
        new AgentBuilder().withProvider('openai').withModel('').build()
      ).toThrow(/model is required/);
    });

    it('throws when maxIterations is non-positive', () => {
      expect(() =>
        new AgentBuilder()
          .withProvider('openai')
          .withModel('gpt-4o-mini')
          .withMaxIterations(0)
          .build()
      ).toThrow(/maxIterations/);
      expect(() =>
        new AgentBuilder()
          .withProvider('openai')
          .withModel('gpt-4o-mini')
          .withMaxIterations(-5)
          .build()
      ).toThrow(/maxIterations/);
    });

    it('throws when maxConversationHistory is non-positive', () => {
      expect(() =>
        new AgentBuilder()
          .withProvider('openai')
          .withModel('gpt-4o-mini')
          .withMaxConversationHistory(0)
          .build()
      ).toThrow(/maxConversationHistory/);
    });
  });

  describe('LLM client construction', () => {
    it('strips a <provider>/ prefix from the model when constructing the client internally', () => {
      const agent = new AgentBuilder()
        .withProvider('openai')
        .withModel('openai/gpt-4o-mini')
        .build();

      expect(agent.getLLMClient().getModel()).toBe('gpt-4o-mini');
    });

    it('lower-cases the provider when constructing the client internally', () => {
      const agent = new AgentBuilder()
        .withProvider('OpenAI')
        .withModel('gpt-4o-mini')
        .build();

      expect(agent.getLLMClient().getProvider()).toBe(Provider.openai);
    });
  });
});

describe('OpenAICompatibleAgentImpl', () => {
  it('rejects non-positive maxIterations at construction time', () => {
    expect(
      () =>
        new OpenAICompatibleAgentImpl({
          llmClient: fakeLLMClient(),
          systemPrompt: 'x',
          maxIterations: 0,
          maxConversationHistory: 20,
        })
    ).toThrow(RangeError);
  });

  it('rejects non-positive maxConversationHistory at construction time', () => {
    expect(
      () =>
        new OpenAICompatibleAgentImpl({
          llmClient: fakeLLMClient(),
          systemPrompt: 'x',
          maxIterations: 50,
          maxConversationHistory: 0,
        })
    ).toThrow(RangeError);
  });

  it('returns undefined for optional sampling params when none configured', () => {
    const agent = new OpenAICompatibleAgentImpl({
      llmClient: fakeLLMClient(),
      systemPrompt: 'x',
      maxIterations: 50,
      maxConversationHistory: 20,
    });
    expect(agent.getTemperature()).toBeUndefined();
    expect(agent.getTopP()).toBeUndefined();
    expect(agent.getMaxTokens()).toBeUndefined();
    expect(agent.getToolBox()).toBeUndefined();
    expect(agent.getCallbacks()).toBeUndefined();
  });
});
