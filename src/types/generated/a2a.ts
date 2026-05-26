// Code generated from A2A schema. DO NOT EDIT.
//
// Source: https://github.com/inference-gateway/schemas/blob/2b5aea62d53c6dc13990f14a2da6483db1a97902/a2a/a2a-schema.json
// Regenerate with: pnpm generate:types

/**
 * Defines optional capabilities supported by an agent.
 */
export interface AgentCapabilities {
  /**
   * A list of protocol extensions supported by the agent.
   */
  extensions?: AgentExtension[];
  /**
   * Indicates if the agent supports sending push notifications for asynchronous task updates.
   */
  pushNotifications?: boolean;
  /**
   * Indicates if the agent provides a history of state transitions for a task.
   */
  stateTransitionHistory?: boolean;
  /**
   * Indicates if the agent supports streaming responses.
   */
  streaming?: boolean;
}

/**
 * AgentCard is a self-describing manifest for an agent. It provides essential
 *  metadata including the agent's identity, capabilities, skills, supported
 *  communication methods, and security requirements.
 *  Next ID: 20
 */
export interface AgentCard {
  /**
   * DEPRECATED: Use 'supported_interfaces' instead.
   */
  additionalInterfaces?: AgentInterface[];
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
   * A url to provide additional documentation about the agent.
   */
  documentationUrl?: string;
  /**
   * An optional URL to an icon for the agent.
   */
  iconUrl?: string;
  /**
   * A human readable name for the agent.
   *  Example: "Recipe Agent"
   */
  name: string;
  /**
   * DEPRECATED: Use 'supported_interfaces' instead.
   */
  preferredTransport?: string;
  /**
   * The version of the A2A protocol this agent supports.
   *  Default: "1.0"
   */
  protocolVersion: string;
  provider?: AgentProvider;
  /**
   * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
   *  Security requirements for contacting the agent.
   */
  security?: Security[];
  /**
   * The security scheme details used for authenticating with this agent.
   */
  securitySchemes?: {
    [k: string]: SecurityScheme | undefined;
  };
  /**
   * JSON Web Signatures computed for this AgentCard.
   */
  signatures?: AgentCardSignature[];
  /**
   * Skills represent an ability of an agent. It is largely
   *  a descriptive concept but represents a more focused set of behaviors that the
   *  agent is likely to succeed at.
   */
  skills: AgentSkill[];
  /**
   * Ordered list of supported interfaces. First entry is preferred.
   */
  supportedInterfaces?: AgentInterface[];
  /**
   * Whether the agent supports providing an extended agent card when authenticated.
   */
  supportsExtendedAgentCard?: boolean;
  /**
   * DEPRECATED: Use 'supported_interfaces' instead.
   */
  url?: string;
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
   * The protected JWS header for the signature. This is always a
   *  base64url-encoded JSON object. Required.
   */
  protected: string;
  /**
   * The computed signature, base64url-encoded. Required.
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
  description: string;
  params?: Struct;
  /**
   * If true, the client must understand and comply with the extension's requirements.
   */
  required: boolean;
  /**
   * The unique URI identifying the extension.
   */
  uri: string;
}

/**
 * Declares a combination of a target URL and a transport protocol for interacting with the agent.
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
   * Tenant to be set in the request when calling the agent.
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
   * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
   *  Security schemes necessary for this skill.
   */
  security?: Security[];
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
   * Unique identifier (e.g. UUID) for the artifact. It must be at least unique
   *  within a task.
   */
  artifactId: string;
  /**
   * A human readable description of the artifact, optional.
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
   * Optional credentials
   */
  credentials?: string;
  /**
   * A list of supported authentication schemes (e.g., 'Basic', 'Bearer').
   */
  schemes: string[];
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
 * Represents a request for the `tasks/cancel` method.
 */
export interface CancelTaskRequest {
  /**
   * The resource name of the task to cancel.
   *  Format: tasks/{task_id}
   */
  name: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
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
 * DataPart represents a structured blob.
 */
export interface DataPart {
  data: Struct;
}

/**
 * Represents a request for the `tasks/pushNotificationConfig/delete` method.
 */
export interface DeleteTaskPushNotificationConfigRequest {
  /**
   * The resource name of the config to delete.
   *  Format: tasks/{task_id}/pushNotificationConfigs/{config_id}
   */
  name: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * FilePart represents the different ways files can be provided. If files are
 *  small, directly feeding the bytes is supported via file_with_bytes. If the
 *  file is large, the agent should read the content as appropriate directly
 *  from the file_with_uri source.
 */
export interface FilePart {
  /**
   * The base64-encoded content of the file.
   */
  fileWithBytes?: string;
  /**
   * A URL pointing to the file's content.
   */
  fileWithUri?: string;
  /**
   * The media type of the file (e.g., "application/pdf").
   */
  mediaType: string;
  /**
   * An optional name for the file (e.g., "document.pdf").
   */
  name: string;
}

export interface GetExtendedAgentCardRequest {
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

export interface GetTaskPushNotificationConfigRequest {
  /**
   * The resource name of the config to retrieve.
   *  Format: tasks/{task_id}/pushNotificationConfigs/{config_id}
   */
  name: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * Represents a request for the `tasks/get` method.
 */
export interface GetTaskRequest {
  /**
   * The maximum number of messages to include in the history.
   */
  historyLength?: number;
  /**
   * The resource name of the task.
   *  Format: tasks/{task_id}
   */
  name: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant?: string;
}

/**
 * Defines a security scheme using HTTP authentication.
 */
export interface HTTPAuthSecurityScheme {
  /**
   * A hint to the client to identify how the bearer token is formatted (e.g., "JWT").
   *  This is primarily for documentation purposes.
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
 * Defines configuration details for the OAuth 2.0 Implicit flow.
 */
export interface ImplicitOAuthFlow {
  /**
   * The authorization URL to be used for this flow.
   */
  authorizationUrl: string;
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
}

export interface ListTaskPushNotificationConfigRequest {
  /**
   * The maximum number of configurations to return.
   */
  pageSize: number;
  /**
   * A page token received from a previous ListTaskPushNotificationConfigRequest call.
   */
  pageToken: string;
  /**
   * The parent task resource.
   *  Format: tasks/{task_id}
   */
  parent: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * Represents a successful response for the `tasks/pushNotificationConfig/list`
 *  method.
 */
export interface ListTaskPushNotificationConfigResponse {
  /**
   * The list of push notification configurations.
   */
  configs?: TaskPushNotificationConfig[];
  /**
   * A token, which can be sent as `page_token` to retrieve the next page.
   *  If this field is omitted, there are no subsequent pages.
   */
  nextPageToken: string;
}

/**
 * Parameters for listing tasks with optional filtering criteria.
 */
export interface ListTasksRequest {
  /**
   * Filter tasks by context ID to get tasks from a specific conversation or session.
   */
  contextId: string;
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
   * Filter tasks updated after this timestamp (milliseconds since epoch).
   *  Only tasks with a last updated time greater than or equal to this value will be returned.
   */
  lastUpdatedAfter: number;
  /**
   * Maximum number of tasks to return. Must be between 1 and 100.
   *  Defaults to 50 if not specified.
   */
  pageSize?: number;
  /**
   * Token for pagination. Use the next_page_token from a previous ListTasksResponse.
   */
  pageToken: string;
  status: TaskState;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * Result object for tasks/list method containing an array of tasks and pagination information.
 */
export interface ListTasksResponse {
  /**
   * Token for retrieving the next page. Empty string if no more results.
   */
  nextPageToken: string;
  /**
   * The size of page requested.
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
 * Message is one unit of communication between client and server. It is
 *  associated with a context and optionally a task. Since the server is
 *  responsible for the context definition, it must always provide a context_id
 *  in its messages. The client can optionally provide the context_id if it
 *  knows the context to associate the message to. Similarly for task_id,
 *  except the server decides if a task is created and whether to include the
 *  task_id.
 */
export interface Message {
  /**
   * The context id of the message. This is optional and if set, the message
   *  will be associated with the given context.
   */
  contextId?: string;
  /**
   * The URIs of extensions that are present or contributed to this Message.
   */
  extensions?: string[];
  /**
   * The unique identifier (e.g. UUID) of the message. This is required and
   *  created by the message creator.
   */
  messageId: string;
  metadata?: Struct;
  /**
   * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
   *  Parts is the container of the message content.
   */
  parts: Part[];
  /**
   * A list of task IDs that this message references for additional context.
   */
  referenceTaskIds?: string[];
  role: Role;
  /**
   * The task id of the message. This is optional and if set, the message
   *  will be associated with the given task.
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
  description: string;
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
   * URL to the oauth2 authorization server metadata
   *  RFC8414 (https://datatracker.ietf.org/doc/html/rfc8414). TLS is required.
   */
  oauth2MetadataUrl?: string;
}

/**
 * Defines the configuration for the supported OAuth 2.0 flows.
 */
export interface OAuthFlows {
  authorizationCode?: AuthorizationCodeOAuthFlow;
  clientCredentials?: ClientCredentialsOAuthFlow;
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
   * The OpenID Connect Discovery URL for the OIDC provider's metadata.
   *  See: https://openid.net/specs/openid-connect-discovery-1_0.html
   */
  openIdConnectUrl: string;
}

/**
 * Part represents a container for a section of communication content.
 *  Parts can be purely textual, some sort of file (image, video, etc) or
 *  a structured data blob (i.e. JSON).
 */
export interface Part {
  data?: DataPart;
  file?: FilePart;
  metadata?: Struct;
  /**
   * The string content of the text part.
   */
  text?: string;
}

/**
 * Defines configuration details for the OAuth 2.0 Resource Owner Password flow.
 */
export interface PasswordOAuthFlow {
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
 * Configuration for setting up push notifications for task updates.
 */
export interface PushNotificationConfig {
  authentication?: AuthenticationInfo;
  /**
   * A unique identifier (e.g. UUID) for this push notification.
   */
  id?: string;
  /**
   * Token unique for this task/session
   */
  token?: string;
  /**
   * Url to send the notification too
   */
  url: string;
}

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

export interface Security {
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
   * A list of media types the client is prepared to accept for response parts. Agents SHOULD use this to tailor their output.
   */
  acceptedOutputModes?: string[];
  /**
   * If true, the operation waits until the task reaches a terminal state before returning. Default is false.
   */
  blocking: boolean;
  /**
   * The maximum number of messages to include in the history.
   */
  historyLength?: number;
  pushNotificationConfig?: PushNotificationConfig;
}

/**
 * /////////// Request Messages ///////////
 *  Represents a request for the `message/send` method.
 */
export interface SendMessageRequest {
  configuration?: SendMessageConfiguration;
  message?: Message;
  metadata?: Struct;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * ////// Response Messages ///////////
 */
export interface SendMessageResponse {
  message?: Message;
  task?: Task;
}

/**
 * Represents a request for the `tasks/pushNotificationConfig/set` method.
 */
export interface SetTaskPushNotificationConfigRequest {
  config: TaskPushNotificationConfig;
  /**
   * The ID for the new config.
   */
  configId: string;
  /**
   * The parent task resource for this config.
   *  Format: tasks/{task_id}
   */
  parent: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant?: string;
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
 */
export interface StringList {
  list?: string[];
}

export interface Struct {}

export interface SubscribeToTaskRequest {
  /**
   * The resource name of the task to subscribe to.
   *  Format: tasks/{task_id}
   */
  name: string;
  /**
   * Optional tenant, provided as a path parameter.
   */
  tenant: string;
}

/**
 * Task is the core unit of action for A2A. It has a current status
 *  and when results are created for the task they are stored in the
 *  artifact. If there are multiple turns for a task, these are stored in
 *  history.
 */
export interface Task {
  /**
   * A set of output artifacts for a Task.
   */
  artifacts?: Artifact[];
  /**
   * Unique identifier (e.g. UUID) for the contextual collection of interactions
   *  (tasks and messages). Created by the A2A server.
   */
  contextId: string;
  /**
   * protolint:disable REPEATED_FIELD_NAMES_PLURALIZED
   *  The history of interactions from a task.
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
 * TaskArtifactUpdateEvent represents a task delta where an artifact has
 *  been generated.
 */
export interface TaskArtifactUpdateEvent {
  /**
   * If true, the content of this artifact should be appended to a previously
   *  sent artifact with the same ID.
   */
  append?: boolean;
  artifact: Artifact;
  /**
   * The id of the context that this task belongs to.
   */
  contextId: string;
  /**
   * If true, this is the final chunk of the artifact.
   */
  lastChunk?: boolean;
  metadata?: Struct;
  /**
   * The id of the task for this artifact.
   */
  taskId: string;
}

/**
 * A container associating a push notification configuration with a specific
 *  task.
 */
export interface TaskPushNotificationConfig {
  /**
   * The resource name of the config.
   *  Format: tasks/{task_id}/pushNotificationConfigs/{config_id}
   */
  name: string;
  pushNotificationConfig: PushNotificationConfig;
}

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELLED'
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
 * An event sent by the agent to notify the client of a change in a task's
 *  status.
 */
export interface TaskStatusUpdateEvent {
  /**
   * The id of the context that the task belongs to
   */
  contextId: string;
  /**
   * If true, this is the final event in the stream for this interaction.
   */
  final: boolean;
  metadata?: Struct;
  status: TaskStatus;
  /**
   * The id of the task that is changed
   */
  taskId: string;
}

export type Timestamp = string;
