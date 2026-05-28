import { describe } from 'vitest';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import { runTaskStorageConformance } from '../../src/testing/index.js';

describe('InMemoryTaskStorage - conformance', () => {
  runTaskStorageConformance({
    createStorage: () => new InMemoryTaskStorage(),
  });
});
