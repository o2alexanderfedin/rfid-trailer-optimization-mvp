/**
 * Thrown when an append's `expectedVersion` does not match the stream's current
 * version, or when Postgres rejects the insert with a unique-violation (23505)
 * from a concurrent append racing on the same `(stream_id, version)`.
 */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | undefined,
  ) {
    super(
      `Concurrency conflict on stream "${streamId}": expected version ${expectedVersion}` +
        (actualVersion === undefined ? "" : `, found ${actualVersion}`),
    );
  }
}
