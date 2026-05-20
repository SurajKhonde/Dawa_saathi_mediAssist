/**
 * Sleep for ms milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Retry an async function with exponential backoff.
 * Used for transient failures (network, rate limits, etc).
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    onAttemptFail?: (attempt: number, error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 500,
    maxDelayMs = 8000,
    onAttemptFail,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !shouldRetry(err)) break;
      onAttemptFail?.(attempt, err);
      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Generate a short random ID for request tracing.
 */
export function genReqId(): string {
  return Math.random().toString(36).slice(2, 10);
}
