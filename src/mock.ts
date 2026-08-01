/**
 * Offline mock provider — deterministic "AI" that follows the exact same
 * protocols as real models. Used by `polycoder run --demo`, tests and CI:
 * the whole pipeline (plan → build → merge → integrate → report) can be
 * exercised with zero API keys and zero network.
 */
import { setMockResponder } from "./provider.js";
import { ChatMessage } from "./types.js";

function roleFromSystem(system: string): string {
  const m = system.match(/You are the "([^"]+)" coding agent/);
  return m?.[1] ?? "role";
}

function json(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function planFor(role: string): string {
  const contracts: Record<string, { name: string; content: string }> = {
    frontend: {
      name: "ui-api",
      content:
        "The frontend expects a REST endpoint `GET /api/items` returning `[{ \"id\": number, \"title\": string, \"done\": boolean }]` and `POST /api/items` accepting `{ \"title\": string }`. Served from the same origin; no auth in this demo.",
    },
    backend: {
      name: "api",
      content:
        "Backend exposes `GET /api/items` → `200 [{ id, title, done }]`, `POST /api/items` (body `{ title }`) → `201 { id, title, done }`, `POST /api/items/:id/toggle` → `200 { id, title, done }`. JSON over HTTP on port 3000.",
    },
    database: {
      name: "db-schema",
      content:
        "Table `items`: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `title TEXT NOT NULL`, `done INTEGER NOT NULL DEFAULT 0`. Access through `db.js` exporting `all()`, `add(title)`, `toggle(id)`.",
    },
  };
  const c = contracts[role] ?? {
    name: `${role}-contract`,
    content: `${role} exposes its interface as documented in its files.`,
  };
  return json({
    summary: `Plan for ${role}: build the ${role} part of the demo app, expose the interface as a contract, keep it minimal and working.`,
    ops: [
      { type: "contract", name: c.name, content: c.content },
      {
        type: "note",
        text: `${role} agent starting. I will deliver my part under my scope and follow the contracts on the blackboard.`,
      },
    ],
  });
}

function buildFor(role: string): string {
  if (role === "frontend") {
    return json({
      summary:
        "Built a small vanilla-JS todo UI (index.html + style.css + app.js) that talks to the backend via the api contract (GET/POST /api/items).",
      ops: [
        {
          type: "write",
          path: "web/index.html",
          content:
            '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>PolyCoder Demo — Todo</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>Todo</h1>\n    <form id="add-form">\n      <input id="title" placeholder="What needs doing?" required>\n      <button type="submit">Add</button>\n    </form>\n    <ul id="items"></ul>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n',
        },
        {
          type: "write",
          path: "web/style.css",
          content:
            "body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 32rem; }\ninput { padding: .5rem; flex: 1; }\nbutton { padding: .5rem 1rem; }\nform { display: flex; gap: .5rem; }\nli.done span { text-decoration: line-through; opacity: .6; }\n",
        },
        {
          type: "write",
          path: "web/app.js",
          content:
            'async function load() {\n  const res = await fetch("/api/items");\n  const items = await res.json();\n  const ul = document.getElementById("items");\n  ul.innerHTML = "";\n  for (const item of items) {\n    const li = document.createElement("li");\n    li.className = item.done ? "done" : "";\n    const span = document.createElement("span");\n    span.textContent = item.title;\n    li.appendChild(span);\n    li.addEventListener("click", async () => {\n      await fetch(`/api/items/${item.id}/toggle`, { method: "POST" });\n      load();\n    });\n    ul.appendChild(li);\n  }\n}\n\ndocument.getElementById("add-form").addEventListener("submit", async (e) => {\n  e.preventDefault();\n  const input = document.getElementById("title");\n  await fetch("/api/items", {\n    method: "POST",\n    headers: { "content-type": "application/json" },\n    body: JSON.stringify({ title: input.value }),\n  });\n  input.value = "";\n  load();\n});\n\nload();\n',
        },
        {
          type: "note",
          text: "Frontend done: static files in web/, expects the backend to serve them and to implement the ui-api contract.",
        },
      ],
    });
  }
  if (role === "backend") {
    return json({
      summary:
        "Built a zero-dependency Node HTTP server (server/server.js) implementing the api contract on port 3000, delegating persistence to db/db.js per the db-schema contract, and serving web/ statically.",
      ops: [
        {
          type: "write",
          path: "server/server.js",
          content:
            'const http = require("node:http");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst db = require("../db/db.js");\n\nconst WEB = path.join(__dirname, "..", "web");\n\nfunction send(res, code, body, type = "application/json") {\n  res.writeHead(code, { "content-type": type });\n  res.end(typeof body === "string" ? body : JSON.stringify(body));\n}\n\nconst server = http.createServer((req, res) => {\n  const url = new URL(req.url, "http://localhost");\n\n  if (req.method === "GET" && url.pathname === "/api/items") {\n    return send(res, 200, db.all());\n  }\n  if (req.method === "POST" && url.pathname === "/api/items") {\n    let raw = "";\n    req.on("data", (c) => (raw += c));\n    req.on("end", () => {\n      const { title } = JSON.parse(raw || "{}");\n      if (!title) return send(res, 400, { error: "title required" });\n      send(res, 201, db.add(title));\n    });\n    return;\n  }\n  const toggle = url.pathname.match(/^\\/api\\/items\\/(\\d+)\\/toggle$/);\n  if (req.method === "POST" && toggle) {\n    return send(res, 200, db.toggle(Number(toggle[1])));\n  }\n\n  // static files\n  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);\n  const file = path.join(WEB, rel);\n  if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {\n    const ext = path.extname(file);\n    const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";\n    return send(res, 200, fs.readFileSync(file, "utf8"), type);\n  }\n  send(res, 404, { error: "not found" });\n});\n\nserver.listen(3000, () => console.log("listening on http://localhost:3000"));\n',
        },
        {
          type: "note",
          text: "Backend done: server/server.js on :3000. Uses db/db.js (all/add/toggle) per db-schema contract and serves web/ statically.",
        },
      ],
    });
  }
  if (role === "database") {
    return json({
      summary:
        "Built the persistence layer: schema.sql per the db-schema contract and db/db.js — a tiny JSON-file store exposing all()/add(title)/toggle(id) with the exact shapes the backend expects.",
      ops: [
        {
          type: "write",
          path: "db/schema.sql",
          content:
            "CREATE TABLE IF NOT EXISTS items (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  title TEXT NOT NULL,\n  done INTEGER NOT NULL DEFAULT 0\n);\n",
        },
        {
          type: "write",
          path: "db/db.js",
          content:
            '// Minimal JSON-file store matching the db-schema contract.\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst FILE = path.join(__dirname, "data.json");\n\nfunction read() {\n  if (!fs.existsSync(FILE)) return [];\n  return JSON.parse(fs.readFileSync(FILE, "utf8"));\n}\nfunction write(rows) {\n  fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));\n}\n\nexports.all = function all() {\n  return read();\n};\n\nexports.add = function add(title) {\n  const rows = read();\n  const item = { id: rows.length ? Math.max(...rows.map((r) => r.id)) + 1 : 1, title, done: false };\n  rows.push(item);\n  write(rows);\n  return item;\n};\n\nexports.toggle = function toggle(id) {\n  const rows = read();\n  const item = rows.find((r) => r.id === id);\n  if (!item) throw new Error(`item ${id} not found`);\n  item.done = !item.done;\n  write(rows);\n  return item;\n};\n',
        },
        {
          type: "note",
          text: "Database done: db/db.js (all/add/toggle) + db/schema.sql. Shape: { id:number, title:string, done:boolean } — matches the api contract.",
        },
      ],
    });
  }
  // Generic fallback for any other role.
  return json({
    summary: `Built the ${role} part of the project with a minimal working implementation.`,
    ops: [
      {
        type: "write",
        path: `${role}/README.md`,
        content: `# ${role}\n\nImplemented by the ${role} agent (mock provider).\n`,
      },
      { type: "note", text: `${role} done (generic mock output).` },
    ],
  });
}

function integrate(): string {
  return json({
    summary:
      "Wired the app together: added a root package.json with a start script and a README explaining how the three parts (web/, server/, db/) fit per the contracts. All parts already matched their contracts — no fixes needed.",
    ops: [
      {
        type: "write",
        path: "package.json",
        content:
          '{\n  "name": "polycoder-demo-app",\n  "private": true,\n  "version": "1.0.0",\n  "description": "Demo todo app generated by PolyCoder mock agents",\n  "scripts": {\n    "start": "node server/server.js"\n  }\n}\n',
      },
      {
        type: "write",
        path: "README.md",
        content:
          "# Demo Todo App\n\nGenerated by PolyCoder agents:\n\n- `web/` — frontend (vanilla JS), talks to `/api/items`\n- `server/` — Node HTTP server on port 3000, serves the frontend and the REST API\n- `db/` — JSON-file persistence behind `db.js` (`all` / `add` / `toggle`)\n\n## Run\n\n```sh\nnpm start\n# open http://localhost:3000\n```\n",
      },
    ],
  });
}

function resolveConflicts(user: string): string {
  const ops = [];
  const re = /## ([^\n]+)\n```\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(user)) !== null) {
    const file = m[1]!.trim();
    const content = m[2]!
      .replace(/^<<<<<<<.*$/gm, "")
      .replace(/^=======.*$/gm, "")
      .replace(/^>>>>>>>.*$/gm, "");
    ops.push({ type: "write", path: file, content });
  }
  return json({
    summary: `Resolved ${ops.length} conflicted file(s) by removing conflict markers and keeping both sides' content.`,
    ops,
  });
}

export function registerMockResponder(): void {
  setMockResponder((_model: string, messages: ChatMessage[]) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";

    if (user.includes("merge conflicts to resolve")) return resolveConflicts(user);
    if (system.includes("INTEGRATOR agent")) return integrate();
    const role = roleFromSystem(system);
    if (system.includes("PLANNING phase")) return planFor(role);
    return buildFor(role);
  });
}
