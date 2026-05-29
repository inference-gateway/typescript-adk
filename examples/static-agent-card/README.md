# Static Agent Card Example

Demonstrates loading agent metadata from a JSON file with build-time `${VAR}` placeholder substitution.

Mirrors the Go ADK's [`examples/static-agent-card/`](https://github.com/inference-gateway/adk/tree/main/examples/static-agent-card).

## What this example shows

- Store agent configuration in a version-controlled JSON file instead of hardcoding it in TypeScript.
- Load it at boot time via `loadAgentCardFromFile()` (or the one-liner sugar `A2AServerBuilder.withAgentCardFromFile()`).
- Use `${VAR}` placeholders in the JSON that are resolved against `process.env` — no code changes needed for environment-specific config.
- Dynamically override fields at runtime via the `overrides` parameter of either loader.
- Route incoming messages to the correct skill declared on the agent card.

## The `${VAR}` placeholder convention

Any string value in `agent-card.json` can contain `${SOME_NAME}` placeholders.
The underlying [`loadAgentCardFromFile`](../../src/agent/card.ts) function
resolves every `${NAME}` against `process.env[NAME]` **before** the card is
validated and used.

**Behaviour:**

| Scenario                     | Result                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| Environment variable is set  | Placeholder is replaced with the variable's value           |
| Variable is not set          | `AgentCardLoadError` is thrown — the server refuses to boot |
| No placeholders in the value | Value is used verbatim                                      |

This "fail loud" approach catches missing configuration at startup instead of
producing a silently broken agent card.

The pattern is recursive: placeholders inside arrays, nested objects, and even
inside already-substituted strings are all resolved.

### Example

```json
{
  "name": "${A2A_AGENT_NAME}",
  "url": "http://${A2A_SERVER_HOST}:${A2A_SERVER_PORT}"
}
```

With `A2A_AGENT_NAME=my-agent`, `A2A_SERVER_HOST=127.0.0.1`, and
`A2A_SERVER_PORT=8080` set in the environment, the resolved card will have:

```json
{
  "name": "my-agent",
  "url": "http://127.0.0.1:8080"
}
```

## Runtime overrides

Both `loadAgentCardFromFile(filePath, { overrides })` and the sugar
`withAgentCardFromFile(filePath, overrides?)` accept an `overrides` map that
wins over values from the JSON file **after** placeholder resolution. This is
useful for fields that are genuinely runtime (e.g., a dynamically-assigned
port):

```ts
// Sugar — when you don't need the resolved card outside the builder:
const builder = new A2AServerBuilder({ storage })
  .withAgentCardFromFile('agent-card.json', {
    url: `http://${HOST}:${PORT}`,
  })
  .withDefaultBackgroundTaskHandler();
```

```ts
// Explicit — when you do need the card (e.g., for skill routing, as in this
// example's server.ts):
const card = loadAgentCardFromFile('agent-card.json', {
  overrides: { url: `http://${HOST}:${PORT}` },
});

const builder = new A2AServerBuilder({ storage })
  .withAgentCard(card)
  .withBackgroundTaskHandler(createStaticCardHandler(card));
```

Override fields always win over values in the JSON file.

## Layout

```text
examples/static-agent-card/
├── .env.example        # Template for the env vars referenced from agent-card.json
├── README.md           # This file
├── agent-card.json     # Agent metadata with ${VAR} placeholders
├── client.ts           # Fetches the card and sends a test message
├── package.json        # Workspace package, depends only on @inference-gateway/adk
├── server.ts           # A2A server using withAgentCardFromFile
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

Set the environment variables referenced in `agent-card.json`:

```sh
export A2A_AGENT_NAME=static-card-agent
export A2A_AGENT_DESCRIPTION="A demonstration agent that loads its configuration from a static JSON file"
export A2A_AGENT_VERSION=0.1.0
export A2A_SERVER_HOST=127.0.0.1
export A2A_SERVER_PORT=8080
```

Or copy the checked-in template and source it:

```sh
cp examples/static-agent-card/.env.example examples/static-agent-card/.env
set -a; source examples/static-agent-card/.env; set +a
```

(`.env` is git-ignored; `.env.example` is the version-controlled template.)

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-static-agent-card start:server
```

In another terminal (same shell session), run the client:

```sh
pnpm --filter @inference-gateway/adk-example-static-agent-card start:client
```

`pnpm --filter @inference-gateway/adk-example-static-agent-card start` is an alias for `start:server`.

### Custom card path

Point the server at a different JSON file:

```sh
A2A_AGENT_CARD_FILE=./my-custom-card.json pnpm --filter @inference-gateway/adk-example-static-agent-card start:server
```

## Configuration

Server (`server.ts`):

| Env var               | Required | Default           | Description                       |
| --------------------- | -------- | ----------------- | --------------------------------- |
| `A2A_AGENT_CARD_FILE` | no       | `agent-card.json` | Path to the agent card JSON file. |
| `A2A_SERVER_HOST`     | no       | `127.0.0.1`       | Listen host.                      |
| `A2A_SERVER_PORT`     | no       | `8080`            | Listen port.                      |

The following variables are consumed by `${VAR}` placeholders in the default
`agent-card.json` and **must** be set when using the checked-in file:

| Env var                 | Example value                                                                |
| ----------------------- | ---------------------------------------------------------------------------- |
| `A2A_AGENT_NAME`        | `static-card-agent`                                                          |
| `A2A_AGENT_DESCRIPTION` | `A demonstration agent that loads its configuration from a static JSON file` |
| `A2A_AGENT_VERSION`     | `0.1.0`                                                                      |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                                                  |
| `A2A_SERVER_PORT`       | `8080`                                                                       |

Client (`client.ts`):

| Env var      | Default                                    | Description                                                                                                                                |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER_URL` | `http://127.0.0.1:8080`                    | Base URL of the A2A server.                                                                                                                |
| `PROMPT`     | `Tell me about your static configuration.` | Text for the first message. The second prompt (`Please echo this sentence back to me verbatim.`) is hard-coded to demonstrate both skills. |

## Skill routing

The A2A wire protocol does not carry a skill id on each message — skills are
metadata advertised on the agent card. The example server routes by matching
keywords in the user text against the two skills declared in
[`agent-card.json`](./agent-card.json):

| User text contains                         | Routed skill  | Response                                                          |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------- |
| `config`, `configuration`, `info`, `about` | `config-info` | Echoes the resolved card metadata (name, version, description, …) |
| anything else                              | `echo`        | Echoes the user text verbatim                                     |

The client sends one message per skill on startup so you can see both
responses without setting `PROMPT` manually.

## Expected output

Server:

```text
static-card-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/
  config: agent-card.json
```

Client:

```text
=== Agent Card (loaded from agent-card.json) ===
{
  "name": "static-card-agent",
  "description": "A demonstration agent that loads its configuration from a static JSON file",
  ...
  "skills": [
    { "id": "echo", "name": "Echo", ... },
    { "id": "config-info", "name": "Configuration Info", ... }
  ]
}

Agent: static-card-agent
Version: 0.1.0
...

=== Sending message ===
POST http://127.0.0.1:8080/  message/send  "Tell me about your static configuration."
created task id=… state=TASK_STATE_SUBMITTED
final state: TASK_STATE_COMPLETED
agent reply:
[skill=config-info] Configuration loaded from agent-card.json:
  name:        static-card-agent
  version:     0.1.0
  description: A demonstration agent that loads its configuration from a static JSON file
  url:         http://127.0.0.1:8080
  skills:
    - echo: Echo
    - config-info: Configuration Info

=== Sending message ===
POST http://127.0.0.1:8080/  message/send  "Please echo this sentence back to me verbatim."
created task id=… state=TASK_STATE_SUBMITTED
final state: TASK_STATE_COMPLETED
agent reply:
[skill=echo] You said: Please echo this sentence back to me verbatim.

=== Static agent card demonstration completed ===
The agent card above was loaded from agent-card.json using loadAgentCardFromFile().
${VAR} placeholders in that JSON were resolved against process.env at server startup.
```

## Injecting build-time metadata

When you build and deploy your own agent, you can inject version and description
at build time so every deployment is uniquely identifiable:

**CI / Docker** — set `A2A_AGENT_VERSION` to the CI pipeline run number or Git
SHA, and `A2A_AGENT_DESCRIPTION` to a meaningful label:

```dockerfile
ENV A2A_AGENT_VERSION=sha-$(git rev-parse --short HEAD)
ENV A2A_AGENT_DESCRIPTION="Build from branch $(git rev-parse --abbrev-ref HEAD)"
```

**tsup `define`** — the TS ADK also supports bundle-time substitution via
`process.env.BUILD_AGENT_NAME` / `BUILD_AGENT_DESCRIPTION` / `BUILD_AGENT_VERSION`
(see [`build-metadata.ts`](../../src/agent/build-metadata.ts)). These are
separate from the `${VAR}` convention but can be combined.

## Benefits of static agent cards

1. **Separation of concerns** — agent metadata is externalised from business logic.
2. **Environment-specific configs** — dev, staging, and production each get their own card (or the same card with different env vars).
3. **No recompilation** — change the agent description, skills, or capabilities by editing JSON, not TypeScript.
4. **Version control** — track agent configuration changes in Git alongside code.
5. **Runtime overrides** — pin fields like `url` that are genuinely runtime without touching the JSON file.

## Next steps

- Try [`examples/minimal/`](../minimal/) for the smallest end-to-end A2A loop.
- Try [`examples/ai-powered/`](../ai-powered/) for an LLM-backed agent with tools.
- Try [`examples/default-handlers/`](../default-handlers/) for the `A2AServerBuilder` builder pattern with streaming.
