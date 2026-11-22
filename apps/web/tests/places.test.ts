import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPlaceName, readPlace, sortPlaces } from "../src/lib/place-rules.ts";

test("place names are trimmed, collapsed and bounded", () => {
  assert.equal(cleanPlaceName("  Room   214 "), "Room 214");
  assert.equal(cleanPlaceName(""), null);
  assert.equal(cleanPlaceName("   "), null);
  assert.equal(cleanPlaceName("x".repeat(81)), null);
  assert.equal(cleanPlaceName("Room\u0007"), null);
  assert.equal(cleanPlaceName("x".repeat(80)), "x".repeat(80));
});

test("only well-formed places are kept; unknown categories become other", () => {
  const good = { id: "a", name: "Exit", category: "exit", position: { x: 1, y: 0, z: -2 } };
  assert.deepEqual(readPlace(good), good);
  assert.equal(readPlace({ ...good, category: "dungeon" })?.category, "other");
  for (const bad of [null, 3, {}, { ...good, id: 7 }, { ...good, name: "  " }, { ...good, position: { x: 1, y: 0 } },
    { ...good, position: { x: Number.NaN, y: 0, z: 0 } }, { ...good, position: null }]) {
    assert.equal(readPlace(bad), null, JSON.stringify(bad));
  }
});

test("places sort by name, numbers in order", () => {
  const p = (id: string, name: string) => ({ id, name, category: "room" as const, position: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(sortPlaces([p("1", "Room 10"), p("2", "Exit"), p("3", "Room 2")]).map((x) => x.name), ["Exit", "Room 2", "Room 10"]);
});

