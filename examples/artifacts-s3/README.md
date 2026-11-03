# Artifacts: S3 (RustFS)

End-to-end example wiring the [`S3ArtifactStorage`](../../src/artifacts/s3-storage.ts) provider into an A2A server. Each `SendMessage` request is persisted as an object in an S3-compatible bucket; clients receive a presigned URL (in `direct` mode) or a stable proxy URL backed by the ADK server (in `proxy` mode).

Ships a `docker-compose.yml` that runs [RustFS](https://github.com/rustfs/rustfs), an actively maintained S3-compatible object store. The storage creates the `artifacts` bucket itself when it is missing, so there is no init container; any other S3-compatible store works by pointing `S3_ENDPOINT` at it.

Mirrors the Go ADK's [`examples/artifacts-s3/`](https://github.com/inference-gateway/adk/tree/main/examples/artifacts-s3).

## What this example shows

- Wiring [`S3ArtifactStorage`](../../src/artifacts/s3-storage.ts) (S3-compatible) into the ADK against RustFS running locally on `:9000`.
- The two `mode` choices and what they imply for client downloads:
  - **`direct`** - `store()` returns a short-lived presigned GET URL. Clients fetch from RustFS directly; the ADK's `/artifacts` route is unused.
  - **`proxy`** - `store()` returns a stable URL under the ADK's `/artifacts` route. The ADK streams bytes through `S3ArtifactStorage.retrieve()` on demand. Useful when the bucket is private and clients cannot talk to S3.
- Standing up RustFS with the bundled `docker-compose.yml` (bucket auto-created by the storage, no init container).

## Layout

```text
examples/artifacts-s3/
├── README.md
├── .env.example         # copy to .env to override defaults
├── client.ts            # sendMessage + poll GetTask + download the artifact
├── docker-compose.yml   # RustFS object store (bucket created by the storage)
├── package.json         # workspace package, depends on @inference-gateway/adk + @aws-sdk/client-s3
├── server.ts            # createA2AServer + S3ArtifactStorage + worker
└── tsconfig.json
```

## Running it

You need Docker (or a reachable S3 endpoint) to run this example. From the repo root:

```sh
pnpm install
```

Start RustFS:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-s3 s3:up
```

The RustFS web console is at <http://127.0.0.1:9001> (`rustfsadmin` / `rustfsadmin`).

Start the server (in one terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-s3 start:server
```

Run the client (in another terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-s3 start:client
```

When you are done, tear down RustFS **and** its volume:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-s3 s3:down
```

### Configuration

Server (`server.ts`):

| Env var                    | Default                                                  | Description                                                                                                                                         |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`              | `http://127.0.0.1:9000`                                  | S3 endpoint URL. Omit for native AWS S3 (the SDK resolves the regional endpoint).                                                                   |
| `S3_REGION`                | `us-east-1`                                              | AWS region passed to the SDK. RustFS ignores it; the SDK requires it.                                                                               |
| `S3_ACCESS_KEY`            | `rustfsadmin`                                            | Access key. Matches `RUSTFS_ACCESS_KEY` in the bundled compose.                                                                                     |
| `S3_SECRET_KEY`            | `rustfsadmin`                                            | Secret key. Matches `RUSTFS_SECRET_KEY` in the bundled compose.                                                                                     |
| `S3_BUCKET`                | `artifacts`                                              | Target bucket. Created automatically by the storage when missing.                                                                                   |
| `ARTIFACTS_MODE`           | `direct`                                                 | URL emission mode. `direct` → short-lived presigned GET URL. `proxy` → stable URL through the ADK server's `/artifacts` route.                      |
| `ARTIFACTS_BASE_URL`       | `http://${A2A_SERVER_HOST}:${A2A_SERVER_PORT}/artifacts` | Base URL emitted when `ARTIFACTS_MODE=proxy`. In `direct` mode, the presigned URL points at RustFS directly and this value is unused for downloads. |
| `ARTIFACTS_PRESIGN_EXPIRY` | `300`                                                    | Lifetime in seconds for presigned URLs in `direct` mode.                                                                                            |
| `A2A_AGENT_NAME`           | `artifacts-s3-agent`                                     | Agent card `name`.                                                                                                                                  |
| `A2A_AGENT_DESCRIPTION`    | (see source)                                             | Agent card `description`.                                                                                                                           |
| `A2A_AGENT_VERSION`        | `0.0.0`                                                  | Agent card `version`.                                                                                                                               |
| `A2A_SERVER_HOST`          | `127.0.0.1`                                              | Listen host.                                                                                                                                        |
| `A2A_SERVER_PORT`          | `8080`                                                   | Listen port.                                                                                                                                        |

Client (`client.ts`):

| Env var      | Default                                                                           | Description                               |
| ------------ | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                           | Base URL of the A2A server.               |
| `PROMPT`     | `Hello from the RustFS artifacts example - please write this note to the bucket.` | Text written into the persisted artifact. |

## Expected flow

1. Client sends a `SendMessage` JSON-RPC request.
2. Server creates a `PENDING` task, enqueues it, replies with the wire-format task.
3. Worker dequeues, calls `artifactService.createFileArtifact(...)`, which `PUT`s the object into `s3://${S3_BUCKET}/${artifactId}/${filename}` with `x-amz-meta-uploaded-at` set.
4. In `direct` mode, the artifact's part's `url` is a presigned `GET` URL (default lifetime: 5 minutes). In `proxy` mode, it is `${ARTIFACTS_BASE_URL}/${artifactId}/${filename}`, served by the ADK server's `/artifacts` route.
5. Worker composes the artifact onto `task.artifacts`, replies with the download URL, marks the task `TASK_STATE_COMPLETED`.
6. Client polls `GetTask`, extracts the part's `url`, and downloads the bytes.

## Where artifacts land

In the RustFS bucket:

```text
s3://${S3_BUCKET}/<artifactId>/<filename>
   - ContentType:        text/plain (inferred from `.txt`)
   - x-amz-meta-uploaded-at: ISO timestamp from S3ArtifactStorage.now()
```

Browse the bucket in the RustFS web console at <http://127.0.0.1:9001> under `artifacts`.

## `direct` vs `proxy` - side by side

|                           | `direct`                                                                                                                                      | `proxy`                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| URL returned by `store()` | Short-lived presigned GET URL pointing at RustFS. Default lifetime: 5 minutes (`ARTIFACTS_PRESIGN_EXPIRY`).                                   | Stable URL pointing at the ADK server's `/artifacts/:artifactId/:filename` route.                                                  |
| Where bytes come from     | Directly from RustFS. The ADK server is uninvolved.                                                                                           | From the ADK server, which streams them through `S3ArtifactStorage.retrieve()`.                                                    |
| Auth model                | The presigned URL embeds short-lived credentials; anyone holding the URL can fetch during its lifetime. Suitable for browser-style downloads. | Add ADK middleware (e.g. via `withAuthenticator`) to the `/artifacts` route to gate downloads. The bucket itself can stay private. |
| When to choose            | Clients can reach RustFS directly (presigned URLs need no bucket policy).                                                                     | Bucket is private, clients only speak to the ADK, or you want to apply ADK-side authentication/observability to downloads.         |

## Cleanup

Artifacts persist in RustFS across server restarts - re-fetch them later by URL. To wipe everything:

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-s3 s3:down
```

For programmatic cleanup, call `artifactService.cleanupExpired(maxAgeMs)` to drop artifacts older than `maxAgeMs`, or `artifactService.cleanupOldest(maxCount)` to keep only the `maxCount` most-recent artifacts (deleting every file of the older ones; `0` or less means unlimited, a no-op).

## Related examples

- [`examples/artifacts-filesystem/`](../artifacts-filesystem/) - same shape, but bytes go to local disk.
- [`examples/artifacts-autonomous-tool/`](../artifacts-autonomous-tool/) - let the LLM create artifacts itself via the reserved `create_artifact` tool.
- [`examples/artifacts-with-default-handlers/`](../artifacts-with-default-handlers/) - `A2AServerBuilder.withDefaultTaskHandlers()` combined with an artifact-injecting custom handler.
