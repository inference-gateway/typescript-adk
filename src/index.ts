import pkg from '../package.json' with { type: 'json' };

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

export const packageMetadata: PackageMetadata = Object.freeze({
  name: pkg.name,
  version: pkg.version,
});

export {
  DEBUG_ENV,
  NODE_ENV_ENV,
  NOOP_LOGGER,
  REQUEST_ID_CONTEXT_KEY,
  REQUEST_ID_HEADER,
  REQUEST_LOGGER_CONTEXT_KEY,
  SERVER_DISABLE_HEALTHCHECK_LOG_ENV,
  childLogger,
  createLogger,
  createRequestLoggerMiddleware,
} from './logging/index.js';
export type {
  CreateLoggerOptions,
  Logger,
  RequestLoggerMiddlewareOptions,
} from './logging/index.js';

export * from './types/index.js';
export * from './agent/index.js';
export * from './artifacts/index.js';
export * from './auth/index.js';
export * from './server/index.js';
export * from './storage/index.js';
export * from './client/index.js';
export * from './llm/index.js';
export * from './telemetry/index.js';
export * from './metrics/index.js';
export * from './tls/index.js';
