import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CachedCatalog } from "../src/adapters/cached-catalog.ts";
import type { Clock } from "../src/ports/clock.ts";

const posix = platform() !== "win32";

class FakeClock implements Clock {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }
  advanceTo(ms: number): void {
    this.current = ms;
  }
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "kankaku-cached-catalog-"));
}

const CLIENTS = [{ id: "c1", name: "Acme", code: "acme", active: true }];
const PROJECTS = [{ id: "p1", name: "Portal", clientId: "c1", repoPaths: [], active: true }];

test("read returns undefined when no cache file exists", () => {
  const dir = makeDir();
  try {
    const catalog = new CachedCatalog({
      filePath: join(dir, "catalog.json"),
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    assert.equal(catalog.read(), undefined);
    assert.equal(catalog.isStale(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh fetches, caches to disk, and read returns the snapshot", async () => {
  const dir = makeDir();
  try {
    const clock = new FakeClock(1000);
    let fetchCalls = 0;
    const catalog = new CachedCatalog({
      filePath: join(dir, "catalog.json"),
      url: "https://pb.example.com",
      clock,
      fetchCatalog: async () => {
        fetchCalls += 1;
        return { clients: CLIENTS, projects: PROJECTS };
      },
    });

    const snapshot = await catalog.refresh();

    assert.equal(fetchCalls, 1);
    assert.deepEqual(snapshot, { fetchedAt: 1000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS });
    assert.deepEqual(catalog.read(), snapshot);

    const onDisk = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    assert.deepEqual(onDisk, snapshot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh writes the cache file with mode 0o600 (F4 — this file lives under ~/.kankaku)", { skip: !posix }, async () => {
  const dir = makeDir();
  try {
    const catalog = new CachedCatalog({
      filePath: join(dir, "catalog.json"),
      url: "https://pb.example.com",
      clock: new FakeClock(1000),
      fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
    });

    await catalog.refresh();

    assert.equal(statSync(join(dir, "catalog.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh instance reads a previously written cache file from disk", async () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    const first = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(5000),
      fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
    });
    await first.refresh();

    const second = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(5000),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    assert.deepEqual(second.read(), { fetchedAt: 5000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache written for a different url is ignored", async () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    writeFileSync(filePath, JSON.stringify({ fetchedAt: 1, url: "https://other.example.com", clients: CLIENTS, projects: PROJECTS }));

    const catalog = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    assert.equal(catalog.read(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isStale is true when fetchedAt is older than the TTL, false otherwise", async () => {
  const dir = makeDir();
  try {
    const clock = new FakeClock(0);
    const catalog = new CachedCatalog({
      filePath: join(dir, "catalog.json"),
      url: "https://pb.example.com",
      clock,
      ttlMs: 1000,
      fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
    });
    await catalog.refresh();

    clock.advanceTo(500);
    assert.equal(catalog.isStale(), false);

    clock.advanceTo(1500);
    assert.equal(catalog.isStale(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh never throws: a failing fetchCatalog resolves undefined and leaves the cache untouched", async () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    const seeded = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
    });
    await seeded.refresh();

    const failing = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => {
        throw new Error("network down");
      },
    });

    const result = await failing.refresh();

    assert.equal(result, undefined);
    assert.deepEqual(failing.read(), { fetchedAt: 0, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "refresh never tightens the mode of an already-existing ~/.kankaku-shaped directory (R2 — cwd === $HOME makes it the same path as a project's own default KANKAKU_DIR, which must never be tightened)",
  { skip: !posix },
  async () => {
    const dir = makeDir();
    try {
      // Simulate a project's own `.kankaku` dir already sitting at this
      // exact path (the case when pi runs with cwd === $HOME and the
      // project uses the default relative KANKAKU_DIR) with a looser,
      // group/world-readable mode a project dir is allowed to have.
      // `makeDir()` already created `dir` (mkdtemp always uses 0700), so an
      // explicit chmod is needed — `mkdirSync`'s own `mode` option only
      // applies to a directory it actually creates, never one that exists.
      chmodSync(dir, 0o755);
      assert.equal(statSync(dir).mode & 0o777, 0o755);

      const catalog = new CachedCatalog({
        filePath: join(dir, "catalog.json"),
        url: "https://pb.example.com",
        clock: new FakeClock(1000),
        fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
      });

      await catalog.refresh();

      // The directory's mode must be completely untouched...
      assert.equal(statSync(dir).mode & 0o777, 0o755);
      // ...while the catalog cache FILE itself is still always written 0600.
      assert.equal(statSync(join(dir, "catalog.json")).mode & 0o777, 0o600);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "refresh creates a brand-new cache directory 0700 when kankaku itself is the first writer (G3)",
  { skip: !posix },
  async () => {
    const dir = makeDir();
    try {
      // Unlike the other tests, the cache directory itself does not exist
      // yet — `makeDir()` only creates the scratch root, and `catalogDir`
      // below is a fresh, never-created subdirectory. This is the "kankaku
      // is the first writer" branch (R2's sibling rule): when kankaku
      // itself creates `~/.kankaku`, it must create it owner-only (0700),
      // not whatever the umask default happens to be.
      const catalogDir = join(dir, "fresh-home", ".kankaku");
      const catalog = new CachedCatalog({
        filePath: join(catalogDir, "catalog.json"),
        url: "https://pb.example.com",
        clock: new FakeClock(1000),
        fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS }),
      });

      await catalog.refresh();

      assert.equal(statSync(catalogDir).mode & 0o777, 0o700);
      assert.equal(statSync(join(catalogDir, "catalog.json")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("readDisk tolerates malformed JSON and a structurally invalid snapshot", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    writeFileSync(filePath, "{not json");
    const catalog = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });
    assert.equal(catalog.read(), undefined);

    writeFileSync(filePath, JSON.stringify({ fetchedAt: "not a number", url: "https://pb.example.com" }));
    const catalog2 = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });
    assert.equal(catalog2.read(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TASKS = [{ id: "t1", title: "Fix the thing", projectId: "p1", status: "open" as const }];

test("an old cache file written before hub task linking (no tasks field) still reads", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    writeFileSync(filePath, JSON.stringify({ fetchedAt: 1000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS }));
    const catalog = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    const snapshot = catalog.read();
    assert.equal(snapshot?.tasks, undefined);
    assert.deepEqual(snapshot, { fetchedAt: 1000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache file with a valid tasks array reads it back", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    writeFileSync(filePath, JSON.stringify({ fetchedAt: 1000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS, tasks: TASKS }));
    const catalog = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    assert.deepEqual(catalog.read()?.tasks, TASKS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cache file with a malformed tasks field is rejected, like any other malformed field", () => {
  const dir = makeDir();
  try {
    const filePath = join(dir, "catalog.json");
    writeFileSync(
      filePath,
      JSON.stringify({ fetchedAt: 1000, url: "https://pb.example.com", clients: CLIENTS, projects: PROJECTS, tasks: [{ noId: true }] }),
    );
    const catalog = new CachedCatalog({
      filePath,
      url: "https://pb.example.com",
      clock: new FakeClock(0),
      fetchCatalog: async () => ({ clients: [], projects: [] }),
    });

    assert.equal(catalog.read(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh threads tasks from fetchCatalog through to the snapshot", async () => {
  const dir = makeDir();
  try {
    const catalog = new CachedCatalog({
      filePath: join(dir, "catalog.json"),
      url: "https://pb.example.com",
      clock: new FakeClock(1000),
      fetchCatalog: async () => ({ clients: CLIENTS, projects: PROJECTS, tasks: TASKS }),
    });

    const snapshot = await catalog.refresh();

    assert.deepEqual(snapshot?.tasks, TASKS);
    assert.deepEqual(catalog.read()?.tasks, TASKS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
