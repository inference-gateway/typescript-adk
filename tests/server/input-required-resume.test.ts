import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
} from '../../src/agent/task.js';
import {
  A2AServer,
  DefaultBackgroundTaskHandler,
  DefaultStreamingTaskHandler,
  DefaultToolBox,
  INPUT_REQUIRED_TOOL,
  JSONRPC_VERSION,
  MESSAGE_SEND_METHOD,
  MESSAGE_STREAM_METHOD,
  STREAMING_STATUS_UPDATE_INTERVAL_ENV,
  createA2AServer,
  createMessageSendHandler,
  createMessageStreamHandler,
  createTool,
  type AssistantMessage,
  type CompletionResult,
  type CreateCompletionOptions,
  type LLMClient,
  type StreamingExecutorContext,
  type StreamingTaskEvent,
  type StreamingTaskExecutor,
  type ToolCall,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';
import type { Message, StreamResponse, Task } from '../../src/types/index.js';

const decoder = new TextDecoder();

function makeCard(): AgentCard {
  return {
    name: 'input-required-agent',
    description: 'Agent under test',
    version: '0.0.0',
    supportedInterfaces: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: true },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
  };
}

function sequentialIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

async function start(server: A2AServer): Promise<string> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return `http://127.0.0.1:${addr.port}`;
}

async function postJSON(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Frame {
  readonly raw: string;
  readonly result: StreamResponse;
}

async function readFrames(res: Response): Promise<Frame[]> {
  if (res.body === null) {
    throw new Error('response had no body');
  }
  const reader = res.body.getReader();
  let buffer = '';
  const frames: Frame[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        return frames;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx < 0) {
          break;
        }
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith('data: ')) {
          const envelope = JSON.parse(raw.slice('data: '.length)) as {
            result: StreamResponse;
          };
          frames.push({ raw, result: envelope.result });
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released by cancel
    }
  }
}

function scriptedClient(responses: readonly CompletionResult[]): {
  readonly client: LLMClient;
  readonly calls: CreateCompletionOptions[];
} {
  const calls: CreateCompletionOptions[] = [];
  let index = 0;
  const client: LLMClient = {
    createCompletion: async (opts: CreateCompletionOptions) => {
      calls.push(opts);
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
  return { client, calls };
}

function assistantText(content: string): CompletionResult {
  return { message: { content } };
}

function assistantToolCalls(toolCalls: readonly ToolCall[]): CompletionResult {
  const assistant: AssistantMessage = { toolCalls };
  return { message: assistant };
}

describe('SendMessage resume flow (background)', () => {
  it('resumes an INPUT_REQUIRED task when a new message arrives with the same contextId', async () => {
    const storage = new InMemoryTaskStorage();

    // Seed an existing paused task in storage.
    const original = createTask({
      id: 'task-1',
      contextId: 'ctx-resume',
      messages: [
        {
          messageId: 'm-1',
          role: 'ROLE_USER',
          contextId: 'ctx-resume',
          parts: [{ text: "What's the weather?" }],
        },
        {
          messageId: 'm-2',
          role: 'ROLE_AGENT',
          contextId: 'ctx-resume',
          taskId: 'task-1',
          parts: [{ text: 'Which city?' }],
        },
      ],
    });
    const inProgress = transitionTask(original, TASK_STATE.IN_PROGRESS);
    const paused = transitionTask(inProgress, TASK_STATE.INPUT_REQUIRED, {
      message: inProgress.messages[1] as Message,
    });
    storage.createActive(paused);

    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });
    const { task: result } = (await handler(
      {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'm-3',
          role: 'ROLE_USER',
          contextId: 'ctx-resume',
          parts: [{ text: 'San Francisco' }],
        },
      },
      { signal: new AbortController().signal }
    )) as { task: Task };

    expect(result.id).toBe('task-1');
    expect(result.contextId).toBe('ctx-resume');
    expect(result.status.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(result.history).toHaveLength(3);
    expect(result.history?.[2]?.parts[0]?.text).toBe('San Francisco');

    // The resumed task should be back on the FIFO queue so a worker picks it up.
    expect(storage.queueLength()).toBe(1);
    const stored = storage.getActive('task-1');
    expect(stored?.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(stored?.messages).toHaveLength(3);
  });

  it('falls back to creating a fresh task when no paused task exists for the contextId', async () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });

    const { task: result } = (await handler(
      {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'm-1',
          role: 'ROLE_USER',
          contextId: 'ctx-fresh',
          parts: [{ text: 'hello' }],
        },
      },
      { signal: new AbortController().signal }
    )) as { task: Task };

    expect(result.id).toBe('id-1');
    expect(result.contextId).toBe('ctx-fresh');
    expect(result.status.state).toBe(TASK_STATE.PENDING);
  });

  it('ignores paused tasks on a different contextId', async () => {
    const storage = new InMemoryTaskStorage();
    const other = createTask({ id: 'other', contextId: 'ctx-other' });
    const otherPaused = transitionTask(
      transitionTask(other, TASK_STATE.IN_PROGRESS),
      TASK_STATE.INPUT_REQUIRED
    );
    storage.createActive(otherPaused);

    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });
    const { task: result } = (await handler(
      {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'm-x',
          role: 'ROLE_USER',
          contextId: 'ctx-different',
          parts: [{ text: 'hi' }],
        },
      },
      { signal: new AbortController().signal }
    )) as { task: Task };

    expect(result.id).toBe('id-1');
    expect(result.id).not.toBe('other');
  });

  it('does not resume a COMPLETED task that happens to share the contextId', async () => {
    const storage = new InMemoryTaskStorage();
    const completed = transitionTask(
      transitionTask(
        createTask({ id: 'finished', contextId: 'ctx-shared' }),
        TASK_STATE.IN_PROGRESS
      ),
      TASK_STATE.COMPLETED
    );
    storage.createActive(completed);
    storage.storeDeadLetter(completed);

    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });
    const { task: result } = (await handler(
      {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'm-1',
          role: 'ROLE_USER',
          contextId: 'ctx-shared',
          parts: [{ text: 'follow-up' }],
        },
      },
      { signal: new AbortController().signal }
    )) as { task: Task };

    expect(result.id).toBe('id-1');
    expect(result.status.state).toBe(TASK_STATE.PENDING);
  });
});

describe('DefaultBackgroundTaskHandler pause + resume', () => {
  it('pauses on input_required then completes when re-invoked with the appended user reply', async () => {
    const { client } = scriptedClient([
      // First call: ask for clarification.
      assistantToolCalls([
        {
          id: 'q-1',
          name: INPUT_REQUIRED_TOOL,
          arguments: JSON.stringify({ message: 'Which city?' }),
        },
      ]),
      // After resume: answer.
      assistantText('Sunny in San Francisco.'),
    ]);
    const toolbox = new DefaultToolBox();
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox: toolbox,
    });

    // Initial run pauses.
    const initialTask = createTask({
      id: 't-1',
      contextId: 'ctx-1',
      messages: [
        {
          messageId: 'm-1',
          role: 'ROLE_USER',
          parts: [{ text: "What's the weather?" }],
        },
      ],
    });
    const paused = await handler.handle({
      task: initialTask,
      message: initialTask.messages[0] as Message,
      signal: new AbortController().signal,
    });
    expect(paused.state).toBe(TASK_STATE.INPUT_REQUIRED);
    expect(paused.status.message?.parts[0]?.text).toBe('Which city?');

    // Resume: append the user reply, transition to IN_PROGRESS, re-invoke.
    const reply: Message = {
      messageId: 'm-3',
      role: 'ROLE_USER',
      contextId: paused.contextId,
      parts: [{ text: 'San Francisco' }],
    };
    const resumedSeed = transitionTask(
      { ...paused, messages: [...paused.messages, reply] },
      TASK_STATE.IN_PROGRESS
    );
    const finalTask = await handler.handle({
      task: resumedSeed,
      message: reply,
      signal: new AbortController().signal,
    });

    expect(finalTask.state).toBe(TASK_STATE.COMPLETED);
    expect(finalTask.status.message?.parts[0]?.text).toBe(
      'Sunny in San Francisco.'
    );
    // The conversation includes the full pause/resume history.
    expect(finalTask.messages.length).toBeGreaterThanOrEqual(4);
  });
});

describe('SendMessage JSON-RPC pause + resume', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('end-to-end: first message pauses, second message with same contextId resumes the same task', async () => {
    const storage = new InMemoryTaskStorage();
    const { client } = scriptedClient([
      assistantToolCalls([
        {
          id: 'q-1',
          name: INPUT_REQUIRED_TOOL,
          arguments: JSON.stringify({ message: 'Which city?' }),
        },
      ]),
      assistantText('72F and sunny.'),
    ]);
    const toolbox = new DefaultToolBox();
    const agent = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox: toolbox,
    });

    const server = createA2AServer({
      card: { ...makeCard(), capabilities: { streaming: false } },
    });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({
        storage,
        idGenerator: sequentialIdGenerator(),
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    // 1. First message - server creates a PENDING task and returns it.
    const firstRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: MESSAGE_SEND_METHOD,
      params: {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'u-1',
          role: 'ROLE_USER',
          contextId: 'ctx-resume',
          parts: [{ text: "What's the weather?" }],
        },
      },
    });
    const firstBody = (await firstRes.json()) as { result: { task: Task } };
    expect(firstBody.result.task.status.state).toBe(TASK_STATE.PENDING);
    const taskId = firstBody.result.task.id;

    // 2. Drive the background handler manually (no worker in this test).
    const dequeued = await storage.dequeue();
    const paused = await agent.handle({
      task: dequeued,
      message: dequeued.messages[0] as Message,
      signal: new AbortController().signal,
    });
    expect(paused.state).toBe(TASK_STATE.INPUT_REQUIRED);
    storage.updateActive(paused);

    // 3. Second message with the same contextId - server resumes the paused task.
    const secondRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: MESSAGE_SEND_METHOD,
      params: {
        configuration: { returnImmediately: true },
        message: {
          messageId: 'u-2',
          role: 'ROLE_USER',
          contextId: 'ctx-resume',
          parts: [{ text: 'San Francisco' }],
        },
      },
    });
    const secondBody = (await secondRes.json()) as { result: { task: Task } };
    expect(secondBody.result.task.id).toBe(taskId);
    expect(secondBody.result.task.contextId).toBe('ctx-resume');
    expect(secondBody.result.task.status.state).toBe(TASK_STATE.IN_PROGRESS);

    // 4. Process the resumed task.
    const resumed = await storage.dequeue();
    const finalTask = await agent.handle({
      task: resumed,
      message: resumed.messages.at(-1) as Message,
      signal: new AbortController().signal,
    });
    expect(finalTask.id).toBe(taskId);
    expect(finalTask.state).toBe(TASK_STATE.COMPLETED);
    expect(finalTask.status.message?.parts[0]?.text).toBe('72F and sunny.');
  });
});

describe('SendStreamingMessage JSON-RPC pause + resume', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('first stream pauses with an INPUT_REQUIRED status, second stream on same contextId resumes', async () => {
    const storage = new InMemoryTaskStorage();
    const { client } = scriptedClient([
      assistantToolCalls([
        {
          id: 'q-1',
          name: INPUT_REQUIRED_TOOL,
          arguments: JSON.stringify({ message: 'Which city?' }),
        },
      ]),
      assistantText('72F and sunny.'),
    ]);
    const toolbox = new DefaultToolBox();
    const streamHandler = new DefaultStreamingTaskHandler({
      llmClient: client,
      toolBox: toolbox,
    });

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor: streamHandler.asHandler(),
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    // 1. First SendStreamingMessage - pauses on input_required.
    const firstRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 'req-1',
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-1',
            role: 'ROLE_USER',
            contextId: 'ctx-resume',
            parts: [{ text: "What's the weather?" }],
          },
        },
      }),
    });
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get('content-type')).toMatch(/^text\/event-stream/);

    const firstFrames = await readFrames(firstRes);

    // Stream ends on an INPUT_REQUIRED status carrying the prompt.
    const lastFirst = firstFrames[firstFrames.length - 1]?.result.statusUpdate;
    expect(lastFirst?.status.state).toBe(TASK_STATE.INPUT_REQUIRED);
    expect(lastFirst?.status.message?.parts[0]?.text).toBe('Which city?');

    // Paused task must still be discoverable in the active store for resume.
    const paused = storage.getActive('id-1');
    expect(paused?.state).toBe(TASK_STATE.INPUT_REQUIRED);

    // 2. Second SendStreamingMessage with same contextId - resumes the same task.
    const secondRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 'req-2',
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-2',
            role: 'ROLE_USER',
            contextId: 'ctx-resume',
            parts: [{ text: 'San Francisco' }],
          },
        },
      }),
    });
    expect(secondRes.status).toBe(200);

    const secondFrames = await readFrames(secondRes);

    // The resumed stream starts with the same task, back IN_PROGRESS.
    const resumedTask = secondFrames[0]?.result.task;
    expect(resumedTask?.id).toBe('id-1');
    expect(resumedTask?.status.state).toBe(TASK_STATE.IN_PROGRESS);

    // Stream should reach a terminal COMPLETED.
    const lastSecond = secondFrames[secondFrames.length - 1]?.result;
    expect(lastSecond?.statusUpdate?.status.state).toBe(TASK_STATE.COMPLETED);

    // A delta should carry the agent's resumed response.
    const deltaTexts = secondFrames.map(
      (f) => f.result.statusUpdate?.status.message?.parts[0]?.text
    );
    expect(deltaTexts).toContain('72F and sunny.');
  });

  it('ends the stream with an INPUT_REQUIRED status carrying the prompt', async () => {
    const storage = new InMemoryTaskStorage();
    const executor: StreamingTaskExecutor = async function* (
      ctx: StreamingExecutorContext
    ): AsyncIterable<StreamingTaskEvent> {
      const prompt: Message = {
        messageId: 'ask-1',
        role: 'ROLE_AGENT',
        contextId: ctx.task.contextId,
        taskId: ctx.task.id,
        parts: [{ text: 'need more info' }],
      };
      yield { type: 'inputRequiredNotice', message: prompt };
      yield { type: 'inputRequired', message: prompt };
    };

    const server = createA2AServer({ card: makeCard() });
    server.registerStreamingMethod(
      MESSAGE_STREAM_METHOD,
      createMessageStreamHandler({
        storage,
        executor,
        idGenerator: sequentialIdGenerator(),
        env: { [STREAMING_STATUS_UPDATE_INTERVAL_ENV]: '0' },
        heartbeatMs: 0,
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: 'req-1',
        method: MESSAGE_STREAM_METHOD,
        params: {
          message: {
            messageId: 'u-1',
            role: 'ROLE_USER',
            contextId: 'ctx-pause',
            parts: [{ text: 'hi' }],
          },
        },
      }),
    });

    const frames = await readFrames(res);

    expect(frames.map((f) => f.result.statusUpdate?.status.state)).toEqual([
      undefined,
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.INPUT_REQUIRED,
    ]);
    const prompt = frames[2]?.result.statusUpdate?.status.message;
    expect(prompt?.parts[0]?.text).toBe('need more info');
  });
});

describe('Resume with a custom user toolbox containing only non-reserved tools', () => {
  it('still pauses on input_required even when input_required is not in the user toolbox list (handler intercepts by name)', async () => {
    // Custom toolbox without input_required - should still intercept the call.
    const customToolbox: import('../../src/server/index.js').ToolBox = {
      getTools: () => [
        { name: 'lookup', description: 'Look up', parameters: {} },
      ],
      executeTool: async (name) => {
        throw new Error(`unexpected executeTool for ${name}`);
      },
      getToolNames: () => ['lookup'],
      hasTool: (name) => name === 'lookup',
      getTool: () => undefined,
      addTool: () => {
        throw new Error('customToolbox is read-only');
      },
    };

    const { client } = scriptedClient([
      assistantToolCalls([
        {
          id: 'q',
          name: INPUT_REQUIRED_TOOL,
          arguments: JSON.stringify({ message: 'tell me more' }),
        },
      ]),
    ]);
    const handler = new DefaultBackgroundTaskHandler({
      llmClient: client,
      toolBox: customToolbox,
    });
    const task = createTask({
      id: 't',
      contextId: 'c',
      messages: [
        {
          messageId: 'u',
          role: 'ROLE_USER',
          parts: [{ text: 'go' }],
        },
      ],
    });
    const result = await handler.handle({
      task,
      message: task.messages[0] as Message,
      signal: new AbortController().signal,
    });
    expect(result.state).toBe(TASK_STATE.INPUT_REQUIRED);
    expect(result.status.message?.parts[0]?.text).toBe('tell me more');
  });

  it('DefaultToolBox + user tool: input_required is listed alongside the user tool', () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'Look up',
        parameters: { type: 'object' },
        execute: async () => 'x',
      })
    );
    const names = toolbox
      .getTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([INPUT_REQUIRED_TOOL, 'lookup'].sort());
  });
});
