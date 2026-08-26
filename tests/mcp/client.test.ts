import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  MCPClient,
  createMCPClientFromEnv,
  joinEndpoint,
  loadMCPConfigFromEnv,
} from '../../src/mcp/index.js';

describe('joinEndpoint', () => {
  it('appends the endpoint, collapsing a duplicate slash', () => {
    expect(joinEndpoint('http://host:8080', '/mcp')).toBe(
      'http://host:8080/mcp'
    );
    expect(joinEndpoint('http://host:8080/', '/mcp')).toBe(
      'http://host:8080/mcp'
    );
    expect(joinEndpoint('http://host:8080', 'mcp')).toBe(
      'http://host:8080/mcp'
    );
  });
});

describe('createMCPClientFromEnv', () => {
  it('returns undefined when MCP is disabled', () => {
    expect(
      createMCPClientFromEnv({ env: { A2A_MCP_SERVERS: 'http://a' } })
    ).toBeUndefined();
  });

  it('returns undefined when enabled but no servers are configured', () => {
    expect(
      createMCPClientFromEnv({ env: { A2A_MCP_ENABLED: 'true' } })
    ).toBeUndefined();
  });

  it('returns a client when enabled with servers', () => {
    const client = createMCPClientFromEnv({
      env: { A2A_MCP_ENABLED: 'true', A2A_MCP_SERVERS: 'http://a:8080' },
    });
    expect(client).toBeInstanceOf(MCPClient);
  });
});

describe('MCPClient', () => {
  it('starts with no servers without throwing and lists nothing', () => {
    const client = new MCPClient(
      loadMCPConfigFromEnv({ A2A_MCP_ENABLED: 'true' })
    );
    expect(() => client.start()).not.toThrow();
    expect(client.listTools()).toEqual([]);
  });

  it('discovers tools in the background and invokes one over the transport', async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echoes a fixed pong.' },
      async () => ({ content: [{ type: 'text', text: 'pong' }] })
    );
    await server.connect(serverTransport);

    const config = loadMCPConfigFromEnv({
      A2A_MCP_ENABLED: 'true',
      A2A_MCP_SERVERS: 'http://in-memory',
      A2A_MCP_REFRESH_INTERVAL: '1h',
    });

    class TestMCPClient extends MCPClient {
      protected override createTransport(): Transport {
        return clientTransport as unknown as Transport;
      }
    }

    const client = new TestMCPClient(config);
    client.start();

    await vi.waitFor(() => {
      expect(client.listTools().length).toBeGreaterThan(0);
    });

    const tools = client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0]?.server).toBe('http://in-memory');
    expect(client.listTools('echo')).toHaveLength(1);
    expect(client.listTools('nope')).toHaveLength(0);

    const result = JSON.parse(await client.callTool({ name: 'echo' })) as {
      isError: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('pong');

    const missing = JSON.parse(
      await client.callTool({ name: 'does_not_exist' })
    ) as { isError: boolean };
    expect(missing.isError).toBe(true);

    await client.stop();
    await server.close();
  });
});
