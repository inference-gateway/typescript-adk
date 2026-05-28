# Artifacts: with `A2AServerBuilder` default handlers

End-to-end example combining [`A2AServerBuilder.withDefaultStreamingTaskHandler()`](../../src/server/server-builder.ts) with a **custom artifact-attaching background handler** that calls [`DefaultArtifactService.createFileArtifact(...)`](../../src/artifacts/default-artifact-service.ts) on every `message/send` request. The default streaming stub is left in place so the same server still answers `message/stream`.

Mirrors the Go ADK's [`examples/artifacts-with-default-handlers/`](https://github.com/inference-gateway/adk/tree/main/examples/artifacts-with-default-handlers).

## What this example shows

- The builder one-liner for setting up the protocol-level methods (`message/send`, `message/stream`, `tasks/cancel`, `tasks/resubscribe`).
- Mixing a builder-installed **default** streaming stub with a builder-installed **custom** background handler — `withBackgroundTaskHandler(custom)` overrides the analogous stub while leaving the streaming stub alone.
- Wiring an [`ArtifactService`](../../src/artifacts/artifact-service.ts) into the builder via [`withArtifactService`](../../src/server/server-builder.ts) for symmetry with the Go ADK.
- Using [`InMemoryArtifactStorage`](../../src/artifacts/in-memory-storage.ts) so the example needs no docker/disk setup.

## What "default handlers" means here

`A2AServerBuilder.withDefaultStreamingTaskHandler()` installs a **deliberately minimal** streaming stub: it emits exactly one `task.status.changed(state=COMPLETED, final=true)` SSE frame and closes. No artifact attachment, no LLM logic.

Its background counterpart `withDefaultBackgroundTaskHandler()` is the same idea (transition PENDING → IN_PROGRESS → COMPLETED, no other side effects). **This example replaces the background stub** with a custom handler that:

1. Transitions the task to `IN_PROGRESS`.
2. Reads the latest user-message text.
3. Persists it via `artifactService.createFileArtifact(...)`.
4. Attaches the resulting `Artifact` to `task.artifacts`.
5. Appends an agent reply and transitions to `COMPLETED`.

The streaming stub is left untouched, so `message/stream` still answers with the canonical single-frame default-handler behavior — see [`examples/default-handlers/`](../default-handlers/) for what that frame looks like.

## Layout

```text
examples/artifacts-with-default-handlers/
├── README.md
├── client.ts        # message/send (poll) + message/stream (SSE) in one run
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2AServerBuilder + custom artifact-attaching background handler
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-with-default-handlers start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-with-default-handlers start:client
```

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                                                                             | Description                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_NAME`        | `artifacts-with-default-handlers-agent`                                                                             | Agent card `name`.                                                                                                                           |
| `A2A_AGENT_DESCRIPTION` | (see source)                                                                                                        | Agent card `description`.                                                                                                                    |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                                                                             | Agent card `version`.                                                                                                                        |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                                                                                         | Listen host.                                                                                                                                 |
| `A2A_SERVER_PORT`       | `8080`                                                                                                              | Listen port.                                                                                                                                 |
| `ARTIFACTS_BASE_URL`    | `memory://artifacts`                                                                                                | Base URL emitted in `FilePart.fileWithUri`. Defaults to a non-HTTP scheme since the bytes live in-memory and are not externally fetchable.    |

Client (`client.ts`):

| Env var         | Default                                                                                | Description                                |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `SERVER_URL`    | `http://127.0.0.1:8080`                                                                | Base URL of the A2A server.                |
| `SEND_PROMPT`   | `Hello via message/send - please persist this note as an artifact.`                    | Text written into the persisted artifact. |
| `STREAM_PROMPT` | `Hello via message/stream - please show me the streaming default handler stub.`        | Text sent on the `message/stream` request. |

## Expected flow

`message/send` path (custom background handler):

1. Client sends `message/send`.
2. Server creates a `PENDING` task, enqueues it, replies with the wire-format task.
3. Worker dequeues, runs the custom background handler.
4. The handler calls `artifactService.createFileArtifact(...)` to persist the user text under a server-minted artifact id. The bytes land in the in-memory store; the `Artifact` carries a `FilePart` with `fileWithUri` set to `${ARTIFACTS_BASE_URL}/<artifactId>/<filename>`.
5. Handler attaches the artifact to `task.artifacts`, appends an agent reply, transitions to `TASK_STATE_COMPLETED`.
6. Client polls `tasks/get`, observes the terminal task with `artifacts.length === 1`, and prints the URI.

`message/stream` path (default streaming stub):

1. Client opens an SSE connection via `message/stream`.
2. Server runs the builder-installed streaming default — emits a single `task.status.changed(state=COMPLETED, final=true)` CloudEvent and closes.
3. Client reads frames until EOF.

## Where artifacts land

In memory — see [`InMemoryArtifactStorage`](../../src/artifacts/in-memory-storage.ts). The bytes are held by reference inside the server process and disappear on restart. To stream them out over HTTP, swap the storage for [`FilesystemArtifactStorage`](../../src/artifacts/filesystem-storage.ts) or [`MinioArtifactStorage`](../../src/artifacts/minio-storage.ts) and use the lower-level `createA2AServer({ card, artifactStorage })` instead of the builder — see [`examples/artifacts-filesystem/`](../artifacts-filesystem/) for that pattern.

> **Builder limitation:** the TS `A2AServerBuilder` does not currently propagate the configured `ArtifactService` (or any artifact-storage handle) to the HTTP `/artifacts/:artifactId/:filename` route. `withArtifactService(...)` only registers the service with the builder for future handler use; the route remains unmounted. For a fully end-to-end download flow, use one of the two storage-specific examples above. This example focuses on the **handler-side** wiring.

## Related examples

- [`examples/default-handlers/`](../default-handlers/) — `A2AServerBuilder.withDefaultTaskHandlers()` without artifacts. Shows the canonical message/send + message/stream stub behavior.
- [`examples/artifacts-filesystem/`](../artifacts-filesystem/) — filesystem-backed artifact storage with a working `/artifacts` download endpoint.
- [`examples/artifacts-minio/`](../artifacts-minio/) — MinIO/S3-backed artifact storage with presigned URLs.
- [`examples/artifacts-autonomous-tool/`](../artifacts-autonomous-tool/) — LLM-driven artifact creation via the reserved `create_artifact` tool.
