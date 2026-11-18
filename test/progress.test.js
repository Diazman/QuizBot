import { test } from "node:test";
import assert from "node:assert/strict";
import { progressText } from "../src/index.js";

const quiz = { title: "test", chunks_total: 4, chunks_done: 1, chunks_failed: 0 };

test("shows every part being read, not just one", () => {
  const now = Date.now();
  const t = progressText(quiz, 12, "", [{ idx: 1, started: now - 40_000 }, { idx: 2, started: now - 10_000 }, { idx: 3, started: now - 5_000 }]);
  assert.match(t, /Parts read: <b>1\/4<\/b>/);
  assert.match(t, /Questions found so far: <b>12<\/b>/);
  assert.match(t, /Reading parts 2, 3 and 4 at the same time… 0:40/);
  const pct = Number(t.match(/(\d+)%/)[1]);
  assert.ok(pct > 25 && pct < 100, `pct ${pct}`);
});

test("single part wording and finished state", () => {
  assert.match(progressText(quiz, 3, "", [{ idx: 3, started: Date.now() }]), /Reading part 4… 0:00/);
  const done = progressText({ ...quiz, chunks_done: 4 }, 40, "", [{ idx: 3, started: Date.now() }]);
  assert.match(done, /100%/);
  assert.match(done, /✅ Done/);
  assert.doesNotMatch(done, /Reading/);
});
