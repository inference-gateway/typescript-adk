<h1 align="center">Agent Development Kit (ADK) - TypeScript</h1>

<p align="center">
  <strong>Build powerful, interoperable AI agents with the Agent-to-Agent (A2A) protocol - in TypeScript.</strong>
</p>

> ⚠️ **Early Stage**: This project is in early bootstrap and the public API is not yet stable. Breaking changes are expected before 1.0. Pin a specific version in production and review [`CHANGELOG.md`](./CHANGELOG.md) before upgrading.

<p align="center">
  <!-- CI Status Badge -->
  <a href="https://github.com/inference-gateway/typescript-adk/actions/workflows/ci.yml?query=branch%3Amain">
    <img src="https://github.com/inference-gateway/typescript-adk/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI Status"/>
  </a>
  <!-- npm Version -->
  <a href="https://www.npmjs.com/package/@inference-gateway/adk">
    <img src="https://img.shields.io/npm/v/@inference-gateway/adk?color=blue&style=flat-square" alt="npm version"/>
  </a>
  <!-- License Badge -->
  <a href="./LICENSE">
    <img src="https://img.shields.io/npm/l/@inference-gateway/adk?color=blue&style=flat-square" alt="License"/>
  </a>
  <!-- Node Version -->
  <img src="https://img.shields.io/node/v/@inference-gateway/adk?style=flat-square" alt="Node version"/>
</p>

---

## Table of Contents

- [Overview](#overview)
  - [What is A2A?](#what-is-a2a)
- [🚀 Quick Start](#-quick-start)
  - [Installation](#installation)
  - [Hello, A2A](#hello-a2a)
  - [Examples](#examples)
- [✨ Key Features](#-key-features)
- [📖 API Reference](#-api-reference)
  - [Core Components](#core-components)
  - [Configuration](#configuration)
    - [Build-Time Agent Metadata](#build-time-agent-metadata)
    - [Agent-card `${VAR}` placeholders](#agent-card-var-placeholders)
- [🔧 Advanced Usage](#-advanced-usage)
- [🌐 A2A Ecosystem](#-a2a-ecosystem)
- [📋 Requirements](#-requirements)
- [📦 Container Image](#-container-image)
- [📄 License](#-license)
- [🤝 Contributing](#-contributing)
- [📞 Support](#-support)
- [🔗 Resources](#-resources)

---

## Overview

The **TypeScript ADK (Agent Development Kit)** is a Node.js library that simplifies building [Agent-to-Agent (A2A) protocol](https://github.com/inference-gateway/schemas/tree/main/a2a) compatible agents. A2A enables seamless communication between AI agents, allowing them to collaborate, delegate tasks, and share capabilities across different systems and providers.

It is the TypeScript sibling of the [Go ADK](https://github.com/inference-gateway/adk) and the [Rust ADK](https://github.com/inference-gateway/rust-adk), and ships as the npm package [`@inference-gateway/adk`](https://www.npmjs.com/package/@inference-gateway/adk). Patterns mirror the Go implementation where the languages allow - for example, `BUILD_AGENT_NAME` / `BUILD_AGENT_DESCRIPTION` / `BUILD_AGENT_VERSION` mirror the Go ADK's `BuildAgentName` / `BuildAgentDescription` / `BuildAgentVersion` LD-flag injection points.

### What is A2A?

Agent-to-Agent (A2A) is a standardized protocol that enables AI agents to:

- **Communicate** with each other using a unified JSON-RPC interface
- **Delegate tasks** to specialized agents with specific capabilities
- **Stream responses** in real-time for better user experience
- **Discover capabilities** through standardized agent cards

## 🚀 Quick Start

### Installation

```sh
pnpm add @inference-gateway/adk
# or
npm install @inference-gateway/adk
# or
yarn add @inference-gateway/adk
```

Requires **Node.js 24 LTS or newer**. The package is ESM-only.

### Hello, A2A

A minimal A2A agent that echoes every message it receives, plus a client that sends one message and waits for the task to complete. This is the smallest end-to-end usage of the ADK - the full runnable version with shutdown handling, message extraction, and dead-lettering lives in [`examples/minimal/`](./examples/minimal/).

**`server.ts`** - boot an A2A server with built-in `message/send`, `tasks/get`, and `tasks/list` handlers, plus an inline echo worker:

```ts
import {
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
  createTaskListHandler,
  InMemoryTaskStorage,
  MESSAGE_SEND_METHOD,
  TASK_GET_METHOD,
  TASK_LIST_METHOD,
  TASK_STATE,
  transitionTask,
  type AgentCard,
} from '@inference-gateway/adk';

const card: AgentCard = {
  name: 'hello-agent',
  description: 'Echoes every message it receives.',
  version: '0.1.0',
  protocolVersion: '0.3.0',
  url: 'http://127.0.0.1:8080',
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [
    { id: 'echo', name: 'Echo', description: 'Echo input.', tags: ['echo'] },
  ],
};

const storage = new InMemoryTaskStorage();
const server = createA2AServer({ card });
server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));

void runWorker();
await server.listen(8080, '127.0.0.1');
console.log('listening on http://127.0.0.1:8080');

async function runWorker(): Promise<void> {
  while (true) {
    const task = await storage.dequeue();
    const running = transitionTask(task, TASK_STATE.IN_PROGRESS);
    storage.updateActive(running);
    storage.storeDeadLetter(transitionTask(running, TASK_STATE.COMPLETED));
  }
}
```

**`client.ts`** - send a message and poll `tasks/get` until the task reaches a terminal state:

```ts
import {
  createA2AClient,
  isTerminal,
  type ManagedTaskState,
} from '@inference-gateway/adk';

const client = createA2AClient({ baseURL: 'http://127.0.0.1:8080' });

let task = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: 'hello, agent' }],
  },
});

while (!isTerminal(task.status.state as ManagedTaskState)) {
  await new Promise((r) => setTimeout(r, 200));
  task = await client.getTask(task.id);
}

console.log(task);
```

### Examples

Complete, runnable examples live under [`examples/`](./examples/):

- **[`examples/minimal/`](./examples/minimal/)** - A2A server + client with no LLM. Demonstrates the full task lifecycle, a graceful echo worker with dead-lettering, and `A2AClient` polling. Mirrors the Go ADK's [`examples/minimal/`](https://github.com/inference-gateway/adk/tree/main/examples/minimal).
- **[`examples/streaming/`](./examples/streaming/)** - A2A server + client over SSE. Boots a server with `capabilities.streaming = true`, registers a custom `message/stream` executor that emits word-by-word `delta` events, and consumes the SSE frames from a plain `fetch`-based client. Mirrors the Go ADK's [`examples/streaming/`](https://github.com/inference-gateway/adk/tree/main/examples/streaming).
- **[`examples/input-required/`](./examples/input-required/)** - Pause + client-driven resume. The server pauses a task to ask for a missing piece of information (`INPUT_REQUIRED`), and the client detects the pause, sends a follow-up on the same `contextId`, and polls until completion. Mirrors the Go ADK's [`examples/input-required/`](https://github.com/inference-gateway/adk/tree/main/examples/input-required).
- **[`examples/ai-powered/`](./examples/ai-powered/)** - LLM-backed A2A agent with weather and time tools. Wires `AgentBuilder` + `OpenAICompatibleLLMClient` into `DefaultBackgroundTaskHandler`, dispatches tool calls in a chat-completion loop, and answers natural-language prompts through any provider routed via the Inference Gateway (OpenAI, Anthropic, Groq, DeepSeek, Mistral, Cohere, Cloudflare, Google, Nvidia, Ollama, ...). Mirrors the Go ADK's [`examples/ai-powered/`](https://github.com/inference-gateway/adk/tree/main/examples/ai-powered).
- **[`examples/queue-storage/`](./examples/queue-storage/)** - Two variants of the same echo agent showing how to swap storage backends: [`in-memory/`](./examples/queue-storage/in-memory/) uses `InMemoryTaskStorage` (zero ops, no persistence) and [`redis/`](./examples/queue-storage/redis/) uses `RedisTaskStorage.connect()` with a bundled `docker-compose.yml` for local Redis (queue and dead-letter survive restarts, multi-instance fan-out via `BRPOP`). Mirrors the Go ADK's [`examples/queue-storage/`](https://github.com/inference-gateway/adk/tree/main/examples/queue-storage).
- **[`examples/usage-metadata/`](./examples/usage-metadata/)** - Per-task token usage and execution stats serialized into `task.metadata.usage` / `task.metadata.execution_stats` on completion. Exercises both `DefaultBackgroundTaskHandler` and `DefaultStreamingTaskHandler` with `setEnableUsageMetadata(true)`; the client prints the resulting metadata from both `tasks/get` and the terminal SSE status frame. Mirrors the Go ADK's [`examples/usage-metadata/`](https://github.com/inference-gateway/adk/tree/main/examples/usage-metadata).
- **[`examples/tls-server/`](./examples/tls-server/)** - A2A server + client over HTTPS with a self-signed cert. Boots `A2AServer` with `tls: loadServerTLSConfigFromEnv()`, drives the client over HTTPS via `tls: { caPath }`, and includes a `generate-certs.sh` helper plus Docker / Kubernetes cert-mount recipes. Mirrors the Go ADK's [`examples/tls-server/`](https://github.com/inference-gateway/adk/tree/main/examples/tls-server).

Each example ships its own README with setup instructions.

## ✨ Key Features

### Core Capabilities

- 🤖 **A2A Protocol Compliance** - JSON-RPC 2.0 endpoint, agent-card discovery at `/.well-known/agent-card.json`, and `/health` liveness probe
- 📬 **Built-in Handlers** - Drop-in `message/send`, `tasks/get`, and `tasks/list` JSON-RPC handlers backed by any `TaskStorage`
- 🔌 **Extensible JSON-RPC** - Register custom methods on the per-server `MethodRegistry`
- 🔁 **Task Lifecycle** - Strict state machine (`SUBMITTED → WORKING → {INPUT_REQUIRED | COMPLETED | FAILED | CANCELLED}`) with `TaskTransitionError` on invalid transitions
- 🗄️ **Pluggable Storage** - Small `TaskStorage` interface with `InMemoryTaskStorage` included; queue / active / dead-letter semantics out of the box, plus a `runTaskStorageConformance` test factory (exported from `@inference-gateway/adk/testing`) so any backend can verify itself against the contract
- 🛰️ **A2A Client** - `A2AClient` with `sendMessage`, `getTask`, `getAgentCard`, `getHealth`, configurable timeout, retry with exponential backoff, and a typed error taxonomy
- 📇 **AgentCard Loading** - Load from file or JSON with `${VAR}` env-placeholder resolution, optional shallow overrides, and required-field validation
- 🏷️ **Build-Time Metadata** - Inject `name` / `description` / `version` at bundle or runtime (mirrors the Go ADK's `BuildAgent*` LD flags)
- ☁️ **CloudEvents v1.0** - `createCloudEvent` helper for wrapping agent events in a spec-compliant envelope
- 📡 **SSE Streaming** - `SSEStreamWriter` for emitting Server-Sent Events with a configurable heartbeat
- 🔒 **TLS** - Server-side HTTPS termination via `tls: { certPath, keyPath }` (driven by `TLS_ENABLE` / `TLS_CERT_PATH` / `TLS_KEY_PATH` env vars); outbound `ClientTLSConfig` on both `A2AClient` and `OpenAICompatibleLLMClient` for self-signed or mTLS peers. Built on `node:https` / `node:tls` - no third-party TLS dependency.

### Developer Experience

- 📦 **ESM-only** - Modern ES2024 bundle via `tsup`, targeted at Node 24 LTS+
- 🛡️ **Strict TypeScript** - `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`
- 📚 **Generated A2A Types** - Types generated from the canonical [`inference-gateway/schemas`](https://github.com/inference-gateway/schemas) at a pinned commit SHA, with a drift check enforced in CI
- 🧪 **Well Tested** - Vitest suite covering the public surface; a dedicated drift test guards the generated A2A types
- 🪶 **Minimal Dependencies** - Only `hono` + `@hono/node-server` at runtime

### Status & Roadmap

The TypeScript ADK currently focuses on the core A2A protocol surface: `message/send`, `tasks/get`, `tasks/list`, AgentCard discovery, the task lifecycle state machine, in-memory and Redis-backed storage, the retrying client, CloudEvents, and SSE. Capabilities that exist in the [Go ADK](https://github.com/inference-gateway/adk) but are **not yet implemented** here include: LLM client / multi-provider chat completion, streaming task handlers, additional JSON-RPC methods (`tasks/cancel`, `tasks/resubscribe`, `tasks/pushNotificationConfig/*`, `agent/getAuthenticatedExtendedCard`), file artifacts (filesystem & MinIO), OIDC/OAuth authentication, and push notifications. OpenTelemetry-based observability (traces, logs, and OTLP-push or Prometheus-pull metrics) is available via `createTelemetryProvider` - see [Telemetry & metrics exporters](#telemetry--metrics-exporters). The TS ADK tracks the Go ADK as the long-term feature target - contributions toward parity are welcome.

## 📖 API Reference

### Core Components

#### `A2AServer` / `createA2AServer`

The main HTTP server. Exposes the JSON-RPC endpoint at `DEFAULT_JSONRPC_PATH` (`POST /`), an AgentCard discovery endpoint at `AGENT_CARD_PATH` (`/.well-known/agent-card.json`), and a liveness probe at `HEALTH_PATH` (`/health`). The endpoint mount points and the agent-card `Cache-Control` header (`DEFAULT_AGENT_CARD_CACHE_CONTROL`) are configurable via `A2AServerConfig`.

```ts
const server = createA2AServer({ card });
await server.listen(8080, '127.0.0.1');
// ...
await server.close();
```

A freshly constructed server already serves discovery and health - no method registration is required just to be reachable.

#### `MethodRegistry` and JSON-RPC dispatch

JSON-RPC methods are registered on a per-server `MethodRegistry`. Call `server.registerMethod(name, handler)` (or `unregisterMethod` / `hasMethod` / `registeredMethods`) to wire up methods. The lower-level helpers `dispatch`, `createSuccessResponse`, `createErrorResponse`, `JSONRPCError`, and `JSONRPC_ERROR_CODES` are exported as well - useful for custom transports or focused unit tests.

#### Built-in handlers

- **`createMessageSendHandler({ storage })`** registers as `MESSAGE_SEND_METHOD` (`message/send`). It accepts a JSON-RPC `message/send` request, creates a `SUBMITTED` task, enqueues it on the supplied `TaskStorage`, and returns the wire `Task` immediately. Your worker code dequeues and progresses the task.
- **`createTaskGetHandler({ storage })`** registers as `TASK_GET_METHOD` (`tasks/get`). It looks up the requested task across active and dead-letter storage and returns whatever it finds.
- **`createTaskListHandler({ storage })`** registers as `TASK_LIST_METHOD` (`tasks/list`). It returns tasks filtered by optional `state` / `contextId`, paginated with an opaque `cursor` and a `limit` clamped to `maxLimit` (default `100`). The response shape is `{ tasks, nextCursor? }`; `nextCursor` is omitted on the final page. Pagination is stable under concurrent inserts and deletes because the cursor is keyset-encoded on `(createdAt, id)`.

These handlers are pure adapters between the JSON-RPC surface and a `TaskStorage` - no business logic lives in them.

#### Task lifecycle

Tasks are managed by an explicit state machine. Use:

- `createTask(input)` to construct a new managed task
- `transitionTask(task, nextState, options?)` to move it forward (throws `TaskTransitionError` on invalid transitions; `options.message` attaches an agent reply to `status.message`)
- `canTransition(from, to)` to probe a transition without applying it
- `isTerminal(state)` / `isPaused(state)` for state-class predicates
- `toWireTask(task)` to convert from the internal `ManagedTask` to the wire-format `Task` returned over JSON-RPC
- The `TASK_STATE` const for the canonical state literals

#### `TaskStorage` and `InMemoryTaskStorage`

`TaskStorage` is a queue-centric interface where tasks live in one of three locations:

1. **Queue** - enqueued, waiting to be dequeued by a worker.
2. **Active** - enqueued or in-flight (after `dequeue`, before terminal).
3. **Dead letter** - terminal tasks (`COMPLETED` / `FAILED` / `CANCELLED`) retained for audit and lookup.

The included `InMemoryTaskStorage` is suitable for tests, local development, and single-instance deployments. Key methods:

- `enqueue(task)` / `dequeue(signal?)` - FIFO queue, with optional `AbortSignal` for cancellation
- `updateActive(task)` - persist a state transition without re-enqueueing
- `storeDeadLetter(task)` - move a terminal task out of the active map
- `getTask(id)` / `listTasks(filter?)` - read across active + dead-letter
- `getStats()` - snapshot of storage health (counts by state, queue length, etc.)
- `cleanupCompleted()`, `deleteContext(id)` - cleanup helpers

To plug in a different backend (Postgres, S3-backed, ...), implement `TaskStorage` and pass your implementation to the message-send and task-get handlers. A Redis-backed implementation ships out of the box - see below.

#### `RedisTaskStorage`

For multi-instance deployments that need a shared queue, the package also exports `RedisTaskStorage`, a `TaskStorage` implementation backed by Redis 6+ via [`ioredis`](https://github.com/redis/ioredis) (declared as an optional peer dependency - install it alongside the ADK to use this backend).

Because the `TaskStorage` interface is synchronous (`dequeue` aside), the Redis backend keeps an in-memory write-through mirror: sync reads serve from memory while writes update both memory and Redis, and the blocking `BRPOP` loop is the cross-instance shared-queue source of truth. Single-instance deployments get persistence across restarts (state is hydrated from Redis on `connect`); multi-instance deployments get a shared queue plus eventually-consistent state visibility across replicas.

```ts
import {
  RedisTaskStorage,
  redisConnectOptionsFromEnv,
} from '@inference-gateway/adk';

const storage = await RedisTaskStorage.connect(redisConnectOptionsFromEnv());
// ...wire `storage` into the same handlers as InMemoryTaskStorage
await storage.disconnect(); // on shutdown
```

Configuration is read from `REDIS_URL` (preferred) or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB`. Pass a `keyPrefix` to isolate multiple ADK deployments on a shared Redis (defaults to `"a2a:"` to match the Go ADK).

#### Writing a custom storage backend

`TaskStorage` is the contract. Anything that satisfies the interface drops into the built-in handlers. A skeleton implementation looks like:

```ts
import type {
  ManagedTask,
  PushNotificationConfig,
  StoredPushNotificationConfig,
  TaskListFilter,
  TaskStorage,
  TaskStorageStats,
} from '@inference-gateway/adk';

export class MyTaskStorage implements TaskStorage {
  enqueue(task: ManagedTask): void {
    /* push onto the FIFO queue + register as active */
  }
  dequeue(signal?: AbortSignal): Promise<ManagedTask> {
    /* await the head of the queue, abort on signal */
  }
  queueLength(): number {
    /* current FIFO length */
  }
  removeFromQueue(taskId: string): boolean {
    /* drop a PENDING task before it is picked up */
  }

  createActive(task: ManagedTask): void {
    /* register without enqueueing; throw if id is already active */
  }
  getActive(taskId: string): ManagedTask | undefined {
    /* look up an active task */
  }
  updateActive(task: ManagedTask): void {
    /* persist a state transition; throw if id is unknown */
  }
  storeDeadLetter(task: ManagedTask): void {
    /* move out of active and into dead-letter */
  }

  getTask(taskId: string): ManagedTask | undefined {
    /* read across active + dead-letter */
  }
  listTasks(filter?: TaskListFilter): ManagedTask[] {
    /* FIFO-ordered by createdAt, offset/limit pagination */
  }

  getContexts(): string[] {
    /* every context with at least one task */
  }
  deleteContext(contextId: string): number {
    /* cascade-delete queue + active + dead-letter; return count */
  }
  cleanupCompleted(): number {
    /* drop terminal dead-letter tasks; return count */
  }

  getStats(): TaskStorageStats {
    /* counts grouped by state, queue length, context stats */
  }

  setPushConfig(
    taskId: string,
    config: PushNotificationConfig
  ): StoredPushNotificationConfig {
    /* persist; mint UUID when caller omits config.id */
  }
  getPushConfig(
    taskId: string,
    configId: string
  ): StoredPushNotificationConfig | undefined {
    /* ... */
  }
  listPushConfigs(taskId: string): StoredPushNotificationConfig[] {
    /* fresh array, insertion order */
  }
  deletePushConfig(taskId: string, configId: string): boolean {
    /* return whether anything was removed */
  }
}
```

Three contract details that are easy to miss when porting from another stack:

1. **Enqueue registers the task as active.** A single `enqueue(task)` call must make the task visible to `getActive(task.id)` _and_ to `dequeue()`. The dequeued task stays active until the caller transitions it to a terminal state and calls `storeDeadLetter`.
2. **`dequeue` blocks.** When the queue is empty, return a `Promise` that resolves on the next `enqueue`. Multiple parked waiters must be handed off in FIFO arrival order. An aborted waiter must not consume the next enqueued task. The included `InMemoryTaskStorage` shows the pattern.
3. **`setPushConfig` assigns ids.** If the caller omits `config.id` (or passes an empty string), generate a UUID and populate it on the returned value. Callers that need the generated id read it from the return value.

Then verify against the conformance suite. The `@inference-gateway/adk/testing` subpath exports a `runTaskStorageConformance` factory that the in-memory backend runs against itself; any custom backend can run the same suite:

```ts
import { describe } from 'vitest';
import { runTaskStorageConformance } from '@inference-gateway/adk/testing';
import { MyTaskStorage } from './my-task-storage.js';

describe('MyTaskStorage - conformance', () => {
  runTaskStorageConformance({
    createStorage: () => new MyTaskStorage(),
    // Optional - close connections, flush state, etc.
    cleanup: (storage) => (storage as MyTaskStorage).close(),
  });
});
```

`createStorage` is called from `beforeEach`, so each test gets a fresh, empty storage. The factory may be async to allow opening a Redis or Postgres connection before returning. `vitest` is a peer dependency of the testing subpath - install it alongside `@inference-gateway/adk` to use the conformance suite.

Plug your backend into the built-in handlers exactly like the in-memory one:

```ts
const storage = new MyTaskStorage();
server.registerMethod(
  MESSAGE_SEND_METHOD,
  createMessageSendHandler({ storage })
);
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
```

#### `A2AClient` / `createA2AClient`

A typed client for calling A2A servers:

```ts
const client = createA2AClient({ baseURL: 'http://localhost:8080' });

const task = await client.sendMessage({ message });
const refresh = await client.getTask(task.id, { historyLength: 10 });
const card = await client.getAgentCard();
const health = await client.getHealth();
```

The client supports configurable per-attempt timeouts (`DEFAULT_TIMEOUT_MS`), exponential-backoff retries (`withRetry`, `DEFAULT_RETRY_CONFIG`, `isRetryableError`), custom headers, a pluggable `fetch` implementation, and a configurable `User-Agent`. Pass `retry: false` to disable retries entirely.

Errors are categorized for handling:

- `A2AHTTPError` - non-2xx HTTP response
- `A2AJSONRPCError` - JSON-RPC envelope `error` field
- `A2ATimeoutError` - per-attempt timeout fired
- `A2ANetworkError` - DNS / connection / unexpected fetch failure
- `A2AAbortError` - caller-supplied `signal` aborted

All extend `A2AClientError`.

#### AgentCard loading

```ts
import {
  loadAgentCardFromFile,
  loadAgentCardFromJSON,
} from '@inference-gateway/adk';

const card = loadAgentCardFromFile('./agent.json', {
  env: process.env,
  overrides: { url: 'https://prod.example.com' },
});
```

The loader runs a four-step pipeline:

1. Parse JSON.
2. Resolve `${VAR}` placeholders against `options.env` (defaults to `process.env`). **A missing env var throws `AgentCardLoadError`** rather than silently substituting an empty string.
3. Shallow-merge `options.overrides` over the resolved object (overrides win).
4. Validate the required-field subset (`name`, `description`, `version`, `protocolVersion`, `defaultInputModes`, `defaultOutputModes`, `capabilities`, `skills`) - throws `AgentCardValidationError` (with an optional `field` hint) on failure. Optional fields are deliberately left loose.

`loadAgentCardFromFile` is **synchronous by design** - it uses `readFileSync` and is meant for boot-time configuration. Do not call it on the request path.

#### CloudEvents v1.0 envelope

```ts
import {
  AGENT_EVENT_TYPE,
  createCloudEvent,
  DEFAULT_AGENT_EVENT_SOURCE,
} from '@inference-gateway/adk';

const evt = createCloudEvent({
  type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED,
  source: DEFAULT_AGENT_EVENT_SOURCE,
  data: { taskId, state: 'TASK_STATE_COMPLETED' },
});
```

`AGENT_EVENT_TYPE` is the canonical set of streaming event-type constants (`DELTA`, `ITERATION_COMPLETED`, `TOOL_STARTED`/`COMPLETED`/`FAILED`/`RESULT`, `INPUT_REQUIRED`, `TASK_STATUS_CHANGED`, `TASK_INTERRUPTED`, `STREAM_FAILED`) - identical to the Go ADK's `Event*` constants so a TS publisher and a Go consumer can interoperate without translation. Produces a [CloudEvents v1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)-compliant envelope (`CLOUDEVENTS_SPEC_VERSION = '1.0'`, served as `CLOUDEVENTS_CONTENT_TYPE`) - useful for forwarding agent events to event buses or webhook subscribers.

#### SSE streaming writer

`SSEStreamWriter` writes Server-Sent Events to a writable target, with a configurable heartbeat (`DEFAULT_SSE_HEARTBEAT_MS`) and the canonical SSE headers (`SSE_HEADERS`, `SSE_CONTENT_TYPE`). Useful for streaming task state transitions to long-lived HTTP clients.

### Configuration

Most of the ADK is configured **programmatically** - via `A2AServerConfig`, `A2AClientConfig`, the handler option objects (`MessageSendHandlerOptions`, `TaskGetHandlerOptions`), and `LoadAgentCardOptions`. The only environment variables the library itself reads are the three build-metadata variables, plus the `${VAR}` placeholders inside agent-card JSON.

#### Build-Time Agent Metadata

The ADK supports injecting agent `name` / `description` / `version` at build time, mirroring the Go ADK's `BuildAgentName` / `BuildAgentDescription` / `BuildAgentVersion` LD flags. Values are read from `process.env` **once at first import** and frozen into `buildMetadata`. An empty string means "not injected" - `applyBuildMetadata(card)` treats empty values as no-ops, so it is safe to call unconditionally.

| Variable                  | Default   | Description                                                            |
| ------------------------- | --------- | ---------------------------------------------------------------------- |
| `BUILD_AGENT_NAME`        | _(empty)_ | Overrides `card.name` when non-empty (read once at module load)        |
| `BUILD_AGENT_DESCRIPTION` | _(empty)_ | Overrides `card.description` when non-empty (read once at module load) |
| `BUILD_AGENT_VERSION`     | _(empty)_ | Overrides `card.version` when non-empty (read once at module load)     |

Two injection options:

- **Runtime** - set `BUILD_AGENT_NAME` (etc.) in the environment before the module is first imported.
- **Bundle-time** - use `tsup`'s `define` option to substitute at build time:

  ```ts
  // tsup.config.ts
  import { defineConfig } from 'tsup';

  export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    define: {
      'process.env.BUILD_AGENT_NAME': JSON.stringify('weather-assistant'),
      'process.env.BUILD_AGENT_VERSION': JSON.stringify('1.2.3'),
    },
  });
  ```

**Apply build metadata to a hand-written card:**

```ts
import {
  applyBuildMetadata,
  createA2AServer,
  type AgentCard,
} from '@inference-gateway/adk';

const baseCard: AgentCard = {
  name: 'placeholder',
  description: 'placeholder',
  version: '0.0.0',
  protocolVersion: '0.3.0',
  url: 'http://127.0.0.1:8080',
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  skills: [],
};

const card = applyBuildMetadata(baseCard);
const server = createA2AServer({ card });
```

See the [Container Image](#-container-image) section for containerized builds that wire these variables through.

#### Agent-card `${VAR}` placeholders

Inside an agent-card JSON file passed to `loadAgentCardFromFile` / `loadAgentCardFromJSON`, any string of the form `${SOME_ENV_VAR}` is resolved against `options.env` (defaulting to `process.env`) at load time. A missing variable throws `AgentCardLoadError` - there is no silent fallback. Example:

```json
{
  "name": "${A2A_AGENT_NAME}",
  "description": "Production agent in ${ENVIRONMENT}",
  "version": "0.1.0",
  "protocolVersion": "0.3.0",
  "url": "${A2A_AGENT_URL}",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "skills": []
}
```

For everything else - port, host, JSON-RPC path, agent-card cache-control, handler options, client retry / timeout / fetch - pass values directly to `createA2AServer`, `createA2AClient`, and the handler factories.

## 🔧 Advanced Usage

- **Custom JSON-RPC methods** - call `server.registerMethod(name, handler)` with any `MethodHandler` to extend the server beyond the built-in `message/send`, `tasks/get`, and `tasks/list`. The `MethodContext` passed to handlers carries the JSON-RPC request id and an `AbortSignal` tied to the HTTP connection.
- **Custom task handlers** - implement the `TaskHandler` (background) or `StreamableTaskHandler` (streaming) interface to ship arbitrary agent logic. See [Custom task handlers](#custom-task-handlers) below.
- **Custom storage backends** - implement the `TaskStorage` interface and pass your implementation into `createMessageSendHandler({ storage })`, `createTaskGetHandler({ storage })`, and `createTaskListHandler({ storage })`. Anything that satisfies the interface - Redis, Postgres, S3-backed - drops in.
- **Tuning client behavior** - `A2AClientConfig` exposes `timeoutMs`, `retry` (a partial `RetryConfig` or `false`), `headers`, `fetch`, `userAgent`, and overrides for `jsonRpcPath` / `agentCardPath` / `healthPath`. Call `withRetry` directly when you want to apply the same retry policy outside the client.
- **Bundle-time metadata injection** - use `tsup`'s `define` option to bake `BUILD_AGENT_NAME` / `_DESCRIPTION` / `_VERSION` into the bundled output instead of relying on the runtime environment. See [Build-Time Agent Metadata](#build-time-agent-metadata) above.
- **CloudEvents forwarding** - wrap your task-state transitions in `createCloudEvent` and POST them to a webhook or message bus for downstream subscribers, using the spec-compliant `CLOUDEVENTS_CONTENT_TYPE`.
- **TLS termination** - boot the server over HTTPS by passing `tls: { certPath, keyPath }` into `createA2AServer` (or `loadServerTLSConfigFromEnv()` to read the same paths from `TLS_ENABLE` / `TLS_CERT_PATH` / `TLS_KEY_PATH`). For mTLS, add `caPath` and `requestCert: true`. See [TLS](#tls) below.
- **Telemetry** - construct `createTelemetryProvider()` and call `start()` to wire OpenTelemetry traces, logs, and metrics. Metrics push over OTLP by default or expose a Prometheus pull endpoint - see [Telemetry & metrics exporters](#telemetry--metrics-exporters) below.

### Telemetry & metrics exporters

`createTelemetryProvider()` wires an OpenTelemetry `NodeSDK`. It is off until `TELEMETRY_ENABLE=true`; traces and logs always push over OTLP (`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_PROTOCOL`). Only the **metrics** signal is selectable, via the standard `OTEL_METRICS_EXPORTER` env var:

| `OTEL_METRICS_EXPORTER` | Metrics behavior |
| --- | --- |
| _(unset)_ or `otlp` | **Default.** Push over OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT` (unchanged from before). |
| `prometheus` | **Pull.** Start a Prometheus scrape endpoint at `/metrics` on `OTEL_EXPORTER_PROMETHEUS_HOST:OTEL_EXPORTER_PROMETHEUS_PORT` (default `0.0.0.0:9464`). |
| `none` | Disable the metrics signal entirely; traces and logs still export. |

Prometheus-pull env vars (only consulted when `OTEL_METRICS_EXPORTER=prometheus`):

| Env var | Default | Purpose |
| --- | --- | --- |
| `OTEL_EXPORTER_PROMETHEUS_HOST` | `0.0.0.0` | Bind host for the scrape endpoint. |
| `OTEL_EXPORTER_PROMETHEUS_PORT` | `9464` | Bind port for the scrape endpoint (`0` picks an ephemeral port). |

```ts
import { createTelemetryProvider } from '@inference-gateway/adk';

// With: TELEMETRY_ENABLE=true OTEL_METRICS_EXPORTER=prometheus
const telemetry = createTelemetryProvider();
telemetry.start(); // scrape endpoint live at http://0.0.0.0:9464/metrics
// ... wire into createA2AServer({ card, telemetry }), then on shutdown:
await telemetry.shutdown(); // stops the Prometheus HTTP server
```

This OpenTelemetry Prometheus endpoint (default port `9464`) is independent of the standalone `createMetricsServer` / `MetricsServer` (a `prom-client` server on default port `9090`) - the two serve different registries and can run side by side.

### TLS

#### Server: HTTPS termination

Pass a `tls` config to `createA2AServer` and the server listens over HTTPS instead of plaintext HTTP. The cert / key files are read synchronously during construction - a missing path fails fast with `TLSConfigError` before `listen()` is called.

```ts
import {
  createA2AServer,
  loadServerTLSConfigFromEnv,
  type AgentCard,
} from '@inference-gateway/adk';

const card: AgentCard = /* ... */;

const server = createA2AServer({
  card,
  tls: loadServerTLSConfigFromEnv(), // reads TLS_ENABLE / TLS_CERT_PATH / TLS_KEY_PATH
});

await server.listen(8443, '0.0.0.0');
```

`loadServerTLSConfigFromEnv()` returns `undefined` when `TLS_ENABLE` is falsy, so the same code drops back to plaintext for local dev without a branch in the caller. The recognized env vars are:

| Env var           |    Required     | Purpose                                                                |
| ----------------- | :-------------: | ---------------------------------------------------------------------- |
| `TLS_ENABLE`      | (master toggle) | Truthy: `true`, `1`, `yes`, `on`. Anything else returns `undefined`.   |
| `TLS_CERT_PATH`   |   ✓ (when on)   | Server certificate (PEM).                                              |
| `TLS_KEY_PATH`    |   ✓ (when on)   | Server private key (PEM).                                              |
| `TLS_CA_PATH`     |                 | CA bundle used to verify client certs (mTLS only).                     |
| `TLS_PASSPHRASE`  |                 | Passphrase unlocking the private key.                                  |
| `TLS_CLIENT_AUTH` |                 | When truthy, request + require a client cert. Pair with `TLS_CA_PATH`. |

For container deployments, mount cert / key files from a secrets backend rather than baking them into the image:

```sh
docker run --rm -p 8443:8443 \
  -v /etc/tls/cert.pem:/run/secrets/tls/cert.pem:ro \
  -v /etc/tls/key.pem:/run/secrets/tls/key.pem:ro \
  -e TLS_ENABLE=true \
  -e TLS_CERT_PATH=/run/secrets/tls/cert.pem \
  -e TLS_KEY_PATH=/run/secrets/tls/key.pem \
  my-agent:latest
```

The [`examples/tls-server/`](./examples/tls-server/) example ships a `generate-certs.sh` helper and a runnable end-to-end demo (server + client over HTTPS with a self-signed cert), plus a Kubernetes `Secret` + `volumeMount` recipe.

#### Client: outbound TLS for `A2AClient` and `OpenAICompatibleLLMClient`

Both clients accept a `tls?: ClientTLSConfig` field. Setting it routes outbound HTTPS through a `node:https.Agent` configured with the supplied cert / key / CA, so you can talk to a self-signed or private-CA-signed peer without disabling system trust.

```ts
import {
  createA2AClient,
  loadClientTLSConfigFromEnv,
} from '@inference-gateway/adk';

const client = createA2AClient({
  baseURL: 'https://peer-agent.internal:8443',
  tls: loadClientTLSConfigFromEnv() ?? {
    caPath: '/etc/internal-ca.pem',
  },
});
```

`ClientTLSConfig` fields:

- `caPath` - bundle to trust (for self-signed / private-CA peers)
- `certPath` + `keyPath` - client cert for mTLS (both must be set together)
- `passphrase` - unlocks an encrypted private key
- `insecureSkipVerify` - **dev only.** Disables cert verification; vulnerable to MITM. Use `caPath` in production.
- `servername` - override the SNI hostname

`tls` and `fetch` are mutually exclusive on both clients - passing both throws (`A2AClientError` / `LLMConfigurationError`). To layer your own fetch wrapper over TLS, build the inner fetch yourself via `createTLSFetch(config)` and pass it via `fetch`.

### Custom task handlers

`TaskHandler` and `StreamableTaskHandler` let you plug arbitrary agent logic into the server via `A2AServerBuilder`. Both mirror the [Go ADK's `server/task_handler.go`](https://github.com/inference-gateway/adk/blob/main/server/task_handler.go) interfaces; the TypeScript variant uses an `AbortSignal` on the context for cancellation instead of Go's `context.Context`.

```ts
import {
  A2AServerBuilder,
  AGENT_EVENT_TYPE,
  BaseStreamableTaskHandler,
  BaseTaskHandler,
  TASK_STATE,
  createCloudEvent,
  transitionTask,
  type AgentCard,
  type CloudEvent,
  type ManagedTask,
  type Message,
  type TaskHandlerContext,
} from '@inference-gateway/adk';

// Background handler - return the updated task once processing finishes.
class EchoTaskHandler extends BaseTaskHandler {
  async handleTask(
    _ctx: TaskHandlerContext,
    task: ManagedTask,
    _message: Message
  ): Promise<ManagedTask> {
    let next = task;
    if (next.state === TASK_STATE.PENDING) {
      next = transitionTask(next, TASK_STATE.IN_PROGRESS);
    }
    return transitionTask(next, TASK_STATE.COMPLETED);
  }
}

// Streaming handler - yield CloudEvents as the task progresses.
class EchoStreamHandler extends BaseStreamableTaskHandler {
  async *handleStreamingTask(
    ctx: TaskHandlerContext,
    task: ManagedTask,
    message: Message
  ): AsyncIterable<CloudEvent> {
    if (ctx.signal.aborted) return;
    yield createCloudEvent({
      type: AGENT_EVENT_TYPE.DELTA,
      subject: task.id,
      data: {
        messageId: crypto.randomUUID(),
        role: 'ROLE_AGENT',
        contextId: task.contextId,
        taskId: task.id,
        parts: [{ text: 'echo: ' + (message.parts[0]?.text ?? '') }],
      },
    });
  }
}

const card: AgentCard = /* ... */;

const server = new A2AServerBuilder({})
  .withAgentCard(card)
  .withTaskHandler(new EchoTaskHandler())
  // Or, for a streaming agent card (capabilities.streaming === true):
  // .withStreamableTaskHandler(new EchoStreamHandler())
  .build();

await server.listen(8080, '127.0.0.1');
```

Handler contracts:

- Both interfaces receive a `TaskHandlerContext` whose `signal` aborts when the originating request is cancelled (client disconnect, deadline, shutdown). Propagate it to LLM calls, tool dispatches, and fetches so cancellation actually unwinds.
- `TaskHandler.handleTask` returns the updated `ManagedTask`. Use `transitionTask` to advance the state machine; terminal states (`COMPLETED` / `FAILED` / `CANCELLED`) tell the worker the task is done.
- `StreamableTaskHandler.handleStreamingTask` yields raw CloudEvents that the framework forwards to the SSE response verbatim. The pipeline emits the initial `IN_PROGRESS` `task.status.changed` frame _before_ your handler runs and the terminal status frame _after_ it returns, so you only need to yield the in-flight payload events (`AGENT_EVENT_TYPE.DELTA`, `TOOL_*`, `ITERATION_COMPLETED`, etc.).
- `setAgent(agent)` is called by the builder when an `OpenAICompatibleAgent` has been registered via `withAgent(...)` (now or later). `BaseTaskHandler` / `BaseStreamableTaskHandler` give you free `setAgent` / `getAgent` accessors so concrete subclasses only need to implement the `handle*Task` method.

## 🌐 A2A Ecosystem

This ADK is the TypeScript implementation of the Agent-to-Agent (A2A) protocol within the Inference Gateway ecosystem.

### Related Projects

- **[Inference Gateway](https://github.com/inference-gateway/inference-gateway)** - Unified API gateway for AI providers
- **[Go ADK](https://github.com/inference-gateway/adk)** - Go A2A Development Kit (the most feature-complete sibling)
- **[Rust ADK](https://github.com/inference-gateway/rust-adk)** - Rust A2A Development Kit
- **[Go SDK](https://github.com/inference-gateway/go-sdk)** - Go client library for Inference Gateway
- **[TypeScript SDK](https://github.com/inference-gateway/typescript-sdk)** - TypeScript/JavaScript client library
- **[Python SDK](https://github.com/inference-gateway/python-sdk)** - Python client library
- **[Rust SDK](https://github.com/inference-gateway/rust-sdk)** - Rust client library
- **[Schemas](https://github.com/inference-gateway/schemas)** - Canonical A2A JSON Schemas (source of truth for generated types)

### A2A Agents

- **[Awesome A2A](https://github.com/inference-gateway/awesome-a2a)** - Curated list of A2A-compatible agents
- **[Browser Agent](https://github.com/inference-gateway/browser-agent)** - Web browser automation and interaction agent
- **[Documentation Agent](https://github.com/inference-gateway/documentation-agent)** - Documentation generation and management agent
- **[Google Calendar Agent](https://github.com/inference-gateway/google-calendar-agent)** - Google Calendar integration agent
- **[n8n Agent](https://github.com/inference-gateway/n8n-agent)** - n8n workflow automation integration agent

## 📋 Requirements

- **Node.js**: 24 LTS or later
- **pnpm**: 10.0 or later (10.18.0 is pinned via `package.json#packageManager`)
- **Dependencies**: see [`package.json`](./package.json) - runtime depends only on `hono` and `@hono/node-server`

## 📦 Container Image

A minimal multi-stage `Dockerfile` that produces an [OCI-compliant](https://opencontainers.org/) container image for a TypeScript A2A agent built on top of this ADK. The same `Dockerfile` works with `docker build`, `podman build`, `buildah`, `kaniko`, or any other OCI-compatible build tool - there's nothing Docker-specific in it. Build-time agent metadata is injected via `ARG` → `ENV`, which the ADK reads on first import:

```dockerfile
# --- Builder ---
FROM node:24-alpine AS builder

ARG AGENT_NAME="My A2A Agent"
ARG AGENT_DESCRIPTION="A custom A2A agent built with the TypeScript ADK"
ARG AGENT_VERSION="0.1.0"

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.18.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
ENV BUILD_AGENT_NAME=${AGENT_NAME} \
    BUILD_AGENT_DESCRIPTION=${AGENT_DESCRIPTION} \
    BUILD_AGENT_VERSION=${AGENT_VERSION}
RUN pnpm build

# --- Runtime ---
FROM node:24-alpine

ARG AGENT_NAME
ARG AGENT_DESCRIPTION
ARG AGENT_VERSION

RUN addgroup -g 1001 -S a2a && adduser -u 1001 -S agent -G a2a
WORKDIR /home/agent
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN chown -R agent:a2a /home/agent
USER agent

ENV BUILD_AGENT_NAME=${AGENT_NAME} \
    BUILD_AGENT_DESCRIPTION=${AGENT_DESCRIPTION} \
    BUILD_AGENT_VERSION=${AGENT_VERSION}

CMD ["node", "dist/index.js"]
```

**Build with custom metadata** - `docker build`, `podman build`, etc. all take the same flags:

```sh
docker build \
  --build-arg AGENT_NAME="Weather Assistant" \
  --build-arg AGENT_DESCRIPTION="AI-powered weather forecasting agent" \
  --build-arg AGENT_VERSION="0.1.1" \
  -t my-a2a-agent .
```

## 📄 License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

## 🤝 Contributing

Contributions are welcome - whether you're fixing bugs, adding features, improving documentation, or helping bring more of the [Go ADK](https://github.com/inference-gateway/adk) feature surface to TypeScript.

**Please see the [Contributing Guide](./CONTRIBUTING.md) for:**

- 🚀 **Getting Started** - Prerequisites, Flox/manual dev environment setup
- 📋 **Development Workflow** - pnpm scripts, regenerating A2A types, the inner loop
- 🎯 **Coding Guidelines** - TypeScript strictness flags, style, and comment conventions
- 🛠️ **Making Changes** - Branch naming and Conventional Commit format
- 🧪 **Testing Guidelines** - Vitest layout, running a single test, the drift check
- 🔄 **Continuous Integration** - CI matrix and required status checks
- 🚢 **Releases** - How semantic-release computes the next version
- 🔄 **Pull Request Process** - Pre-submit checklist and review flow

**Quick start for contributors:**

```sh
# Fork the repo on GitHub, then:
git clone https://github.com/your-username/typescript-adk.git
cd typescript-adk
pnpm install
pnpm test
```

For questions or help getting started, please [open a discussion](https://github.com/inference-gateway/typescript-adk/discussions) or [file an issue](https://github.com/inference-gateway/typescript-adk/issues).

## 📞 Support

### Issues & Questions

- **Bug Reports**: [GitHub Issues](https://github.com/inference-gateway/typescript-adk/issues)
- **Documentation**: [Official Docs](https://docs.inference-gateway.com)

## 🔗 Resources

### Documentation

- [A2A Protocol Specification](https://github.com/inference-gateway/schemas/tree/main/a2a)
- [API Documentation](https://docs.inference-gateway.com/a2a)

---

<p align="center">
  <a href="https://github.com/inference-gateway">GitHub</a> •
  <a href="https://docs.inference-gateway.com">Documentation</a>
</p>
