/**
 * Thrown when an append's `expectedVersion` does not match the stream's current
 * version (the per-stream CAS guard affects 0 rows), or when Postgres rejects
 * the insert with a unique-violation (23505) from a concurrent append racing on
 * the same `(stream_id, version)` (the backstop guard).
 *
 * Both paths surface as this single typed, retryable error (FND-02 / P4): a
 * caller can catch it, reload the current version, and retry (`appendWithRetry`).
 */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | undefined = undefined,
  ) {
    super(
      `Concurrency conflict on stream "${streamId}": expected version ${expectedVersion}` +
        (actualVersion === undefined ? "" : `, found ${actualVersion}`),
    );
    // Restore prototype chain across the transpiled `extends Error` boundary.
    Object.setPrototypeOf(this, ConcurrencyError.prototype);
  }
}
