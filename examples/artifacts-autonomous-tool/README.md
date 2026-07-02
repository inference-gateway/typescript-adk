# Artifacts: Autonomous `create_artifact` tool

End-to-end example of an LLM-driven A2A agent that uses the **reserved `create_artifact` tool** to surface generated content as downloadable artifacts. The LLM decides when to call the tool; the ADK's `DefaultBackgroundTaskHandler` intercepts the call, persists the bytes via [`DefaultArtifactService`](../../src/artifacts/default-artifact-service.ts) on top of [`FilesystemArtifactStorage`](../../src/artifacts/filesystem-storage.ts), and attaches the resulting `Artifact` to `task.artifacts` when the loop terminates.

Mirrors the Go ADK's [`examples/artifacts-autonomous-tool/`](https://github.com/inference-gateway/adk/tree/main/examples/artifacts-autonomous-tool).

## What this example shows

- Opting into the reserved `create_artifact` tool with [`new DefaultToolBox({ enableCreateArtifact: true, artifactService })`](../../src/server/toolbox.ts) — the toolbox pre-registers a tool definition the LLM can call; the handler dispatches it through [`createCreateArtifactExecutor`](../../src/server/toolbox.ts).
- The end-to-end lifecycle: LLM emits a `create_artifact` tool call → handler runs the executor → executor calls `artifactService.createFileArtifact(...)` → resulting `Artifact` is buffered on `context.state[PENDING_ARTIFACTS_STATE_KEY]` → handler drains the buffer on each iteration via [`drainPendingArtifacts`](../../src/server/toolbox.ts) and attaches the artifacts to `task.artifacts`.
- Pairing the tool with a real storage backend so the artifact URL returned to the LLM (and to the client) actually resolves to bytes.

## How the LLM sees it

When `enableCreateArtifact` is on, the toolbox advertises one extra tool to the model alongside any user-registered tools:

```json
{
  "name": "create_artifact",
  "description": "Create a named artifact attached to the current task by storing the supplied content via the configured artifact service. Use this to surface a discrete output (a document, a code snippet, a report) that the caller can fetch via the returned URI separately from the conversation transcript. Prefer this over inlining large outputs into the assistant message.",
  "parameters": {
    "type": "object",
    "properties": {
      "content": { "type": "string" },
      "filename": { "type": "string" },
      "name": { "type": "string" },
      "mimeType": { "type": "string" }
    },
    "required": ["content", "filename"]
  }
}
```

The system prompt nudges the model to call it whenever the user asks for a discrete output. See [`CREATE_ARTIFACT_TOOL_DESCRIPTION`](../../src/server/toolbox.ts) for the canonical copy.

## Layout

```text
examples/artifacts-autonomous-tool/
├── README.md
├── .env.example       # copy to .env to override defaults
├── client.ts          # sendMessage + poll tasks/get + download each artifact
├── package.json       # workspace package, depends only on @inference-gateway/adk
├── server.ts          # createA2AServer + DefaultBackgroundTaskHandler + DefaultToolBox({ enableCreateArtifact })
└── tsconfig.json
```

## Running it

You need an OpenAI-compatible LLM endpoint and credentials. From the repo root:

```sh
pnpm install
cp examples/artifacts-autonomous-tool/.env.example examples/artifacts-autonomous-tool/.env
# edit the .env: set A2A_AGENT_CLIENT_PROVIDER, A2A_AGENT_CLIENT_MODEL, and the matching API key
```

Start the server (in one terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-autonomous-tool start:server
```

Run the client (in another terminal):

```sh
pnpm --filter @inference-gateway/adk-example-artifacts-autonomous-tool start:client
```

### Configuration

Server (`server.ts`):

| Env var                     | Default                                                  | Description                                                                                                                                                |
| --------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_CLIENT_PROVIDER` | **required**                                             | Provider key (`openai`, `anthropic`, `groq`, `ollama`, ...). Used both to talk to the LLM and to look up `<PROVIDER>_API_KEY` when no explicit key is set. |
| `A2A_AGENT_CLIENT_MODEL`    | **required**                                             | Model identifier sent on every completion (e.g. `gpt-4o-mini`).                                                                                            |
| `A2A_AGENT_CLIENT_BASE_URL` | unset                                                    | Override the OpenAI-compatible endpoint. Point at the Inference Gateway, Ollama (`http://localhost:11434/v1`), or your provider's own URL.                 |
| `A2A_AGENT_CLIENT_API_KEY`  | falls back to `<PROVIDER>_API_KEY`                       | Explicit API key. Required when the provider's default env var is not set.                                                                                 |
| `A2A_AGENT_SYSTEM_PROMPT`   | (see source)                                             | System prompt prepended to every LLM call. The default nudges the model to prefer `create_artifact` over inlining content into replies.                    |
| `ARTIFACTS_ROOT`            | `<os.tmpdir>/adk-artifacts-autonomous`                   | Root directory on disk under which artifact files and sidecars are written.                                                                                |
| `ARTIFACTS_BASE_URL`        | `http://${A2A_SERVER_HOST}:${A2A_SERVER_PORT}/artifacts` | Base URL emitted in `FilePart.fileWithUri` and returned to the LLM in the tool result.                                                                     |
| `A2A_AGENT_NAME`            | `artifacts-autonomous-tool-agent`                        | Agent card `name`.                                                                                                                                         |
| `A2A_AGENT_DESCRIPTION`     | (see source)                                             | Agent card `description`.                                                                                                                                  |
| `A2A_AGENT_VERSION`         | `0.0.0`                                                  | Agent card `version`.                                                                                                                                      |
| `A2A_SERVER_HOST`           | `127.0.0.1`                                              | Listen host.                                                                                                                                               |
| `A2A_SERVER_PORT`           | `8080`                                                   | Listen port.                                                                                                                                               |

Client (`client.ts`):

| Env var      | Default                        | Description                                                                                                                         |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`        | Base URL of the A2A server.                                                                                                         |
| `PROMPTS`    | (two demo prompts, see source) | Pipe (`\|\|`)-separated list of prompts. Each one is sent as its own `message/send` request and the artifacts are downloaded after. |

## Expected flow

1. Client sends a `message/send` JSON-RPC request asking for a document/report/snippet.
2. Server creates a `PENDING` task, enqueues it, replies with the wire-format task.
3. Worker dequeues the task and hands it to `DefaultBackgroundTaskHandler.handle(...)`.
4. The handler builds a conversation, calls the LLM, and (typically) receives an assistant message with a `create_artifact` tool call.
5. The handler dispatches the tool call through the toolbox; the reserved executor:
   - Parses `{content, filename, name?, mimeType?}` from the tool arguments.
   - Calls `artifactService.createFileArtifact(name, description, filename, bytes, options)`, which writes the bytes to disk via `FilesystemArtifactStorage`.
   - Pushes the `Artifact` onto `context.state[PENDING_ARTIFACTS_STATE_KEY]`.
   - Returns a JSON string `{success, message, artifact_id, url, filename}` to the LLM.
6. The handler drains the pending-artifacts bag at the end of the iteration (or on terminal transition) and attaches every drained artifact to `task.artifacts`.
7. The LLM produces a final assistant message referring to the artifact by filename; the handler transitions the task to `TASK_STATE_COMPLETED`.
8. Client polls `tasks/get`, extracts `task.artifacts[].parts[].file.fileWithUri`, and downloads each URL through the server's `/artifacts` endpoint.

## Where artifacts land

```text
${ARTIFACTS_ROOT}/
└── <artifactId>/
    ├── <filename>                  # payload, mode 0o600
    └── <filename>.adk-meta.json    # sidecar (contentType + uploadedAt), mode 0o600
```

The MIME type recorded in the sidecar comes from `mimeType` in the tool call when supplied; otherwise the ADK infers it from the filename extension via [`getMimeTypeFromExtension`](../../src/artifacts/default-artifact-service.ts), falling back to `application/octet-stream`.

## Disabling the tool

To turn the reserved `create_artifact` tool off — for instance, when running the same toolbox in an unrelated agent — leave the option unset and the env var unset, or pass `enableCreateArtifact: false`. Without it the LLM is never told the tool exists, and the executor cannot be invoked.

You can also drive the toggle entirely from the environment by leaving `enableCreateArtifact` unset and setting `AGENT_CLIENT_TOOLS_CREATE_ARTIFACT=true` — the [`CREATE_ARTIFACT_ENV`](../../src/server/toolbox.ts) fallback handles that case (and requires `artifactService` to be provided regardless).

## Related examples

- [`examples/artifacts-filesystem/`](../artifacts-filesystem/) — same storage backend, but the agent attaches the artifact manually instead of via the LLM tool.
- [`examples/artifacts-minio/`](../artifacts-minio/) — point the same flow at MinIO / S3 instead of local disk.
- [`examples/artifacts-with-default-handlers/`](../artifacts-with-default-handlers/) — combine the storage wiring with the `withDefaultTaskHandlers()` builder shortcut.
