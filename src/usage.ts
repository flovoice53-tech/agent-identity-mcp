// Minimal usage metering: counts tool calls per day, per tool name, kept in
// memory and (on the hosted server) persisted to a small JSON file so counts
// survive a restart. No database, no native deps — day buckets are cheap to
// keep and cheap to serialize.
export interface UsageStats {
  today: Record<string, number>;
  last7Days: Record<string, number>;
  last30Days: Record<string, number>;
  totalCallsLast30Days: number;
  since: string; // date (YYYY-MM-DD) of the first recorded call
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function lastNDates(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export class UsageStore {
  // date -> (toolName -> count)
  private days = new Map<string, Map<string, number>>();
  private firstSeen: string | undefined;

  record(toolName: string): void {
    const date = todayUtc();
    if (!this.firstSeen || date < this.firstSeen) this.firstSeen = date;
    let bucket = this.days.get(date);
    if (!bucket) {
      bucket = new Map();
      this.days.set(date, bucket);
    }
    bucket.set(toolName, (bucket.get(toolName) ?? 0) + 1);
  }

  // Drops day buckets older than keepDays so memory/file size stays bounded
  // for a long-running process.
  prune(keepDays = 35): void {
    const cutoff = lastNDates(keepDays).at(-1);
    if (!cutoff) return;
    for (const date of this.days.keys()) {
      if (date < cutoff) this.days.delete(date);
    }
  }

  private sum(dates: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const date of dates) {
      const bucket = this.days.get(date);
      if (!bucket) continue;
      for (const [tool, count] of bucket) out[tool] = (out[tool] ?? 0) + count;
    }
    return out;
  }

  stats(): UsageStats {
    const today = todayUtc();
    const last7 = this.sum(lastNDates(7));
    const last30 = this.sum(lastNDates(30));
    return {
      today: this.sum([today]),
      last7Days: last7,
      last30Days: last30,
      totalCallsLast30Days: Object.values(last30).reduce((a, b) => a + b, 0),
      since: this.firstSeen ?? today,
    };
  }

  isEmpty(): boolean {
    return this.days.size === 0;
  }

  toJSON(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [date, bucket] of this.days) out[date] = Object.fromEntries(bucket);
    return out;
  }

  static fromJSON(data: Record<string, Record<string, number>>): UsageStore {
    const store = new UsageStore();
    for (const [date, counts] of Object.entries(data)) {
      store.days.set(date, new Map(Object.entries(counts)));
      if (!store.firstSeen || date < store.firstSeen) store.firstSeen = date;
    }
    return store;
  }
}

// Per-API-key usage stores, with periodic JSON persistence to disk. Used
// only by the hosted HTTP server (src/http.ts) — the local stdio server
// keeps a single in-memory UsageStore for the life of the process instead,
// since there's only ever one caller and nothing worth persisting.
export class PersistentUsageStoreRegistry {
  private stores = new Map<string, UsageStore>();
  private dirty = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as Record<string, Record<string, Record<string, number>>>;
      for (const [keyHash, perDay] of Object.entries(data)) {
        this.stores.set(keyHash, UsageStore.fromJSON(perDay));
      }
    } catch (error) {
      // Missing file on first run is expected; anything else is worth a log.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("usage store: failed to load", error);
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const { mkdir, rename, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      const out: Record<string, Record<string, Record<string, number>>> = {};
      for (const [keyHash, store] of this.stores) {
        if (!store.isEmpty()) out[keyHash] = store.toJSON();
      }
      await mkdir(dirname(this.filePath), { recursive: true });
      // Write-then-rename so a crash mid-write can't leave a truncated file
      // that the next load() would fail to parse.
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(out), "utf8");
      await rename(tmp, this.filePath);
    } catch (error) {
      // Retry on the next tick rather than losing the pending counts.
      this.dirty = true;
      console.error("usage store: failed to save", error);
    }
  }

  for(keyHash: string): UsageStore {
    let store = this.stores.get(keyHash);
    if (!store) {
      store = new UsageStore();
      this.stores.set(keyHash, store);
    }
    return store;
  }

  record(keyHash: string, toolName: string): void {
    this.for(keyHash).record(toolName);
    this.dirty = true;
  }

  prune(keepDays = 35): void {
    for (const store of this.stores.values()) store.prune(keepDays);
  }
}
