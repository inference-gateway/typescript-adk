import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  AuthenticationInfo,
  DeleteTaskPushNotificationConfigRequest,
  GetTaskPushNotificationConfigRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  TaskPushNotificationConfig,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A
 * `CreateTaskPushNotificationConfig` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD =
  'CreateTaskPushNotificationConfig' satisfies A2AMethod;

/**
 * Canonical JSON-RPC method name for the A2A
 * `GetTaskPushNotificationConfig` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD =
  'GetTaskPushNotificationConfig' satisfies A2AMethod;

/**
 * Canonical JSON-RPC method name for the A2A
 * `ListTaskPushNotificationConfigs` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD =
  'ListTaskPushNotificationConfigs' satisfies A2AMethod;

/**
 * Canonical JSON-RPC method name for the A2A
 * `DeleteTaskPushNotificationConfig` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD =
  'DeleteTaskPushNotificationConfig' satisfies A2AMethod;

/**
 * Build the handler to register for every push notification config method when
 * the card sets `capabilities.pushNotifications` to anything but `true`.
 *
 * The methods exist in the A2A surface regardless, so leaving them
 * unregistered would surface `-32601` (Method Not Found) where the spec
 * requires `-32003` (`PushNotificationNotSupportedError`, section 5.4) - the
 * method is known, the agent just does not support it.
 */
export function createPushNotificationNotSupportedHandler(): MethodHandler<
  unknown,
  never
> {
  return (): never => {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED_ERROR,
      'push notifications are not supported by this agent'
    );
  };
}

export interface TaskPushNotificationConfigHandlerOptions {
  /** Storage backend that persists configs via `setPushConfig` / etc. */
  readonly storage: TaskStorage;
}

/**
 * Build a handler for the A2A `CreateTaskPushNotificationConfig` JSON-RPC
 * method.
 *
 * Persists the inbound `pushNotificationConfig` against `taskId` via
 * {@link TaskStorage.setPushConfig}. If the config has no `id`, the storage
 * layer assigns one with `crypto.randomUUID()`. The returned wire-format
 * {@link TaskPushNotificationConfig} carries the populated config back to the
 * caller so it can be used as the key for `get`/`delete`.
 *
 * Per-config Bearer token webhook auth flows through the existing
 * {@link PushNotificationConfig.token} field; richer schemes can be supplied
 * via {@link PushNotificationConfig.authentication}. This handler is
 * orthogonal to delivery - it only persists the config. The delivery layer
 * (tracked separately) consults `TaskStorage.listPushConfigs` when fanning
 * task updates out.
 *
 * Errors surface as JSON-RPC `-32602` (Invalid Params):
 *  - `params` not an object, missing `taskId`, missing `pushNotificationConfig`
 *  - `url` missing or empty
 *  - `id` present but not a non-empty string
 *  - `token` present but not a string
 *
 * Storage does *not* verify that `taskId` corresponds to a known task -
 * matches the Go ADK's behaviour and lets clients register configs before the
 * task is materialised.
 */
export function createTaskPushNotificationConfigSetHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, TaskPushNotificationConfig> {
  const { storage } = options;

  return (params: unknown): TaskPushNotificationConfig => {
    const { taskId, ...config } = validateSetParams(params);
    return { ...storage.setPushConfig(taskId, config), taskId };
  };
}

/**
 * Build a handler for the A2A `GetTaskPushNotificationConfig` JSON-RPC
 * method.
 *
 * Returns the wire-format {@link TaskPushNotificationConfig} for the
 * `(taskId, pushNotificationConfigId)` pair, or `-32602` (Invalid Params) when
 * no config is registered under that key. The "not found" path uses
 * `-32602` to match the convention established by `GetTask`.
 */
export function createTaskPushNotificationConfigGetHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, TaskPushNotificationConfig> {
  const { storage } = options;

  return (params: unknown): TaskPushNotificationConfig => {
    const validated = validateGetParams(params);
    const config = storage.getPushConfig(validated.taskId, validated.id);
    if (config === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'push notification config not found'
      );
    }
    return { ...config, taskId: validated.taskId };
  };
}

/**
 * Build a handler for the A2A `ListTaskPushNotificationConfigs` JSON-RPC
 * method.
 *
 * Returns every config registered under `taskId` as an array. An empty array
 * is returned (rather than an error) for an unknown task id - listing is
 * idempotent and a fresh task with no configs is the common case for the
 * first call.
 */
export function createTaskPushNotificationConfigListHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, ListTaskPushNotificationConfigsResponse> {
  const { storage } = options;

  return (params: unknown): ListTaskPushNotificationConfigsResponse => {
    const validated = validateListParams(params);
    return {
      configs: storage
        .listPushConfigs(validated.taskId)
        .map((config) => ({ ...config, taskId: validated.taskId })),
    };
  };
}

/**
 * Build a handler for the A2A `DeleteTaskPushNotificationConfig` JSON-RPC
 * method.
 *
 * Removes the config at `(taskId, pushNotificationConfigId)`. Returns `null`
 * on success (the A2A schema returns `Empty`/`null` for delete). Surfaces
 * `-32602` when no config exists under that key so callers can distinguish a
 * stale id from a successful no-op (matches `CancelTask` style).
 */
export function createTaskPushNotificationConfigDeleteHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, null> {
  const { storage } = options;

  return (params: unknown): null => {
    const validated = validateDeleteParams(params);
    const removed = storage.deletePushConfig(validated.taskId, validated.id);
    if (!removed) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'push notification config not found'
      );
    }
    return null;
  };
}

function requireParamsObject(
  params: unknown,
  label: string
): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      `invalid params: expected ${label} object`
    );
  }
  return params as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      `invalid params: ${key} is required and must be a non-empty string`
    );
  }
  return value;
}

function validateSetParams(
  params: unknown
): TaskPushNotificationConfig & { readonly taskId: string } {
  const obj = requireParamsObject(params, 'TaskPushNotificationConfig');
  const taskId = requireString(obj, 'taskId');
  return { ...validatePushNotificationConfig(obj), taskId };
}

function validatePushNotificationConfig(
  obj: Record<string, unknown>
): TaskPushNotificationConfig {
  const url = obj['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: url is required and must be a non-empty string'
    );
  }

  const out: {
    -readonly [
      K in keyof TaskPushNotificationConfig
    ]: TaskPushNotificationConfig[K];
  } = { url };

  const rawId = obj['id'];
  if (rawId !== undefined) {
    if (typeof rawId !== 'string' || rawId.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: id must be a non-empty string when provided'
      );
    }
    out.id = rawId;
  }

  const rawToken = obj['token'];
  if (rawToken !== undefined) {
    if (typeof rawToken !== 'string') {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: token must be a string when provided'
      );
    }
    out.token = rawToken;
  }

  const rawAuth = obj['authentication'];
  if (rawAuth !== undefined) {
    if (
      rawAuth === null ||
      typeof rawAuth !== 'object' ||
      Array.isArray(rawAuth)
    ) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: authentication must be an object when provided'
      );
    }
    out.authentication = validateAuthenticationInfo(
      rawAuth as Record<string, unknown>
    );
  }

  return out;
}

function validateAuthenticationInfo(
  obj: Record<string, unknown>
): AuthenticationInfo {
  const scheme = obj['scheme'];
  if (typeof scheme !== 'string' || scheme.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: authentication.scheme must be a non-empty string'
    );
  }

  const out: {
    -readonly [K in keyof AuthenticationInfo]: AuthenticationInfo[K];
  } = { scheme };

  const rawCredentials = obj['credentials'];
  if (rawCredentials !== undefined) {
    if (typeof rawCredentials !== 'string') {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: authentication.credentials must be a string when provided'
      );
    }
    out.credentials = rawCredentials;
  }

  return out;
}

function validateGetParams(
  params: unknown
): GetTaskPushNotificationConfigRequest {
  const obj = requireParamsObject(
    params,
    'GetTaskPushNotificationConfigRequest'
  );
  return { taskId: requireString(obj, 'taskId'), id: requireString(obj, 'id') };
}

function validateListParams(
  params: unknown
): ListTaskPushNotificationConfigsRequest {
  const obj = requireParamsObject(
    params,
    'ListTaskPushNotificationConfigsRequest'
  );
  return { taskId: requireString(obj, 'taskId') };
}

function validateDeleteParams(
  params: unknown
): DeleteTaskPushNotificationConfigRequest {
  const obj = requireParamsObject(
    params,
    'DeleteTaskPushNotificationConfigRequest'
  );
  return { taskId: requireString(obj, 'taskId'), id: requireString(obj, 'id') };
}
