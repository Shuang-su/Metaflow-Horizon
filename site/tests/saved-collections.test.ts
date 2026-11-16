import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSavedCollections, addReadLaterId, LEGACY_BOOKMARK_PREFIX, READ_LATER_KEY, SAVED_ARTICLES_KEY, readSavedCollections, writeSavedCollections, type ReadLaterArticle } from "../lib/read-later";
const catalogue: ReadLaterArticle[] = ["a", "b", "c"].map(id => ({ id, title: id, date: "2026-11-16", url: `/articles/${id}/`, kind: "editorial" }));
function memory(values: Record<string, string> = {}) {
  const entries = new Map(Object.entries(values));
  let writes = 0;
  const storage = { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; entries.set(key, value); } } as unknown as Storage;
  return { storage, entries, writes: () => writes };
}
test("v1 queue is copied to favorites once; legacy never resurrects a removed queue entry", () => {
  const v1 = JSON.stringify({ migrated: true, ids: ["b", "unknown"] });
  const { storage, entries, writes } = memory({ [READ_LATER_KEY]: v1, [LEGACY_BOOKMARK_PREFIX + "a"]: "1" });
  const migrated = readSavedCollections(storage, catalogue);
  assert.deepEqual(migrated.readLaterIds, ["b", "unknown"]);
  assert.deepEqual(migrated.favoriteIds, ["b", "unknown", "a"]);
  assert.equal(writes(), 1);
  assert.equal(entries.get(READ_LATER_KEY), v1);
  writeSavedCollections(storage, { ...migrated, favoriteIds: [], readLaterIds: [] });
  assert.deepEqual(readSavedCollections(storage, catalogue), { version: 2, migrated: true, favoriteIds: [], readLaterIds: [] });
  assert.equal(writes(), 2);
});
test("an empty existing v1 list remains empty even before its old migration flag", () => {
  const { storage } = memory({ [READ_LATER_KEY]: JSON.stringify({ ids: [] }), [LEGACY_BOOKMARK_PREFIX + "a"]: "1" });
  const saved = readSavedCollections(storage, catalogue);
  assert.deepEqual(saved.readLaterIds, []);
  assert.deepEqual(saved.favoriteIds, ["a"]);
});
test("legacy only installation seeds both collections; malformed IDs are filtered and duplicates collapse", () => {
  const { storage } = memory({ [LEGACY_BOOKMARK_PREFIX + "a"]: "1" });
  const saved = readSavedCollections(storage, catalogue);
  assert.deepEqual(saved.readLaterIds, ["a"]);
  assert.deepEqual(saved.favoriteIds, ["a"]);
  assert.deepEqual(addReadLaterId(["a"], "a"), ["a"]);
  assert.deepEqual(addReadLaterId(["a"], "b"), ["b", "a"]);
});
test("separate actions read latest shared storage and preserve the other collection", () => {
  const { storage } = memory();
  const firstTab = readSavedCollections(storage, catalogue);
  writeSavedCollections(storage, { ...firstTab, readLaterIds: ["a"] });
  const secondTab = readSavedCollections(storage, catalogue);
  writeSavedCollections(storage, { ...secondTab, favoriteIds: ["b"] });
  assert.deepEqual(readSavedCollections(storage, catalogue), { version: 2, migrated: true, readLaterIds: ["a"], favoriteIds: ["b"] });
});
test("failed migration cannot persist its guard or alter any legacy data", () => {
  const original = JSON.stringify({ ids: ["a"], migrated: true });
  const { storage, entries } = memory({ [READ_LATER_KEY]: original });
  storage.setItem = () => { throw new Error("quota"); };
  const recovered = loadSavedCollections(storage, catalogue);
  assert.equal(recovered.persisted, false);
  assert.deepEqual(recovered.collections.readLaterIds, ["a"]);
  assert.deepEqual(recovered.collections.favoriteIds, ["a"]);
  assert.throws(() => readSavedCollections(storage, catalogue), /could not be persisted/);
  assert.equal(entries.has(SAVED_ARTICLES_KEY), false);
  assert.equal(entries.get(READ_LATER_KEY), original);
});
test("failed writes preserve both previously saved collections", () => {
  const { storage } = memory();
  const saved = readSavedCollections(storage, catalogue);
  storage.setItem = () => { throw new Error("blocked"); };
  assert.throws(() => writeSavedCollections(storage, { ...saved, readLaterIds: ["a"] }), /blocked/);
  assert.deepEqual(readSavedCollections(storage, catalogue), saved);
});

test("failed migration exposes old queue and legacy favorites without reviving queue removals, then retries atomically", () => {
  const original = JSON.stringify({ ids: [], migrated: true });
  const { storage, entries } = memory({ [READ_LATER_KEY]: original, [LEGACY_BOOKMARK_PREFIX + "a"]: "1" });
  const write = storage.setItem;
  storage.setItem = () => { throw new Error("quota"); };
  const recovered = loadSavedCollections(storage, catalogue);
  assert.equal(recovered.persisted, false);
  assert.deepEqual(recovered.collections.readLaterIds, []);
  assert.deepEqual(recovered.collections.favoriteIds, ["a"]);
  assert.equal(entries.has(SAVED_ARTICLES_KEY), false);
  assert.throws(() => writeSavedCollections(storage, { ...recovered.collections, favoriteIds: [] }), /quota/);
  assert.equal(entries.get(READ_LATER_KEY), original);
  storage.setItem = write;
  const retried = loadSavedCollections(storage, catalogue);
  assert.equal(retried.persisted, true);
  assert.deepEqual(retried.collections, recovered.collections);
  assert.deepEqual(JSON.parse(entries.get(SAVED_ARTICLES_KEY)!), recovered.collections);
});
