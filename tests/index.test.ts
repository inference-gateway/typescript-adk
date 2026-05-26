import { describe, it, expect } from 'vitest';
import { packageMetadata } from '../src/index.js';

describe('packageMetadata', () => {
  it('exposes the package name', () => {
    expect(packageMetadata.name).toBe('@inference-gateway/adk');
  });

  it('exposes a non-empty version string', () => {
    expect(packageMetadata.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(packageMetadata)).toBe(true);
  });
});
