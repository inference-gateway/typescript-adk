# Artifacts: Filesystem

End-to-end example wiring the [`FilesystemArtifactStorage`](../../src/artifacts/filesystem-storage.ts) provider into an A2A server. Each incoming `message/send` request is turned into a text artifact persisted on disk, and the server's built-in `/artifacts/:artifactId/:filename` endpoint streams the bytes back to clients.

Mirrors the Go ADK's [`examples/artifacts-filesystem/`](https://github.com/inference-gateway/adk/tree/main/examples/artifacts-filesystem).

## What this example shows

- Wiring a custom artifact storage backend into an A2A server with [`createA2AServer({ card, artifactStorage })`](../../src/server/server.ts) — the server auto-mounts `GET /artifacts/:artifactId/:filename` via [`registerArtifactsRoute`](../../src/server/artifacts-route.ts) when an `artifactStorage` is supplied.
- Constructing [`DefaultArtifactService`](../../src/artifacts/default-artifact-service.ts) on top of `FilesystemArtifactStorage` and calling `createFileArtifact` from inside a custom worker.
- Composing the resulting `Artifact` onto `task.artifacts` and surfacing the download URL in the agent's reply.

## Layout

```text
examples/artifacts-filesystem/
├── README.md
├── client.ts        # sendMessage + poll tasks/get + download the artifact
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # createA2AServer + FilesystemArtifactStorage + worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-filesystem start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-filesystem start:client
```

`pnpm --filter @inference-gateway/adk-example-artifacts-filesystem start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                  | Description                                                                                                                        |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_NAME`        | `artifacts-filesystem-agent`                             | Agent card `name`.                                                                                                                 |
| `A2A_AGENT_DESCRIPTION` | (see source)                                             | Agent card `description`.                                                                                                          |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                  | Agent card `version`.                                                                                                              |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                              | Listen host.                                                                                                                       |
| `A2A_SERVER_PORT`       | `8080`                                                   | Listen port.                                                                                                                       |
| `ARTIFACTS_ROOT`        | `<os.tmpdir>/adk-artifacts-filesystem`                   | Root directory on disk under which artifact files and their sidecars are written. Created lazily on first write with mode `0o700`. |
| `ARTIFACTS_BASE_URL`    | `http://${A2A_SERVER_HOST}:${A2A_SERVER_PORT}/artifacts` | Base URL emitted in `FilePart.fileWithUri`. Defaults to point at this server's built-in `/artifacts` endpoint.                     |

Client (`client.ts`):

| Env var      | Default                                                                         | Description                               |
| ------------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                         | Base URL of the A2A server.               |
| `PROMPT`     | `Hello from the filesystem artifacts example - please write this note to disk.` | Text written into the persisted artifact. |

## Expected flow

1. Client sends a `message/send` JSON-RPC request.
2. Server creates a `PENDING` task, enqueues it, and replies with the wire-format task.
3. Worker dequeues the task, calls `artifactService.createFileArtifact(...)` to write the user text to `${ARTIFACTS_ROOT}/<artifactId>/note-<task-prefix>.txt`, and produces a sidecar `note-<task-prefix>.txt.adk-meta.json` next to it.
4. Worker composes the artifact onto `task.artifacts`, appends an agent reply with the download URL, and stores the now-`TASK_STATE_COMPLETED` task into the dead-letter mirror.
5. Client polls `tasks/get`, observes the terminal task, extracts `task.artifacts[].parts[].file.fileWithUri`, and downloads each URL through the server's `/artifacts` endpoint.

## Where artifacts land

```text
${ARTIFACTS_ROOT}/
└── <artifactId>/
    ├── note-<task-prefix>.txt              # payload, mode 0o600
    └── note-<task-prefix>.txt.adk-meta.json # sidecar (contentType + uploadedAt), mode 0o600
```

The directory is created with mode `0o700` (owner only). See [`FilesystemArtifactStorage`](../../src/artifacts/filesystem-storage.ts) for the full layout and security model.

## Inspecting the on-disk state

```sh
ls -la "${ARTIFACTS_ROOT:-/tmp/adk-artifacts-filesystem}"
find "${ARTIFACTS_ROOT:-/tmp/adk-artifacts-filesystem}" -type f
cat "${ARTIFACTS_ROOT:-/tmp/adk-artifacts-filesystem}"/*/*.adk-meta.json | jq
```

## Cleanup

The example does not auto-clean artifacts on shutdown — they survive process restarts so you can re-fetch them by URL. To wipe state manually:

```sh
rm -rf "${ARTIFACTS_ROOT:-/tmp/adk-artifacts-filesystem}"
```

For programmatic cleanup, call `artifactService.cleanupExpired(maxAgeMs)` or `artifactService.cleanupOldest(maxCount)` — both delegate to the underlying provider.

## Related examples

- [`examples/artifacts-minio/`](../artifacts-minio/) — same shape, but bytes go to S3/MinIO with presigned URLs.
- [`examples/artifacts-autonomous-tool/`](../artifacts-autonomous-tool/) — let the LLM create artifacts itself via the reserved `create_artifact` tool.
- [`examples/artifacts-with-default-handlers/`](../artifacts-with-default-handlers/) — `A2AServerBuilder.withDefaultTaskHandlers()` combined with an artifact-injecting custom handler.
