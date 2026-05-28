import type { TaskStorage } from '../storage/task-storage.js';
import type {
  AuthenticationInfo,
  PushNotificationConfig,
  Struct,
  TaskPushNotificationConfig,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A
 * `tasks/pushNotificationConfig/set` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD =
  'tasks/pushNotificationConfig/set';

/**
 * Canonical JSON-RPC method name for the A2A
 * `tasks/pushNotificationConfig/get` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD =
  'tasks/pushNotificationConfig/get';

/**
 * Canonical JSON-RPC method name for the A2A
 * `tasks/pushNotificationConfig/list` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD =
  'tasks/pushNotificationConfig/list';

/**
 * Canonical JSON-RPC method name for the A2A
 * `tasks/pushNotificationConfig/delete` operation.
 */
export const TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD =
  'tasks/pushNotificationConfig/delete';

/**
 * Params accepted by the `tasks/pushNotificationConfig/set` method.
 *
 * Mirrors the Go ADK's `TaskPushNotificationConfig` shape (see
 * `adk/server/task_handler.go:HandleTaskPushNotificationConfigSet`), but uses
 * `taskId` rather than the schema's resource-path `name` for consistency with
 * the rest of the `tasks/*` method family in this ADK.
 *
 * If `pushNotificationConfig.id` is omitted or empty, the handler assigns one
 * via `crypto.randomUUID()` and returns the populated config so the caller can
 * use it as the key for subsequent `get`/`delete` calls.
 */
export interface TaskPushNotificationConfigSetParams {
  readonly taskId: string;
  readonly pushNotificationConfig: PushNotificationConfig;
  readonly metadata?: Struct;
}

/** Params accepted by the `tasks/pushNotificationConfig/get` method. */
export interface TaskPushNotificationConfigGetParams {
  readonly taskId: string;
  readonly pushNotificationConfigId: string;
  readonly metadata?: Struct;
}

/** Params accepted by the `tasks/pushNotificationConfig/list` method. */
export interface TaskPushNotificationConfigListParams {
  readonly taskId: string;
  readonly metadata?: Struct;
}

/**
 * Result of the `tasks/pushNotificationConfig/list` method. The `configs`
 * array is FIFO-ordered by insertion (matches the storage iteration order).
 */
export interface TaskPushNotificationConfigListResult {
  readonly configs: PushNotificationConfig[];
}

/** Params accepted by the `tasks/pushNotificationConfig/delete` method. */
export interface TaskPushNotificationConfigDeleteParams {
  readonly taskId: string;
  readonly pushNotificationConfigId: string;
  readonly metadata?: Struct;
}

export interface TaskPushNotificationConfigHandlerOptions {
  /** Storage backend that persists configs via `setPushConfig` / etc. */
  readonly storage: TaskStorage;
}

/**
 * Build a handler for the A2A `tasks/pushNotificationConfig/set` JSON-RPC
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
 *  - `pushNotificationConfig.url` missing or empty
 *  - `pushNotificationConfig.id` present but not a non-empty string
 *  - `pushNotificationConfig.token` present but not a string
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
    const validated = validateSetParams(params);
    const stored = storage.setPushConfig(
      validated.taskId,
      validated.pushNotificationConfig
    );
    return {
      name: encodeResourceName(validated.taskId, stored.id),
      pushNotificationConfig: stored,
    };
  };
}

/**
 * Build a handler for the A2A `tasks/pushNotificationConfig/get` JSON-RPC
 * method.
 *
 * Returns the wire-format {@link TaskPushNotificationConfig} for the
 * `(taskId, pushNotificationConfigId)` pair, or `-32602` (Invalid Params) when
 * no config is registered under that key. The "not found" path uses
 * `-32602` to match the convention established by `tasks/get`.
 */
export function createTaskPushNotificationConfigGetHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, TaskPushNotificationConfig> {
  const { storage } = options;

  return (params: unknown): TaskPushNotificationConfig => {
    const validated = validateGetParams(params);
    const config = storage.getPushConfig(
      validated.taskId,
      validated.pushNotificationConfigId
    );
    if (config === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'push notification config not found'
      );
    }
    return {
      name: encodeResourceName(
        validated.taskId,
        validated.pushNotificationConfigId
      ),
      pushNotificationConfig: config,
    };
  };
}

/**
 * Build a handler for the A2A `tasks/pushNotificationConfig/list` JSON-RPC
 * method.
 *
 * Returns every config registered under `taskId` as an array. An empty array
 * is returned (rather than an error) for an unknown task id - listing is
 * idempotent and a fresh task with no configs is the common case for the
 * first call.
 */
export function createTaskPushNotificationConfigListHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, TaskPushNotificationConfigListResult> {
  const { storage } = options;

  return (params: unknown): TaskPushNotificationConfigListResult => {
    const validated = validateListParams(params);
    return { configs: storage.listPushConfigs(validated.taskId) };
  };
}

/**
 * Build a handler for the A2A `tasks/pushNotificationConfig/delete` JSON-RPC
 * method.
 *
 * Removes the config at `(taskId, pushNotificationConfigId)`. Returns `null`
 * on success (the A2A schema returns `Empty`/`null` for delete). Surfaces
 * `-32602` when no config exists under that key so callers can distinguish a
 * stale id from a successful no-op (matches `tasks/cancel` style).
 */
export function createTaskPushNotificationConfigDeleteHandler(
  options: TaskPushNotificationConfigHandlerOptions
): MethodHandler<unknown, null> {
  const { storage } = options;

  return (params: unknown): null => {
    const validated = validateDeleteParams(params);
    const removed = storage.deletePushConfig(
      validated.taskId,
      validated.pushNotificationConfigId
    );
    if (!removed) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'push notification config not found'
      );
    }
    return null;
  };
}

function encodeResourceName(taskId: string, configId: string): string {
  return `tasks/${taskId}/pushNotificationConfigs/${configId}`;
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

function optionalMetadata(obj: Record<string, unknown>): Struct | undefined {
  const raw = obj['metadata'];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: metadata must be an object'
    );
  }
  return raw as Struct;
}

function validateSetParams(
  params: unknown
): TaskPushNotificationConfigSetParams {
  const obj = requireParamsObject(
    params,
    'TaskPushNotificationConfigSetParams'
  );
  const taskId = requireString(obj, 'taskId');

  const rawConfig = obj['pushNotificationConfig'];
  if (
    rawConfig === null ||
    typeof rawConfig !== 'object' ||
    Array.isArray(rawConfig)
  ) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: pushNotificationConfig is required and must be an object'
    );
  }
  const configObj = rawConfig as Record<string, unknown>;
  const pushNotificationConfig = validatePushNotificationConfig(configObj);

  const metadata = optionalMetadata(obj);
  if (metadata === undefined) {
    return { taskId, pushNotificationConfig };
  }
  return { taskId, pushNotificationConfig, metadata };
}

function validatePushNotificationConfig(
  obj: Record<string, unknown>
): PushNotificationConfig {
  const url = obj['url'];
  if (typeof url !== 'string' || url.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: pushNotificationConfig.url is required and must be a non-empty string'
    );
  }

  const out: {
    -readonly [K in keyof PushNotificationConfig]: PushNotificationConfig[K];
  } = { url };

  const rawId = obj['id'];
  if (rawId !== undefined) {
    if (typeof rawId !== 'string' || rawId.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pushNotificationConfig.id must be a non-empty string when provided'
      );
    }
    out.id = rawId;
  }

  const rawToken = obj['token'];
  if (rawToken !== undefined) {
    if (typeof rawToken !== 'string') {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pushNotificationConfig.token must be a string when provided'
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
        'invalid params: pushNotificationConfig.authentication must be an object when provided'
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
  const rawSchemes = obj['schemes'];
  if (!Array.isArray(rawSchemes)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: pushNotificationConfig.authentication.schemes must be an array of strings'
    );
  }
  const schemes: string[] = [];
  for (const scheme of rawSchemes) {
    if (typeof scheme !== 'string' || scheme.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pushNotificationConfig.authentication.schemes must contain non-empty strings'
      );
    }
    schemes.push(scheme);
  }

  const out: {
    -readonly [K in keyof AuthenticationInfo]: AuthenticationInfo[K];
  } = { schemes };

  const rawCredentials = obj['credentials'];
  if (rawCredentials !== undefined) {
    if (typeof rawCredentials !== 'string') {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pushNotificationConfig.authentication.credentials must be a string when provided'
      );
    }
    out.credentials = rawCredentials;
  }

  return out;
}

function validateGetParams(
  params: unknown
): TaskPushNotificationConfigGetParams {
  const obj = requireParamsObject(
    params,
    'TaskPushNotificationConfigGetParams'
  );
  const taskId = requireString(obj, 'taskId');
  const pushNotificationConfigId = requireString(
    obj,
    'pushNotificationConfigId'
  );
  const metadata = optionalMetadata(obj);
  if (metadata === undefined) {
    return { taskId, pushNotificationConfigId };
  }
  return { taskId, pushNotificationConfigId, metadata };
}

function validateListParams(
  params: unknown
): TaskPushNotificationConfigListParams {
  const obj = requireParamsObject(
    params,
    'TaskPushNotificationConfigListParams'
  );
  const taskId = requireString(obj, 'taskId');
  const metadata = optionalMetadata(obj);
  if (metadata === undefined) {
    return { taskId };
  }
  return { taskId, metadata };
}

function validateDeleteParams(
  params: unknown
): TaskPushNotificationConfigDeleteParams {
  const obj = requireParamsObject(
    params,
    'TaskPushNotificationConfigDeleteParams'
  );
  const taskId = requireString(obj, 'taskId');
  const pushNotificationConfigId = requireString(
    obj,
    'pushNotificationConfigId'
  );
  const metadata = optionalMetadata(obj);
  if (metadata === undefined) {
    return { taskId, pushNotificationConfigId };
  }
  return { taskId, pushNotificationConfigId, metadata };
}
