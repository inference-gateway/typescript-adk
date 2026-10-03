// Code generated from A2A schema. DO NOT EDIT.
//
// Source: https://github.com/inference-gateway/schemas/blob/v1.1.0/a2a/a2a-schema.json
// Regenerate with: pnpm generate:types

export type A2AMethod =
  | 'SendMessage'
  | 'SendStreamingMessage'
  | 'GetTask'
  | 'ListTasks'
  | 'CancelTask'
  | 'SubscribeToTask'
  | 'CreateTaskPushNotificationConfig'
  | 'GetTaskPushNotificationConfig'
  | 'ListTaskPushNotificationConfigs'
  | 'GetExtendedAgentCard'
  | 'DeleteTaskPushNotificationConfig';

/**
 * Defines optional capabilities supported by an agent.
 */
export interface AgentCapabilities {
  /**
   * Indicates if the agent supports providing an extended agent card when authenticated.
   */
  extendedAgentCard?: boolean;
  /**
   * A list of protocol extensions supported by the agent.
   */
  extensions?: AgentExtension[];
  /**
   * Indicates if the agent supports sending push notifications for asynchronous task updates.
   */
  pushNotifications?: boolean;
  /**
   * Indicates if the agent supports streaming responses.
   */
  streaming?: boolean;
}

/**
 * A self-describing manifest for an agent. It provides essential
 *  metadata including the agent's identity, capabilities, skills, supported
 *  communication methods, and security requirements.
 *  Next ID: 20
 */
export interface AgentCard {
  capabilities: AgentCapabilities;
  /**
   * protolint:enable REPEATED_FIELD_NAMES_PLURALIZED
   *  The set of interaction modes that the agent supports across all skills.
   *  This can be overridden per skill. Defined as media types.
   */
  defaultInputModes: string[];
  /**
   * The media types supported as outputs from this agent.
   */
  defaultOutputModes: string[];
  /**
   * A human-readable description of the agent, assisting users and other agents
   *  in understanding its purpose.
   *  Example: "Agent that helps users with recipes and cooking."
   */
  description: string;
  /**
   * A URL providing additional documentation about the agent.
   */
  documentationUrl?: string;
  /**
   * Optional. A URL to an icon for the agent.
   */
  iconUrl?: string;
  /**
   * A human readable name for the agent.
   *  Example: "Recipe Agent"
   */
  name: string;
  provider?: AgentProvider;
  /**
   * Security requirements for contacting the agent.
   */
  securityRequirements?: SecurityRequirement[];
  /**
   * The security scheme details used for authenticating with this agent.
   */
  securitySchemes?: {
    [k: string]: SecurityScheme | undefined;
  };
  /**
   * JSON Web Signatures computed for this `AgentCard`.
   */
  signatures?: AgentCardSignature[];
  /**
   * Skills represent the abilities of an agent.
   *  It is largely a descriptive concept but represents a more focused set of behaviors that the
   *  agent is likely to succeed at.
   */
  skills: AgentSkill[];
  /**
   * Ordered list of supported interfaces. The first entry is preferred.
   */
  supportedInterfaces: AgentInterface[];
  /**
   * The version of the agent.
   *  Example: "1.0.0"
   */
  version: string;
}

/**
 * AgentCardSignature represents a JWS signature of an AgentCard.
 *  This follows the JSON format of an RFC 7515 JSON Web Signature (JWS).
 */
export interface AgentCardSignature {
  header?: Struct;
  /**
   * (-- api-linter: core::0140::reserved-words=disabled
   *      aip.dev/not-precedent: Backwards compatibility --)
   *  Required. The protected JWS header for the signature. This is always a
   *  base64url-encoded JSON object.
   */
  protected: string;
  /**
   * Required. The computed signature, base64url-encoded.
   */
  signature: string;
}

/**
 * A declaration of a protocol extension supported by an Agent.
 */
export interface AgentExtension {
  /**
   * A human-readable description of how this agent uses the extension.
   */
  description?: string;
  params?: Struct;
  /**
   * If true, the client must understand and comply with the extension's requirements.
   */
  required?: boolean;
  /**
   * The unique URI identifying the extension.
   */
  uri?: string;
}

/**
 * Declares a combination of a target URL, transport and protocol version for interacting with the agent.
 *  This allows agents to expose the same functionality over multiple protocol binding mechanisms.
 */
export interface AgentInterface {
  /**
   * The protocol binding supported at this URL. This is an open form string, to be
   *  easily extended for other protocol bindings. The core ones officially
   *  supported are `JSONRPC`, `GRPC` and `HTTP+JSON`.
   */
  protocolBinding: string;
  /**
   * The version of the A2A protocol this interface exposes.
   *  Use the latest supported minor version per major version.
   *  Examples: "0.3", "1.0"
   */
  protocolVersion: string;
  /**
   * Optional. An opaque string used for routing requests to a specific agent
   *  or tenant when multiple agents are served behind a single A2A endpoint.
   *  When set, clients MUST include this value in the `tenant` field of all
   *  request messages sent to this interface. The server is responsible for
   *  interpreting the value and routing requests accordingly; the protocol
   *  does not define its format or semantics.
   */
  tenant?: string;
  /**
   * The URL where this interface is available. Must be a valid absolute HTTPS URL in production.
   *  Example: "https://api.example.com/a2a/v1", "https://grpc.example.com/a2a"
   */
  url: string;
}

/**
 * Represents the service provider of an agent.
 */
export interface AgentProvider {
  /**
   * The name of the agent provider's organization.
   *  Example: "Google"
   */
  organization: string;
  /**
   * A URL for the agent provider's website or relevant documentation.
   *  Example: "https://ai.google.dev"
   */
  url: string;
}

/**
 * Represents a distinct capability or function that an agent can perform.
 */
export interface AgentSkill {
  /**
   * A detailed description of the skill.
   */
  description: string;
  /**
   * Example prompts or scenarios that this skill can handle.
   */
  examples?: string[];
  /**
   * A unique identifier for the agent's skill.
   */
  id: string;
  /**
   * The set of supported input media types for this skill, overriding the agent's defaults.
   */
  inputModes?: string[];
  /**
   * A human-readable name for the skill.
   */
  name: string;
  /**
   * The set of supported output media types for this skill, overriding the agent's defaults.
   */
  outputModes?: string[];
  /**
   * Security schemes necessary for this skill.
   */
  securityRequirements?: SecurityRequirement[];
  /**
   * A set of keywords describing the skill's capabilities.
   */
  tags: string[];
}

/**
 * Defines a security scheme using an API key.
 */
export interface APIKeySecurityScheme {
  /**
   * An optional description for the security scheme.
   */
  description?: string;
  /**
   * The location of the API key. Valid values are "query", "header", or "cookie".
   */
  location: string;
  /**
   * The name of the header, query, or cookie parameter to be used.
   */
  name: string;
}

/**
 * Artifacts represent task outputs.
 */
export interface Artifact {
  /**
   * Unique identifier (e.g. UUID) for the artifact. It must be unique within a task.
   */
  artifactId: string;
  /**
   * Optional. A human readable description of the artifact.
   */
  description?: string;
  /**
   * The URIs of extensions that are present or contributed to this Artifact.
   */
  extensions?: string[];
  metadata?: Struct;
  /**
   * A human readable name for the artifact.
   */
  name?: string;
  /**
   * The content of the artifact. Must contain at least one part.
   */
  parts: Part[];
}

/**
 * Defines authentication details, used for push notifications.
 */
export interface AuthenticationInfo {
  /**
   * Push Notification credentials. Format depends on the scheme (e.g., token for Bearer).
   */
  credentials?: string;
  /**
   * HTTP Authentication Scheme from the [IANA registry](https://www.iana.org/assignments/http-authschemes/).
   *  Examples: `Bearer`, `Basic`, `Digest`.
   *  Scheme names are case-insensitive per [RFC 9110 Section 11.1](https://www.rfc-editor.org/rfc/rfc9110#section-11.1).
   */
  scheme: string;
}

/**
 * Defines configuration details for the OAuth 2.0 Authorization Code flow.
 */
export interface AuthorizationCodeOAuthFlow {
  /**
   * The authorization URL to be used for this flow.
   */
  authorizationUrl: string;
  /**
   * Indicates if PKCE (RFC 7636) is required for this flow.
   *  PKCE should always be used for public clients and is recommended for all clients.
   */
  pkceRequired?: boolean;
  /**
   * The URL to be used for obtaining refresh tokens.
   */
  refreshUrl?: string;
  /**
   * The available scopes for the OAuth2 security scheme.
   */
  scopes: {
    [k: string]: string | undefined;
  };
  /**
   * The token URL to be used for this flow.
   */
  tokenUrl: string;
}

/**
 * Represents a request for the `CancelTask` method.
 */
export interface CancelTaskRequest {
  /**
   * The resource ID of the task to cancel.
   */
  id: string;
  metadata?: Struct;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Defines configuration details for the OAuth 2.0 Client Credentials flow.
 */
export interface ClientCredentialsOAuthFlow {
  /**
   * The URL to be used for obtaining refresh tokens.
   */
  refreshUrl?: string;
  /**
   * The available scopes for the OAuth2 security scheme.
   */
  scopes: {
    [k: string]: string | undefined;
  };
  /**
   * The token URL to be used for this flow.
   */
  tokenUrl: string;
}

/**
 * Represents a request for the `DeleteTaskPushNotificationConfig` method.
 */
export interface DeleteTaskPushNotificationConfigRequest {
  /**
   * The resource ID of the configuration to delete.
   */
  id: string;
  /**
   * The parent task resource ID.
   */
  taskId: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Defines configuration details for the OAuth 2.0 Device Code flow (RFC 8628).
 *  This flow is designed for input-constrained devices such as IoT devices,
 *  and CLI tools where the user authenticates on a separate device.
 */
export interface DeviceCodeOAuthFlow {
  /**
   * The device authorization endpoint URL.
   */
  deviceAuthorizationUrl: string;
  /**
   * The URL to be used for obtaining refresh tokens.
   */
  refreshUrl?: string;
  /**
   * The available scopes for the OAuth2 security scheme.
   */
  scopes: {
    [k: string]: string | undefined;
  };
  /**
   * The token URL to be used for this flow.
   */
  tokenUrl: string;
}

/**
 * Represents a request for the `GetExtendedAgentCard` method.
 */
export interface GetExtendedAgentCardRequest {
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Represents a request for the `GetTaskPushNotificationConfig` method.
 */
export interface GetTaskPushNotificationConfigRequest {
  /**
   * The resource ID of the configuration to retrieve.
   */
  id: string;
  /**
   * The parent task resource ID.
   */
  taskId: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Represents a request for the `GetTask` method.
 */
export interface GetTaskRequest {
  /**
   * The maximum number of most recent messages from the task's history to retrieve. An
   *  unset value means the client does not impose any limit. A value of zero is
   *  a request to not include any messages. The server MUST NOT return more
   *  messages than the provided value, but MAY apply a lower limit.
   */
  historyLength?: number;
  /**
   * The resource ID of the task to retrieve.
   */
  id: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Defines a security scheme using HTTP authentication.
 */
export interface HTTPAuthSecurityScheme {
  /**
   * A hint to the client to identify how the bearer token is formatted (e.g., "JWT").
   *  Primarily for documentation purposes.
   */
  bearerFormat?: string;
  /**
   * An optional description for the security scheme.
   */
  description?: string;
  /**
   * The name of the HTTP Authentication scheme to be used in the Authorization header,
   *  as defined in RFC7235 (e.g., "Bearer").
   *  This value should be registered in the IANA Authentication Scheme registry.
   */
  scheme: string;
}

/**
 * Deprecated: Use Authorization Code + PKCE instead.
 */
export interface ImplicitOAuthFlow {
  /**
   * The authorization URL to be used for this flow. This MUST be in the
   *  form of a URL. The OAuth2 standard requires the use of TLS
   */
  authorizationUrl?: string;
  /**
   * The URL to be used for obtaining refresh tokens. This MUST be in the
   *  form of a URL. The OAuth2 standard requires the use of TLS.
   */
  refreshUrl?: string;
  /**
   * The available scopes for the OAuth2 security scheme. A map between the
   *  scope name and a short description for it. The map MAY be empty.
   */
  scopes?: {
    [k: string]: string | undefined;
  };
}

/**
 * A JSON-RPC 2.0 error object; A2A error codes are mapped in spec section 5.4.
 *  Hand-written by inference-gateway, not part of the official a2a.proto, which does not model
 *  the JSON-RPC binding.
 */
export interface JSONRPCError {
  /**
   * The error code, e.g. -32601 for an unknown method.
   */
  code: number;
  data?: Value;
  /**
   * A short description of the error.
   */
  message: string;
}

/**
 * A JSON-RPC 2.0 response reporting a failed A2A method call (A2A spec section 9.5).
 *  Hand-written by inference-gateway, not part of the official a2a.proto, which does not model
 *  the JSON-RPC binding.
 */
export interface JSONRPCErrorResponse {
  error: JSONRPCError;
  id: Value;
  /**
   * The JSON-RPC version, always "2.0".
   */
  jsonrpc: string;
}

/**
 * A JSON-RPC 2.0 request to an A2A agent (A2A spec section 9.3).
 *  Hand-written by inference-gateway, not part of the official a2a.proto, which does not model
 *  the JSON-RPC binding.
 */
export interface JSONRPCRequest {
  id?: Value;
  /**
   * The JSON-RPC version, always "2.0".
   */
  jsonrpc: string;
  method: A2AMethod;
  params?: Struct;
}

/**
 * A JSON-RPC 2.0 response carrying the result of an A2A method (A2A spec section 9).
 *  Hand-written by inference-gateway, not part of the official a2a.proto, which does not model
 *  the JSON-RPC binding.
 */
export interface JSONRPCSuccessResponse {
  id: Value;
  /**
   * The JSON-RPC version, always "2.0".
   */
  jsonrpc: string;
  result: Value;
}

/**
 * Represents a request for the `ListTaskPushNotificationConfigs` method.
 */
export interface ListTaskPushNotificationConfigsRequest {
  /**
   * The maximum number of configurations to return.
   */
  pageSize?: number;
  /**
   * A page token received from a previous `ListTaskPushNotificationConfigsRequest` call.
   */
  pageToken?: string;
  /**
   * The parent task resource ID.
   */
  taskId: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Represents a successful response for the `ListTaskPushNotificationConfigs`
 *  method.
 */
export interface ListTaskPushNotificationConfigsResponse {
  /**
   * The list of push notification configurations.
   */
  configs?: TaskPushNotificationConfig[];
  /**
   * A token to retrieve the next page of results, or empty if there are no more results in the list.
   */
  nextPageToken?: string;
}

/**
 * Parameters for listing tasks with optional filtering criteria.
 */
export interface ListTasksRequest {
  /**
   * Filter tasks by context ID to get tasks from a specific conversation or session.
   */
  contextId?: string;
  /**
   * The maximum number of messages to include in each task's history.
   */
  historyLength?: number;
  /**
   * Whether to include artifacts in the returned tasks.
   *  Defaults to false to reduce payload size.
   */
  includeArtifacts?: boolean;
  /**
   * The maximum number of tasks to return. The service may return fewer than this value.
   *  If unspecified, at most 50 tasks will be returned.
   *  The minimum value is 1.
   *  The maximum value is 100.
   */
  pageSize?: number;
  /**
   * A page token, received from a previous `ListTasks` call.
   *  `ListTasksResponse.next_page_token`.
   *  Provide this to retrieve the subsequent page.
   */
  pageToken?: string;
  status?: TaskState;
  statusTimestampAfter?: Timestamp;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Result object for `ListTasks` method containing an array of tasks and pagination information.
 */
export interface ListTasksResponse {
  /**
   * A token to retrieve the next page of results, or empty if there are no more results in the list.
   */
  nextPageToken: string;
  /**
   * The page size used for this response.
   */
  pageSize: number;
  /**
   * Array of tasks matching the specified criteria.
   */
  tasks: Task[];
  /**
   * Total number of tasks available (before pagination).
   */
  totalSize: number;
}

/**
 * `Message` is one unit of communication between client and server. It can be
 *  associated with a context and/or a task. For server messages, `context_id` must
 *  be provided, and `task_id` only if a task was created. For client messages, both
 *  fields are optional, with the caveat that if both are provided, they have to
 *  match (the `context_id` has to be the one that is set on the task). If only
 *  `task_id` is provided, the server will infer `context_id` from it.
 */
export interface Message {
  /**
   * Optional. The context id of the message. If set, the message will be associated with the given context.
   */
  contextId?: string;
  /**
   * The URIs of extensions that are present or contributed to this Message.
   */
  extensions?: string[];
  /**
   * The unique identifier (e.g. UUID) of the message. This is created by the message creator.
   */
  messageId: string;
  metadata?: Struct;
  /**
   * Parts is the container of the message content.
   */
  parts: Part[];
  /**
   * A list of task IDs that this message references for additional context.
   */
  referenceTaskIds?: string[];
  role: Role;
  /**
   * Optional. The task id of the message. If set, the message will be associated with the given task.
   */
  taskId?: string;
}

/**
 * Defines a security scheme using mTLS authentication.
 */
export interface MutualTlsSecurityScheme {
  /**
   * An optional description for the security scheme.
   */
  description?: string;
}

/**
 * Defines a security scheme using OAuth 2.0.
 */
export interface OAuth2SecurityScheme {
  /**
   * An optional description for the security scheme.
   */
  description?: string;
  flows: OAuthFlows;
  /**
   * URL to the OAuth2 authorization server metadata [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).
   *  TLS is required.
   */
  oauth2MetadataUrl?: string;
}

/**
 * Defines the configuration for the supported OAuth 2.0 flows.
 */
export interface OAuthFlows {
  authorizationCode?: AuthorizationCodeOAuthFlow;
  clientCredentials?: ClientCredentialsOAuthFlow;
  deviceCode?: DeviceCodeOAuthFlow;
  implicit?: ImplicitOAuthFlow;
  password?: PasswordOAuthFlow;
}

/**
 * Defines a security scheme using OpenID Connect.
 */
export interface OpenIdConnectSecurityScheme {
  /**
   * An optional description for the security scheme.
   */
  description?: string;
  /**
   * The [OpenID Connect Discovery URL](https://openid.net/specs/openid-connect-discovery-1_0.html) for the OIDC provider's metadata.
   */
  openIdConnectUrl: string;
}

/**
 * `Part` represents a container for a section of communication content.
 *  Parts can be purely textual, some sort of file (image, video, etc) or
 *  a structured data blob (i.e. JSON).
 */
export interface Part {
  data?: Value;
  /**
   * An optional `filename` for the file (e.g., "document.pdf").
   */
  filename?: string;
  /**
   * The `media_type` (MIME type) of the part content (e.g., "text/plain", "application/json", "image/png").
   *  This field is available for all part types.
   */
  mediaType?: string;
  metadata?: Struct;
  /**
   * The `raw` byte content of a file. In JSON serialization, this is encoded as a base64 string.
   */
  raw?: string;
  /**
   * The string content of the `text` part.
   */
  text?: string;
  /**
   * A `url` pointing to the file's content.
   */
  url?: string;
}

/**
 * Deprecated: Use Authorization Code + PKCE or Device Code.
 */
export interface PasswordOAuthFlow {
  /**
   * The URL to be used for obtaining refresh tokens. This MUST be in the
   *  form of a URL. The OAuth2 standard requires the use of TLS.
   */
  refreshUrl?: string;
  /**
   * The available scopes for the OAuth2 security scheme. A map between the
   *  scope name and a short description for it. The map MAY be empty.
   */
  scopes?: {
    [k: string]: string | undefined;
  };
  /**
   * The token URL to be used for this flow. This MUST be in the form of a URL.
   *  The OAuth2 standard requires the use of TLS.
   */
  tokenUrl?: string;
}

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

/**
 * Defines the security requirements for an agent.
 */
export interface SecurityRequirement {
  /**
   * A map of security schemes to the required scopes.
   */
  schemes?: {
    [k: string]: StringList | undefined;
  };
}

/**
 * Defines a security scheme that can be used to secure an agent's endpoints.
 *  This is a discriminated union type based on the OpenAPI 3.2 Security Scheme Object.
 *  See: https://spec.openapis.org/oas/v3.2.0.html#security-scheme-object
 */
export interface SecurityScheme {
  apiKeySecurityScheme?: APIKeySecurityScheme;
  httpAuthSecurityScheme?: HTTPAuthSecurityScheme;
  mtlsSecurityScheme?: MutualTlsSecurityScheme;
  oauth2SecurityScheme?: OAuth2SecurityScheme;
  openIdConnectSecurityScheme?: OpenIdConnectSecurityScheme;
}

/**
 * Configuration of a send message request.
 */
export interface SendMessageConfiguration {
  /**
   * A list of media types the client is prepared to accept for response parts.
   *  Agents SHOULD use this to tailor their output.
   */
  acceptedOutputModes?: string[];
  /**
   * The maximum number of most recent messages from the task's history to retrieve in
   *  the response. An unset value means the client does not impose any limit. A
   *  value of zero is a request to not include any messages. The server MUST NOT
   *  return more messages than the provided value, but MAY apply a lower limit.
   */
  historyLength?: number;
  /**
   * If `true`, the operation returns immediately after creating the task,
   *  even if processing is still in progress.
   *  If `false` (default), the operation MUST wait until the task reaches a
   *  terminal (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) or interrupted
   *  (`INPUT_REQUIRED`, `AUTH_REQUIRED`) state before returning.
   */
  returnImmediately?: boolean;
  taskPushNotificationConfig?: TaskPushNotificationConfig;
}

/**
 * Represents a request for the `SendMessage` method.
 */
export interface SendMessageRequest {
  configuration?: SendMessageConfiguration;
  message: Message;
  metadata?: Struct;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * Represents the response for the `SendMessage` method.
 */
export interface SendMessageResponse {
  message?: Message;
  task?: Task;
}

/**
 * A wrapper object used in streaming operations to encapsulate different types of response data.
 */
export interface StreamResponse {
  artifactUpdate?: TaskArtifactUpdateEvent;
  message?: Message;
  statusUpdate?: TaskStatusUpdateEvent;
  task?: Task;
}

/**
 * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
 *  A list of strings.
 */
export interface StringList {
  /**
   * The individual string values.
   */
  list?: string[];
}

export type Struct = Record<string, unknown>;

/**
 * Represents a request for the `SubscribeToTask` method.
 */
export interface SubscribeToTaskRequest {
  /**
   * The resource ID of the task to subscribe to.
   */
  id: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
}

/**
 * `Task` is the core unit of action for A2A. It has a current status
 *  and when results are created for the task they are stored in the
 *  artifact. If there are multiple turns for a task, these are stored in
 *  history.
 */
export interface Task {
  /**
   * A set of output artifacts for a `Task`.
   */
  artifacts?: Artifact[];
  /**
   * Unique identifier (e.g. UUID) for the contextual collection of interactions
   *  (tasks and messages).
   */
  contextId?: string;
  /**
   * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
   *  The history of interactions from a `Task`.
   */
  history?: Message[];
  /**
   * Unique identifier (e.g. UUID) for the task, generated by the server for a
   *  new task.
   */
  id: string;
  metadata?: Struct;
  status: TaskStatus;
}

/**
 * A task delta where an artifact has been generated.
 */
export interface TaskArtifactUpdateEvent {
  /**
   * If true, the content of this artifact should be appended to a previously
   *  sent artifact with the same ID.
   */
  append?: boolean;
  artifact: Artifact;
  /**
   * The ID of the context that this task belongs to.
   */
  contextId: string;
  /**
   * If true, this is the final chunk of the artifact.
   */
  lastChunk?: boolean;
  metadata?: Struct;
  /**
   * The ID of the task for this artifact.
   */
  taskId: string;
}

/**
 * A container associating a push notification configuration with a specific task.
 */
export interface TaskPushNotificationConfig {
  authentication?: AuthenticationInfo;
  /**
   * The push notification configuration details.
   *  A unique identifier (e.g. UUID) for this push notification configuration.
   */
  id?: string;
  /**
   * The ID of the task this configuration is associated with.
   */
  taskId?: string;
  /**
   * Optional. Opaque routing identifier. Must match the `tenant` value from
   *  the selected `AgentInterface` in the Agent Card when that field is set.
   */
  tenant?: string;
  /**
   * A token unique for this task or session.
   */
  token?: string;
  /**
   * The URL where the notification should be sent.
   */
  url: string;
}

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

/**
 * A container for the status of a task
 */
export interface TaskStatus {
  message?: Message;
  state: TaskState;
  timestamp?: Timestamp;
}

/**
 * An event sent by the agent to notify the client of a change in a task's status.
 */
export interface TaskStatusUpdateEvent {
  /**
   * The ID of the context that the task belongs to.
   */
  contextId: string;
  metadata?: Struct;
  status: TaskStatus;
  /**
   * The ID of the task that has changed.
   */
  taskId: string;
}

export type Timestamp = string;

export type Value = unknown;
