import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DAY, run, runCli, session, snapshot, world } from "./helpers.mjs";

const A = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const C = "cccccccc-2222-4222-8222-cccccccccccc";
const D = "dddddddd-2222-4222-8222-dddddddddddd";

test("list --since keeps sessions whose last activity is within the last N days", async () => {
  const w = world("since-window");
  session(w, { id: A, ageDays: 0.5 });
  session(w, { id: B, ageDays: 6.9 });
  session(w, { id: C, ageDays: 7.1 });
  // A recently touched file whose records are old: last activity, not the file time, decides.
  session(w, { id: D, ageDays: 1, stampDays: 20 });
  const before = snapshot(w.claude);
  for (const [days, expected] of [["1", [A]], ["6", [A]], ["7", [A, B]], ["8", [A, B, C]], ["30", [A, B, C, D]]]) {
    const r = await run(["list", "--all", "--since", days, "--json"], w);
    assert.equal(r.code, 0, r.all);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.sessions.map((s) => s.id).sort(), expected);
    assert.equal(j.since, Number(days));
    assert.equal(j.matched, j.sessions.length);
    assert.equal(j.total, 4);
  }
  const none = JSON.parse((await run(["list", "--all", "--json"], w)).out);
  assert.ok(!("since" in none), "JSON has since only when the filter is used");
  assert.ok(!("matched" in none));
  assert.deepEqual(snapshot(w.claude), before, "listing never changes files or modification times");
});

test("list --since filters before limits for every sort and combines with project, title and due", async () => {
  const w = world("since-limit");
  const a = session(w, { id: A, project: "shop", prompt: "Stripe setup", prompts: 10, ageDays: 1, companions: true });
  fs.rmSync(path.join(a.dir, A, "custom-title.json")); // so the title comes from the first prompt
  session(w, { id: B, project: "shop", prompt: "Stripe migration", prompts: 2, ageDays: 25 });
  session(w, { id: C, project: "shop", prompt: "unrelated", prompts: 1, ageDays: 2 });
  session(w, { id: D, project: "other", prompt: "Stripe elsewhere", ageDays: 26 });
  const before = snapshot(w.claude);
  for (const sort of ["age", "size", "prompts"]) {
    const all = JSON.parse((await run(["list", "--sort", sort, "--json"], w, { cwd: a.root })).out);
    const r = await run(["list", "--sort", sort, "--since", "3", "--limit", "1", "--json"], w, { cwd: a.root });
    assert.equal(r.code, 0, r.all);
    const j = JSON.parse(r.out);
    assert.equal(j.total, 3);
    assert.equal(j.matched, 2);
    assert.equal(j.shown, 1);
    assert.equal(j.since, 3);
    assert.deepEqual(j.sessions, all.sessions.filter((s) => [A, C].includes(s.id)).slice(0, 1));
    const titled = JSON.parse((await run(["list", "--project", a.root, "--sort", sort, "--since", "3", "--title", "stripe", "--json"], w)).out);
    assert.deepEqual(titled.sessions.map((s) => s.id), [A]);
    assert.equal(titled.matched, 1);
    const due = JSON.parse((await run(["list", "--project", a.root, "--sort", sort, "--since", "28", "--due", "7", "--json"], w)).out);
    assert.deepEqual(due.sessions.map((s) => s.id), [B]);
    assert.equal(due.matched, 1);
  }
  const everywhere = JSON.parse((await run(["list", "--all", "--since", "28", "--due", "7", "--title", "stripe", "--json"], w)).out);
  assert.deepEqual(everywhere.sessions.map((s) => s.id).sort(), [B, D]);
  assert.deepEqual(snapshot(w.claude), before);
});

test("list --since explains matching and shown counts in text and markdown", async () => {
  const w = world("since-header");
  const a = session(w, { id: A, prompt: "Stripe setup", ageDays: 1 });
  session(w, { id: B, prompt: "Stripe migration", ageDays: 2 });
  session(w, { id: C, prompt: "Stripe old", ageDays: 25 });
  for (const format of [[], ["--markdown"]]) {
    const r = await run(["list", "--since", "7", ...format], w, { cwd: a.root });
    assert.equal(r.code, 0, r.all);
    assert.ok(r.out.includes("(2 active in the last 7 days, of 3, newest first)"), r.out);
    const limited = await run(["list", "--since", "7", "--limit", "1", ...format], w, { cwd: a.root });
    assert.ok(limited.out.includes("(1 of 2 active in the last 7 days, of 3, newest first)"));
    const one = await run(["list", "--since", "1", ...format], w, { cwd: a.root });
    assert.ok(one.out.includes("active in the last 1 day, of 3"));
    const titled = await run(["list", "--title", "stripe", "--since", "30", "--due", "7", ...format], w, { cwd: a.root });
    assert.ok(titled.out.includes('(1 matching "stripe", active in the last 30 days, due within 7 days, of 3, newest first)'), titled.out);
    const empty = await run(["list", "--since", "1", "--title", "missing", ...format], w, { cwd: a.root });
    assert.equal(empty.code, 0);
    assert.ok(empty.out.includes('(0 matching "missing", active in the last 1 day, of 3, newest first)'));
    assert.match(empty.out, /No sessions\./);
    assert.ok(!empty.out.includes("No Claude Code sessions found"));
  }
  const empty = JSON.parse((await run(["list", "--all", "--since", "1", "--title", "missing", "--json"], w)).out);
  assert.equal(empty.matched, 0);
  assert.equal(empty.total, 3);
  assert.deepEqual(empty.sessions, []);
});

test("list --since rejects anything but a whole number of 1 or more as a usage error", async () => {
  const w = world("since-invalid");
  session(w, { id: A });
  const before = snapshot(w.claude);
  for (const value of ["0", "-1", "1.5", "abc", "", " 3", "1e2"]) {
    for (const json of [[], ["--json"]]) {
      const r = await run(["list", `--since=${value}`, ...json], w);
      assert.equal(r.code, 1, `${value}: ${r.all}`);
      assert.match(json.length ? JSON.parse(r.out).error : r.err, /--since needs a whole number, 1 or more/);
      assert.ok(!r.all.includes("unexpected error"));
    }
  }
  const missing = await run(["list", "--since"], w);
  assert.equal(missing.code, 1, "a missing argument follows the existing parser contract");
  assert.match(missing.err, /--since needs a value/);
  assert.deepEqual(snapshot(w.claude), before);
});

test("list --since works in the real CLI with an isolated config", async () => {
  const w = world("since-process");
  // The child process uses the real clock, not NOW.
  session(w, { id: A, mtime: Date.now() - 0.5 * DAY });
  session(w, { id: B, mtime: Date.now() - 3 * DAY });
  const before = snapshot(w.claude);
  const r = runCli(["list", "--all", "--since", "1", "--json"], { cwd: w.base, env: w.env });
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(JSON.parse(r.out).sessions.map((s) => s.id), [A]);
  const invalid = runCli(["list", "--since=0", "--json"], { cwd: w.base, env: w.env });
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.out).error, /--since needs a whole number/);
  assert.deepEqual(snapshot(w.claude), before);
});
