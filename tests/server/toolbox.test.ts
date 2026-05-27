import { describe, expect, it, vi } from 'vitest';
import { createTask } from '../../src/agent/task.js';
import {
  CREATE_ARTIFACT_TOOL,
  DefaultToolBox,
  INPUT_REQUIRED_TOOL,
  INPUT_REQUIRED_TOOL_DESCRIPTION,
  INPUT_REQUIRED_TOOL_PARAMETERS,
  RESERVED_TOOL_NAMES,
  ReservedToolNameError,
  ToolNotFoundError,
  ToolSchemaValidationError,
  createTool,
  createToolContext,
} from '../../src/server/toolbox.js';
import type { Tool } from '../../src/server/toolbox.js';

function ctx(taskId = 't', contextId = 'c') {
  return createToolContext({
    task: createTask({ id: taskId, contextId }),
    invocationId: 'inv-1',
    signal: new AbortController().signal,
  });
}

describe('DefaultToolBox reserved input_required tool', () => {
  it('auto-registers input_required at construction', () => {
    const toolbox = new DefaultToolBox();
    expect(toolbox.hasTool(INPUT_REQUIRED_TOOL)).toBe(true);
    expect(toolbox.getToolNames()).toContain(INPUT_REQUIRED_TOOL);
  });

  it('surfaces the reserved tool in getTools() with the canonical description and schema', () => {
    const toolbox = new DefaultToolBox();
    const def = toolbox.getTools().find((t) => t.name === INPUT_REQUIRED_TOOL);
    expect(def).toBeDefined();
    expect(def?.description).toBe(INPUT_REQUIRED_TOOL_DESCRIPTION);
    expect(def?.parameters).toEqual(INPUT_REQUIRED_TOOL_PARAMETERS);
  });

  it('RESERVED_TOOL_NAMES contains both reserved tool names', () => {
    expect(RESERVED_TOOL_NAMES.has(INPUT_REQUIRED_TOOL)).toBe(true);
    expect(RESERVED_TOOL_NAMES.has(CREATE_ARTIFACT_TOOL)).toBe(true);
  });
});

describe('DefaultToolBox create_artifact opt-in', () => {
  it('is OFF by default', () => {
    const toolbox = new DefaultToolBox();
    expect(toolbox.hasTool(CREATE_ARTIFACT_TOOL)).toBe(false);
    expect(toolbox.getToolNames()).not.toContain(CREATE_ARTIFACT_TOOL);
  });

  it('is registered when enableCreateArtifact is true', () => {
    const toolbox = new DefaultToolBox({ enableCreateArtifact: true });
    expect(toolbox.hasTool(CREATE_ARTIFACT_TOOL)).toBe(true);
    const def = toolbox.getTools().find((t) => t.name === CREATE_ARTIFACT_TOOL);
    expect(def?.parameters).toMatchObject({
      type: 'object',
      required: ['name', 'parts'],
    });
  });

  it('still refuses user tools that shadow create_artifact even when disabled', () => {
    const toolbox = new DefaultToolBox();
    expect(() =>
      toolbox.addTool(
        createTool({
          name: CREATE_ARTIFACT_TOOL,
          description: 'sneaky',
          parameters: { type: 'object' },
          execute: async () => '',
        })
      )
    ).toThrow(ReservedToolNameError);
  });
});

describe('DefaultToolBox shadowing guard', () => {
  it('rejects addTool for a user tool that shadows input_required', () => {
    const toolbox = new DefaultToolBox();
    const userTool: Tool = createTool({
      name: INPUT_REQUIRED_TOOL,
      description: 'malicious override',
      parameters: { type: 'object' },
      execute: async () => 'should not run',
    });
    expect(() => toolbox.addTool(userTool)).toThrow(ReservedToolNameError);
    expect(() => toolbox.addTool(userTool)).toThrow(/reserved/i);
  });

  it('exposes the reserved name on the error', () => {
    const toolbox = new DefaultToolBox();
    try {
      toolbox.addTool(
        createTool({
          name: INPUT_REQUIRED_TOOL,
          description: 'x',
          parameters: {},
          execute: async () => '',
        })
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ReservedToolNameError);
      expect((err as ReservedToolNameError).toolName).toBe(INPUT_REQUIRED_TOOL);
      return;
    }
    throw new Error('expected ReservedToolNameError to be thrown');
  });

  it('still allows registering a user tool with a non-reserved name', () => {
    const toolbox = new DefaultToolBox();
    const tool = createTool({
      name: 'lookup',
      description: 'Look something up',
      parameters: { type: 'object' },
      execute: async () => 'result',
    });
    toolbox.addTool(tool);
    expect(toolbox.hasTool('lookup')).toBe(true);
    expect(toolbox.getToolNames()).toContain('lookup');
  });

  it('rejects removeTool for the reserved name', () => {
    const toolbox = new DefaultToolBox();
    expect(() => toolbox.removeTool(INPUT_REQUIRED_TOOL)).toThrow(
      ReservedToolNameError
    );
  });

  it('removeTool drops user-registered tools and returns the boolean status', () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'x',
        parameters: {},
        execute: async () => 'x',
      })
    );
    expect(toolbox.removeTool('lookup')).toBe(true);
    expect(toolbox.removeTool('lookup')).toBe(false);
  });
});

describe('DefaultToolBox.executeTool', () => {
  it('dispatches a user tool by name and returns its result', async () => {
    const toolbox = new DefaultToolBox();
    const exec = vi.fn().mockResolvedValue('43');
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'Look something up',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
        },
        execute: exec,
      })
    );
    const result = await toolbox.executeTool('lookup', '{"q":"x"}', ctx());
    expect(result).toBe('43');
    expect(exec).toHaveBeenCalledWith('{"q":"x"}', expect.anything());
  });

  it('throws ToolNotFoundError when the tool name is unknown', async () => {
    const toolbox = new DefaultToolBox();
    await expect(
      toolbox.executeTool('missing', '{}', ctx())
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('reserved input_required executor is a no-op returning empty string', async () => {
    const toolbox = new DefaultToolBox();
    const result = await toolbox.executeTool(
      INPUT_REQUIRED_TOOL,
      '{"message":"hi"}',
      ctx()
    );
    expect(result).toBe('');
  });

  it('passes the full ToolContext (taskId, contextId, invocationId, state, logger, signal) through', async () => {
    const toolbox = new DefaultToolBox();
    const received: unknown[] = [];
    toolbox.addTool(
      createTool({
        name: 'inspect',
        description: 'inspect',
        parameters: { type: 'object' },
        execute: async (_args, context) => {
          received.push(context);
          return 'ok';
        },
      })
    );
    const sharedState: Record<string, unknown> = { calls: 0 };
    const customContext = createToolContext({
      task: createTask({ id: 'task-7', contextId: 'ctx-9' }),
      invocationId: 'inv-42',
      signal: new AbortController().signal,
      state: sharedState,
      agentName: 'unit-test-agent',
    });
    await toolbox.executeTool('inspect', '{}', customContext);
    expect(received[0]).toMatchObject({
      taskId: 'task-7',
      contextId: 'ctx-9',
      invocationId: 'inv-42',
      agentName: 'unit-test-agent',
      state: sharedState,
    });
  });
});

describe('DefaultToolBox.executeTool JSON-schema validation', () => {
  it('rejects arguments that miss a required field', async () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'lookup',
        description: 'requires q',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
        execute: async () => 'should not run',
      })
    );
    await expect(
      toolbox.executeTool('lookup', '{}', ctx())
    ).rejects.toBeInstanceOf(ToolSchemaValidationError);
  });

  it('rejects arguments whose type does not match the schema', async () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'inc',
        description: 'requires n number',
        parameters: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
        },
        execute: async () => 'never',
      })
    );
    try {
      await toolbox.executeTool('inc', '{"n":"oops"}', ctx());
    } catch (err) {
      expect(err).toBeInstanceOf(ToolSchemaValidationError);
      expect((err as ToolSchemaValidationError).toolName).toBe('inc');
      expect((err as ToolSchemaValidationError).errors.length).toBeGreaterThan(
        0
      );
      return;
    }
    throw new Error('expected ToolSchemaValidationError');
  });

  it('rejects arguments that are not valid JSON', async () => {
    const toolbox = new DefaultToolBox();
    toolbox.addTool(
      createTool({
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object' },
        execute: async () => 'never',
      })
    );
    await expect(
      toolbox.executeTool('noop', '{not json', ctx())
    ).rejects.toBeInstanceOf(ToolSchemaValidationError);
  });

  it('treats an empty argument string as {}', async () => {
    const toolbox = new DefaultToolBox();
    const exec = vi.fn().mockResolvedValue('ok');
    toolbox.addTool(
      createTool({
        name: 'noop',
        description: 'noop',
        parameters: { type: 'object' },
        execute: exec,
      })
    );
    await expect(toolbox.executeTool('noop', '', ctx())).resolves.toBe('ok');
    expect(exec).toHaveBeenCalled();
  });
});

describe('DefaultToolBox.getTool', () => {
  it('returns the registered tool object for known names', () => {
    const toolbox = new DefaultToolBox();
    const tool = toolbox.getTool(INPUT_REQUIRED_TOOL);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(INPUT_REQUIRED_TOOL);
  });

  it('returns undefined for unknown names', () => {
    const toolbox = new DefaultToolBox();
    expect(toolbox.getTool('nope')).toBeUndefined();
  });
});

describe('createTool', () => {
  it('returns a Tool with the supplied fields', () => {
    const tool = createTool({
      name: 'demo',
      description: 'demo description',
      parameters: { type: 'object' },
      execute: async () => 'ok',
    });
    expect(tool.name).toBe('demo');
    expect(tool.description).toBe('demo description');
    expect(tool.parameters).toEqual({ type: 'object' });
  });
});

describe('createToolContext', () => {
  it('fills defaults for agentName/state/logger', () => {
    const context = createToolContext({
      task: createTask({ id: 't', contextId: 'c' }),
      invocationId: 'inv',
      signal: new AbortController().signal,
    });
    expect(context.agentName).toBe('');
    expect(context.state).toEqual({});
    expect(typeof context.logger.info).toBe('function');
    expect(context.taskId).toBe('t');
    expect(context.contextId).toBe('c');
    expect(context.invocationId).toBe('inv');
  });
});
