# MCP client example

An LLM-backed A2A agent that discovers and invokes tools from
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers, using
the ADK's MCP client and the two **selector tools** it registers:

- `mcp_list_tools` - list tools discovered from the configured MCP servers
  (server, name, description, input schema), with an optional `search` filter.
- `mcp_call_tool` - invoke a discovered tool by `name` (optionally disambiguated
  by `server`) with an `arguments` object.

Only these two tools are advertised to the LLM regardless of how many tools the
MCP servers expose, so the model's context stays small. Tool catalogs are
discovered in the background and refreshed on an interval; listing returns from
an in-memory snapshot. This mirrors the Go ADK's MCP client.

## Run

From the repo root, build the ADK first (the example consumes the built
package):

```sh
pnpm build
```

Then start the server with an LLM provider and one or more MCP servers:

```sh
# LLM provider (see the ai-powered example for details)
export A2A_AGENT_CLIENT_PROVIDER=openai
export A2A_AGENT_CLIENT_MODEL=gpt-4o-mini
export OPENAI_API_KEY=sk-...

# MCP client
export MCP_ENABLE=true
export MCP_SERVERS=http://localhost:3000

pnpm --filter @inference-gateway/adk-example-mcp start:server
```

In another terminal, send a couple of prompts:

```sh
pnpm --filter @inference-gateway/adk-example-mcp start:client
```

With `MCP_ENABLE` unset (the default) the agent still runs - it just has no MCP
tools registered.

## Configuration (`MCP_*`)

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_ENABLE` | `false` | Enable the MCP client |
| `MCP_SERVERS` | - | Comma-separated MCP server base URLs |
| `MCP_ENDPOINT` | `/mcp` | Path appended to each server URL |
| `MCP_REFRESH_INTERVAL` | `5m` | Tool-catalog refresh interval |
| `MCP_DIAL_TIMEOUT` | `30s` | Init/list-tools timeout |
| `MCP_CALL_TIMEOUT` | `30s` | Single tool-invocation timeout |
| `MCP_MAX_RETRIES` | `0` | Max initial connection attempts (0 = retry forever) |
| `MCP_RETRY_INTERVAL` | `2s` | Initial backoff (doubles) |
| `MCP_RETRY_MAX_INTERVAL` | `30s` | Max backoff |

Durations accept Go-style strings (`5m`, `30s`, `1m30s`).

Transport is **Streamable HTTP** only (via the official
`@modelcontextprotocol/sdk` client transport); stdio/subprocess servers are not
wired.

## Wiring it into your own agent

```ts
import {
  DefaultToolBox,
  createMCPClientFromEnv,
  registerMCPTools,
} from '@inference-gateway/adk';

const toolBox = new DefaultToolBox();
const mcp = createMCPClientFromEnv(); // undefined when MCP_ENABLE is falsy
if (mcp !== undefined) {
  mcp.start(); // non-blocking background discovery + refresh
  registerMCPTools(toolBox, mcp);
}
// ... hand `toolBox` to your task handler; call `await mcp?.stop()` on shutdown.
```
