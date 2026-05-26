import pkg from '../package.json' with { type: 'json' };

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

export const packageMetadata: PackageMetadata = Object.freeze({
  name: pkg.name,
  version: pkg.version,
});

export * from './types/index.js';
export * from './agent/index.js';
export * from './server/index.js';
export * from './storage/index.js';
