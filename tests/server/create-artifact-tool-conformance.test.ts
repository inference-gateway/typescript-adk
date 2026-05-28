import { describe, expect, it } from 'vitest';
import { DefaultArtifactService } from '../../src/artifacts/default-artifact-service.js';
import { InMemoryArtifactStorage } from '../../src/artifacts/in-memory-storage.js';
import { TASK_STATE, createTask } from '../../src/agent/task.js';
import {
  CREATE_ARTIFACT_ENV,
  CREATE_ARTIFACT_TOOL,
  DefaultBackgroundTaskHandler,
  DefaultStreamingTaskHandler,
  DefaultToolBox,
  type AssistantMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type StreamingExecutorContext,
  type ToolCall,
} from '../../src/server/index.js';
import type { Artifact, Message } from '../../src/types/generated/a2a.js';

function scriptedClient(responses: readonly CompletionResult[]): LLMClient {
  let index = 0;
  return {
    createCompletion: async (_opts: CreateCompletionOptions) => {
      const response = responses[index];
      index++;
      if (response === undefined) {
        throw new Error(
          `scriptedClient exhausted: expected at most ${responses.length} calls`
        );
      }
      return response;
    },
  };
}

function assistantToolCalls(toolCalls: readonly ToolCall[]): CompletionResult {
  const assistant: AssistantMessage = { toolCalls };
  return { message: assistant };
}

function assistantText(content: string): CompletionResult {
  return { message: { content } };
}

function userMessage(text: string): Message {
  return {
    messageId: 'm-1',
    role: 'ROLE_USER',
    parts: [{ text }],
  };
}

describe('create_artifact tool: end-to-end agent loop (background handler)', () => {
  it('agent calls create_artifact -> artifact stored -> URI in task response', async () => {
    const storage = new InMemoryArtifactStorage({
      baseUrl: 'http://artifacts.local',
    });
    const artifactService = new DefaultArtifactService({ storage });
    const toolBox = new DefaultToolBox({
      enableCreateArtifact: true,
      artifactService,
    });

    const filename = 'report.md';
    const content = '# Quarterly Report\n\nKey insights.';
    const llm = scriptedClient([
      assistantToolCalls([
        {
          id: 'call-1',
          name: CREATE_ARTIFACT_TOOL,
          arguments: JSON.stringify({
            content,
            filename,
            name: 'Quarterly report',
          }),
        },
      ]),
      assistantText('Done.'),
    ]);

    const handler = new DefaultBackgroundTaskHandler({
      llmClient: llm,
      toolBox,
    });

    const message = userMessage('Generate the quarterly report');
    const task = createTask({
      id: 't-art',
      contextId: 'c-art',
      messages: [message],
    });
    const controller = new AbortController();

    const finalTask = await handler.handle({
      task,
      message,
      signal: controller.signal,
    });

    expect(finalTask.state).toBe(TASK_STATE.COMPLETED);
    expect(finalTask.artifacts).toHaveLength(1);

    const artifact = finalTask.artifacts[0] as Artifact;
    expect(artifact.name).toBe('Quarterly report');
    expect(artifact.parts).toHaveLength(1);
    const uri = artifact.parts[0]?.file?.fileWithUri;
    expect(uri).toEqual(expect.stringContaining('http://artifacts.local'));
    expect(uri).toEqual(expect.stringContaining(filename));

    // The artifact body actually landed in storage.
    expect(await storage.exists(artifact.artifactId, filename)).toBe(true);
  });

  it('opts in via the AGENT_CLIENT_TOOLS_CREATE_ARTIFACT env var', () => {
    const storage = new InMemoryArtifactStorage({ baseUrl: 'http://x' });
    const artifactService = new DefaultArtifactService({ storage });
    const toolBox = new DefaultToolBox({
      env: { [CREATE_ARTIFACT_ENV]: 'true' },
      artifactService,
    });
    expect(toolBox.hasTool(CREATE_ARTIFACT_TOOL)).toBe(true);
  });
});

describe('create_artifact tool: end-to-end agent loop (streaming handler)', () => {
  it('emits artifactCreated then propagates URI through the streamed task', async () => {
    const storage = new InMemoryArtifactStorage({
      baseUrl: 'http://artifacts.local',
    });
    const artifactService = new DefaultArtifactService({ storage });
    const toolBox = new DefaultToolBox({
      enableCreateArtifact: true,
      artifactService,
    });

    const filename = 'summary.txt';
    const content = 'streaming artifact body';
    const llm = scriptedClient([
      assistantToolCalls([
        {
          id: 'call-1',
          name: CREATE_ARTIFACT_TOOL,
          arguments: JSON.stringify({ content, filename }),
        },
      ]),
      assistantText('Done.'),
    ]);

    const handler = new DefaultStreamingTaskHandler({
      llmClient: llm,
      toolBox,
    });

    const message = userMessage('summarise this');
    const task = createTask({
      id: 't-art-stream',
      contextId: 'c-art-stream',
      messages: [message],
    });
    const controller = new AbortController();
    const streamContext: StreamingExecutorContext = {
      task,
      message,
      signal: controller.signal,
    };

    const eventTypes: string[] = [];
    let observedArtifact: Artifact | undefined;
    for await (const event of handler.handle(streamContext)) {
      eventTypes.push(event.type);
      if (event.type === 'artifactCreated') {
        observedArtifact = event.artifact;
      }
    }

    expect(eventTypes).toContain('artifactCreated');
    expect(observedArtifact).toBeDefined();
    const uri = observedArtifact?.parts[0]?.file?.fileWithUri;
    expect(uri).toEqual(expect.stringContaining(filename));
    expect(observedArtifact?.name).toBe('Generated Content');

    // The streaming handler hands artifacts to the pipeline via events rather
    // than mutating `task` directly, so verify the storage write itself
    // landed (the pipeline merges the artifact onto the task on each event).
    expect(
      await storage.exists(observedArtifact?.artifactId ?? '', filename)
    ).toBe(true);
  });
});
