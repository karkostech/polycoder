import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyOps,
  extractJsonObject,
  parseAgentOutput,
  pathAllowedByScope,
  FileOpError,
} from "../src/fileops.js";

test("extractJsonObject finds a balanced object in prose", () => {
  const text = 'Sure! Here you go:\n```json\n{"a": {"b": "}"}, "c": 1}\n```\nDone.';
  const obj = extractJsonObject(text);
  assert.deepEqual(JSON.parse(obj), { a: { b: "}" }, c: 1 });
});

test("extractJsonObject throws without any object", () => {
  assert.throws(() => extractJsonObject("no json here"), FileOpError);
});

test("parseAgentOutput parses summary + ops and normalizes paths", () => {
  const out = parseAgentOutput(
    JSON.stringify({
      summary: "did things",
      ops: [
        { type: "write", path: ".\\src\\a.ts", content: "x" },
        { type: "delete", path: "old.ts" },
        { type: "note", text: "hi" },
        { type: "contract", name: "api", content: "c" },
      ],
    }),
  );
  assert.equal(out.summary, "did things");
  assert.equal(out.ops.length, 4);
  assert.equal(out.ops[0]!.type, "write");
  if (out.ops[0]!.type === "write") assert.equal(out.ops[0]!.path, "src/a.ts");
});

test("parseAgentOutput rejects missing ops array", () => {
  assert.throws(() => parseAgentOutput('{"summary":"x"}'), /ops/);
});

test("parseAgentOutput rejects unknown op type", () => {
  assert.throws(
    () => parseAgentOutput('{"summary":"x","ops":[{"type":"hack"}]}'),
    /unknown type/,
  );
});

test("pathAllowedByScope respects prefixes", () => {
  assert.equal(pathAllowedByScope("web/app.js", ["web/"]), true);
  assert.equal(pathAllowedByScope("server/s.js", ["web/"]), false);
  assert.equal(pathAllowedByScope("web", ["web/"]), true);
  assert.equal(pathAllowedByScope("anything/x", []), true);
});

test("applyOps writes, deletes, skips out-of-scope and blocks traversal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chalkcode-ops-"));
  const res = await applyOps(
    dir,
    [
      { type: "write", path: "web/app.js", content: "console.log(1)" },
      { type: "write", path: "server/evil.js", content: "x" },
      { type: "write", path: "../escape.txt", content: "x" },
      { type: "note", text: "done" },
      { type: "contract", name: "api", content: "# api" },
      { type: "delete", path: "web/gone.js" },
    ],
    ["web/"],
  );

  const written = await fs.readFile(path.join(dir, "web", "app.js"), "utf8");
  assert.equal(written, "console.log(1)");
  assert.deepEqual(res.filesChanged.sort(), ["web/app.js", "web/gone.js"].sort());
  assert.equal(res.skipped.length, 2);
  assert.ok(res.skipped.some((s) => s.path === "server/evil.js"));
  assert.ok(res.skipped.some((s) => s.path === "../escape.txt"));
  assert.deepEqual(res.notes, ["done"]);
  assert.equal(res.contracts[0]!.name, "api");
  await fs.rm(dir, { recursive: true, force: true });
});
