/**
 * Whether `url` carries userinfo (`user:pass@host`). Node's `fetch` refuses
 * such URLs and echoes them, password included, in its error message, so
 * callers reject them up front without repeating the URL.
 */
export function hasCredentials(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && (parsed.username !== '' || parsed.password !== '');
}
