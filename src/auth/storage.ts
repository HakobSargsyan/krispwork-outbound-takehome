/**
 * In-memory TTL store for codes/tokens/pending logins. Lost on restart
 * and not shared across processes -- fine for a take-home, not for prod.
 */

export class TTLStore<V> {
  private items = new Map<string, { expiresAt: number; value: V }>();

  put(key: string, value: V, ttlSeconds: number): void {
    this.items.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, value });
  }

  get(key: string): V | undefined {
    const entry = this.items.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return entry.value;
  }

  pop(key: string): V | undefined {
    const value = this.get(key);
    if (value !== undefined) this.items.delete(key);
    return value;
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}
