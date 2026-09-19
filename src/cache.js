/**
 * Single-flight cache around the fixture fetch.
 *
 * Calendar clients poll subscribed feeds aggressively, so upstream is hit at
 * most once per TTL. If OpenLigaDB is down we keep serving the last good
 * snapshot: a temporarily stale calendar is far better than a broken one.
 */
export class MatchCache {
  #loader;
  #ttlMs;
  #snapshot = null;
  #loadedAt = 0;
  #inFlight = null;

  constructor(loader, ttlMs) {
    this.#loader = loader;
    this.#ttlMs = ttlMs;
  }

  get isFresh() {
    return this.#snapshot !== null && Date.now() - this.#loadedAt < this.#ttlMs;
  }

  get snapshot() {
    return this.#snapshot;
  }

  /** Resolves to a snapshot, refreshing it when the TTL has expired. */
  async get() {
    if (this.isFresh) return this.#snapshot;
    if (!this.#inFlight) {
      this.#inFlight = this.#loader()
        .then((data) => {
          this.#snapshot = { ...data, stale: false };
          this.#loadedAt = Date.now();
          return this.#snapshot;
        })
        .catch((error) => {
          if (this.#snapshot) {
            console.warn(`[cache] refresh failed, serving stale data: ${error.message}`);
            // Retry in about a minute rather than on every single request. Clamped
            // so a TTL below a minute cannot push the timestamp into the future.
            this.#loadedAt = Date.now() - Math.max(0, this.#ttlMs - 60_000);
            this.#snapshot = { ...this.#snapshot, stale: true };
            return this.#snapshot;
          }
          throw error;
        })
        .finally(() => {
          this.#inFlight = null;
        });
    }
    return this.#inFlight;
  }

  /** Warms the cache in the background; never rejects. */
  async warm() {
    try {
      await this.get();
    } catch (error) {
      console.warn(`[cache] initial warm-up failed: ${error.message}`);
    }
  }
}
