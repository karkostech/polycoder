import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Blackboard } from "../src/blackboard.js";

test("blackboard journals, contracts and per-role context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polycoder-board-"));
  const board = new Blackboard(dir);
  await board.init();

  await board.appendStatus("frontend", "Plan: build UI");
  await board.appendStatus("backend", "Plan: build API");
  await board.writeContract("api", "# API\nGET /items");

  // frontend sees backend's journal + contract, but NOT its own journal
  const ctxFrontend = await board.contextFor("frontend");
  assert.match(ctxFrontend, /Contract: api/);
  assert.match(ctxFrontend, /Journal of agent "backend"/);
  assert.doesNotMatch(ctxFrontend, /Journal of agent "frontend"/);

  // backend sees frontend's journal
  const ctxBackend = await board.contextFor("backend");
  assert.match(ctxBackend, /Journal of agent "frontend"/);

  // contracts listed + readable
  assert.deepEqual(await board.listContracts(), ["api"]);
  assert.match((await board.readContract("api"))!, /GET \/items/);

  // contract names are sanitized
  await board.writeContract("My Weird Contract!", "x");
  const names = await board.listContracts();
  assert.ok(names.includes("my-weird-contract-"));

  // journal entries accumulate
  await board.appendStatus("frontend", "Done: UI built");
  const journal = await fs.readFile(board.statusPath("frontend"), "utf8");
  assert.match(journal, /Plan: build UI/);
  assert.match(journal, /Done: UI built/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("empty blackboard context says so", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polycoder-board-"));
  const board = new Blackboard(dir);
  const ctx = await board.contextFor("nobody");
  assert.match(ctx, /empty/i);
  await fs.rm(dir, { recursive: true, force: true });
});
