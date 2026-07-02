# Artifacts: MinIO / S3

End-to-end example wiring the [`MinioArtifactStorage`](../../src/artifacts/minio-storage.ts) provider into an A2A server. Each `message/send` request is persisted as an object in a MinIO bucket; clients receive a presigned URL (in `direct` mode) or a stable proxy URL backed by the ADK server (in `proxy` mode).

Ships a `docker-compose.yml` that runs a local MinIO and auto-creates the `artifacts` bucket.

Mirrors the Go ADK's [`examples/artifacts-minio/`](https://github.com/inference-gateway/adk/tree/main/examples/artifacts-minio).

## What this example shows

- Wiring [`MinioArtifactStorage`](../../src/artifacts/minio-storage.ts) (S3-compatible) into the ADK against MinIO running locally on `:9000`.
- The two `mode` choices and what they imply for client downloads:
  - **`direct`** — `store()` returns a short-lived presigned GET URL. Clients fetch from MinIO directly; the ADK's `/artifacts` route is unused.
  - **`proxy`** — `store()` returns a stable URL under the ADK's `/artifacts` route. The ADK streams bytes through `MinioArtifactStorage.retrieve()` on demand. Useful when the bucket is private and clients cannot talk to S3.
- Standing up MinIO with the bundled `docker-compose.yml` (with bucket auto-creation via the `mc` sidecar).

## Layout

```text
examples/artifacts-minio/
├── README.md
├── .env.example         # copy to .env to override defaults
├── client.ts            # sendMessage + poll tasks/get + download the artifact
├── docker-compose.yml   # MinIO + mc bootstrap (auto-creates the bucket)
├── package.json         # workspace package, depends on @inference-gateway/adk + @aws-sdk/client-s3
├── server.ts            # createA2AServer + MinioArtifactStorage + worker
└── tsconfig.json
```

## Running it

You need Docker (or a reachable MinIO/S3 endpoint) to run this example. From the repo root:

```sh
pnpm install
```

Start MinIO and create the `artifacts` bucket:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-minio minio:up
```

The MinIO console is at <http://127.0.0.1:9001> (`minioadmin` / `minioadmin`).

Start the server (in one terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-minio start:server
```

Run the client (in another terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-minio start:client
```

When you are done, tear down MinIO **and** its volume:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-minio minio:down
```

### Configuration

Server (`server.ts`):

| Env var                    | Default                                                  | Description                                                                                                                                        |
| -------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MINIO_ENDPOINT`           | `http://127.0.0.1:9000`                                  | MinIO/S3 endpoint URL. Omit for native AWS S3 (the SDK resolves the regional endpoint).                                                            |
| `MINIO_REGION`             | `us-east-1`                                              | AWS region passed to the SDK. MinIO ignores it; the SDK requires it.                                                                               |
| `MINIO_ACCESS_KEY`         | `minioadmin`                                             | Access key. Matches the default `MINIO_ROOT_USER` in the bundled compose.                                                                          |
| `MINIO_SECRET_KEY`         | `minioadmin`                                             | Secret key.                                                                                                                                        |
| `MINIO_BUCKET`             | `artifacts`                                              | Target bucket. Must already exist — the storage does not auto-create it (the `mc` sidecar in the compose does).                                    |
| `ARTIFACTS_MODE`           | `direct`                                                 | URL emission mode. `direct` → short-lived presigned GET URL. `proxy` → stable URL through the ADK server's `/artifacts` route.                     |
| `ARTIFACTS_BASE_URL`       | `http://${A2A_SERVER_HOST}:${A2A_SERVER_PORT}/artifacts` | Base URL emitted when `ARTIFACTS_MODE=proxy`. In `direct` mode, the presigned URL points at MinIO directly and this value is unused for downloads. |
| `ARTIFACTS_PRESIGN_EXPIRY` | `300`                                                    | Lifetime in seconds for presigned URLs in `direct` mode.                                                                                           |
| `A2A_AGENT_NAME`           | `artifacts-minio-agent`                                  | Agent card `name`.                                                                                                                                 |
| `A2A_AGENT_DESCRIPTION`    | (see source)                                             | Agent card `description`.                                                                                                                          |
| `A2A_AGENT_VERSION`        | `0.0.0`                                                  | Agent card `version`.                                                                                                                              |
| `A2A_SERVER_HOST`          | `127.0.0.1`                                              | Listen host.                                                                                                                                       |
| `A2A_SERVER_PORT`          | `8080`                                                   | Listen port.                                                                                                                                       |

Client (`client.ts`):

| Env var      | Default                                                                          | Description                               |
| ------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                          | Base URL of the A2A server.               |
| `PROMPT`     | `Hello from the MinIO artifacts example - please write this note to the bucket.` | Text written into the persisted artifact. |

## Expected flow

1. Client sends a `message/send` JSON-RPC request.
2. Server creates a `PENDING` task, enqueues it, replies with the wire-format task.
3. Worker dequeues, calls `artifactService.createFileArtifact(...)`, which `PUT`s the object into `s3://${MINIO_BUCKET}/${artifactId}/${filename}` with `x-amz-meta-uploaded-at` set.
4. In `direct` mode, the artifact's `FilePart.fileWithUri` is a presigned `GET` URL (default lifetime: 5 minutes). In `proxy` mode, it is `${ARTIFACTS_BASE_URL}/${artifactId}/${filename}`, served by the ADK server's `/artifacts` route.
5. Worker composes the artifact onto `task.artifacts`, replies with the download URL, marks the task `TASK_STATE_COMPLETED`.
6. Client polls `tasks/get`, extracts `fileWithUri`, and downloads the bytes.

## Where artifacts land

In the MinIO bucket:

```text
s3://${MINIO_BUCKET}/<artifactId>/<filename>
   - ContentType:        text/plain (inferred from `.txt`)
   - x-amz-meta-uploaded-at: ISO timestamp from MinioArtifactStorage.now()
```

To list bucket contents from inside the running MinIO container:

```sh
docker exec adk-artifacts-minio-mc mc ls --recursive local/artifacts
```

Or download a file directly:

```sh
docker exec adk-artifacts-minio-mc mc cat local/artifacts/<artifactId>/<filename>
```

## `direct` vs `proxy` — side by side

|                           | `direct`                                                                                                                                      | `proxy`                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| URL returned by `store()` | Short-lived presigned GET URL pointing at MinIO. Default lifetime: 5 minutes (`ARTIFACTS_PRESIGN_EXPIRY`).                                    | Stable URL pointing at the ADK server's `/artifacts/:artifactId/:filename` route.                                                  |
| Where bytes come from     | Directly from MinIO. The ADK server is uninvolved.                                                                                            | From the ADK server, which streams them through `MinioArtifactStorage.retrieve()`.                                                 |
| Auth model                | The presigned URL embeds short-lived credentials; anyone holding the URL can fetch during its lifetime. Suitable for browser-style downloads. | Add ADK middleware (e.g. via `withAuthenticator`) to the `/artifacts` route to gate downloads. The bucket itself can stay private. |
| When to choose            | Clients can reach MinIO directly and the bucket either is or can be configured to serve presigned URLs.                                       | Bucket is private, clients only speak to the ADK, or you want to apply ADK-side authentication/observability to downloads.         |

## Cleanup

Artifacts persist in MinIO across server restarts — re-fetch them later by URL. To wipe everything:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-minio minio:down
```

For programmatic cleanup, call `artifactService.cleanupExpired(maxAgeMs)` or `artifactService.cleanupOldest(maxCount)`.

## Related examples

- [`examples/artifacts-filesystem/`](../artifacts-filesystem/) — same shape, but bytes go to local disk.
- [`examples/artifacts-autonomous-tool/`](../artifacts-autonomous-tool/) — let the LLM create artifacts itself via the reserved `create_artifact` tool.
- [`examples/artifacts-with-default-handlers/`](../artifacts-with-default-handlers/) — `A2AServerBuilder.withDefaultTaskHandlers()` combined with an artifact-injecting custom handler.
