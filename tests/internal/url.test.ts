import { describe, expect, it } from 'vitest';
import { hasCredentials } from '../../src/internal/url.js';

describe('hasCredentials', () => {
  it.each([
    ['https://user:s3cret@agent.example.com/a2a', true],
    ['https://user@agent.example.com/a2a', true],
    ['https://:s3cret@agent.example.com/a2a', true],
    ['https://agent.example.com/a2a', false],
    ['https://agent.example.com/a2a?token=abc', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(hasCredentials(url)).toBe(expected);
  });
});
