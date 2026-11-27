const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright-core");

const html = readFileSync(join(__dirname, "../index.html"), "utf8");
const app = "http://localhost:45871/";
const repo = "example/group-room";
const branch = "dev/request-001-acceptance";
const scope = repo + "@" + branch;
const backupPath = "workspace/SESSION_BACKUP.json";
const roomKey = "ai_ws_room_v4";
const docsKey = "ai_ws_docs_array_v1";
const bridge = "https://script.google.com/macros/s/mock/exec";
const openai = "https://api.openai.com/v1/chat/completions";
const claude = "https://api.anthropic.com/v1/messages";
const gemini = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const docs = [
  { id: "a", title: "A.md", content: "Original A", gdocUrl: "https://docs.google.com/document/d/mock-a/edit" },
  { id: "b", title: "B.md", content: "Original B", gdocUrl: "https://docs.google.com/document/d/mock-b/edit" }
];
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
});
after(async () => { await browser?.close(); });

async function createRoom(t, options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const files = new Map();
  const calls = [];
  const unexpected = [];
  const errors = [];
  const hooks = {};
  const putFile = (path, content) => {
    const sha = createHash("sha1").update(content).digest("hex");
    files.set(path, { type: "file", content, sha });
  };

  await context.addInitScript(({ options, docsKey, docs, repo, branch }) => {
    // Tests explicitly tick the scheduled callbacks.
    window.setInterval = callback => { window.pollTick = callback; return 1; };
    const originalTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 2500) {
        window.backupTick = callback;
        return 2;
      }
      return originalTimeout(callback, delay, ...args);
    };
    if (!localStorage.getItem("mock-initialized")) {
      localStorage.setItem("mock-initialized", "1");
      if (options.withDocs !== false) localStorage.setItem(docsKey, JSON.stringify(docs));
      if (options.legacy) localStorage.setItem("ai_ws_transcript_v3", JSON.stringify(options.legacy));
      localStorage.setItem("ai_ws_settings_v3", JSON.stringify({ ghRepo: repo, ghBranch: branch, rememberKeys: true }));
      localStorage.setItem("ai_ws_secrets_v3", JSON.stringify({
        ghToken: "mock-token", openaiKey: "mock-openai",
        claudeKey: options.models ? "mock-claude" : "", geminiKey: options.models ? "mock-gemini" : ""
      }));
      localStorage.setItem("ai_ws_gdoc_v1", JSON.stringify({ url: options.bridge || "", secret: "mock-secret" }));
    }
  }, { options, docsKey, docs, repo, branch });

  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON();
    const call = { url: request.url(), method, body, headers: request.headers() };
    const json = (value, status = 200) => route.fulfill({
      status, json: value, headers: { "access-control-allow-origin": "*" }
    });
    if (url.href === app) return route.fulfill({ contentType: "text/html", body: html });
    if (url.hostname === "cdnjs.cloudflare.com") {
      return route.fulfill({ contentType: "text/javascript",
        body: 'window.mammoth = { extractRawText: async () => ({ value: "Mock extracted DOCX" }) };' });
    }
    calls.push(call);
    if ([claude, gemini, openai].includes(url.href)) {
      if (hooks.model) await hooks.model(call);
      if (url.href === claude) return json({ content: [{ type: "text", text: "Mock Claude" }] });
      if (url.href === gemini) return json({ candidates: [{ content: { parts: [{ text: "Mock Gemini" }] } }] });
      return json({ choices: [{ message: { content: "Mock OpenAI" } }] });
    }
    if (url.href === bridge) {
      if (hooks.bridge) await hooks.bridge(call);
      return json(body.action === "pull" ? { title: "Pulled B", content: "Mock pulled content" } : { ok: true });
    }
    const base = "/repos/" + repo;
    if (url.hostname === "api.github.com" && url.pathname.startsWith(base)) {
      if (url.pathname.startsWith(base + "/git/blobs/")) {
        const sha = url.pathname.split("/").at(-1);
        if (hooks.blob && await hooks.blob(sha)) return json({}, 503);
        const file = [...files.values()].find(item => item.sha === sha);
        return file ? json({ content: Buffer.from(file.content).toString("base64") }) : json({}, 404);
      }

      const path = decodeURIComponent(url.pathname.slice((base + "/contents/").length));
      call.path = path;
      if (method === "GET") {
        assert.equal(url.searchParams.get("ref"), branch);
        if (path === "inbox/chatgpt-pro") {
          const entries = [...files.entries()].filter(([name]) => name.startsWith(path + "/"))
            .map(([name, file]) => ({ name: name.split("/").at(-1), sha: file.sha, type: file.type }));
          return entries.length ? json(entries) : json({}, 404);
        }
        const existing = files.get(path);
        if (!existing) return json({}, 404);
        if (call.headers.accept === "application/vnd.github.raw+json") return json(JSON.parse(existing.content));
        return json({ ...existing, encoding: "base64", content: Buffer.from(existing.content).toString("base64") });
      }

      if (method === "PUT") {
        assert.equal(body.branch, branch);
        const existing = files.get(path);
        if (existing && body.sha !== existing.sha) return json({}, 422);
        if (hooks.beforePut && await hooks.beforePut(call)) return json({}, 503);
        putFile(path, Buffer.from(body.content, "base64").toString("utf8"));
        if (hooks.afterPut && await hooks.afterPut(call)) return route.abort();
        return json({}, existing ? 200 : 201);
      }
    }
    unexpected.push(call);
    return route.abort();
  });

  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  t.after(() => {
    assert.deepEqual(unexpected, [], "All requests matched mocks");
    assert.deepEqual(errors, [], "No browser exceptions");
  });
  await page.goto(app);
  await page.waitForFunction(() => !pollInFlight);
  return { page, files, calls, putFile, hooks };
}

const status = page => page.locator("#statusText").textContent();
const settle = page => page.waitForFunction(() => !isRunning && !pollInFlight && !syncInFlight);
const room = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), roomKey);
const turnFiles = files => [...files.keys()].filter(path => path.startsWith("inbox/turns/"));
const getRequests = async page => (await room(page)).inboxes[scope].requests;
const poll = page => page.evaluate(() => pollTick());
const automaticBackup = page => page.evaluate(() => backupTick());
const addReply = (putFile, id, text, inReplyTo) =>
  putFile("inbox/chatgpt-pro/" + id + ".json", JSON.stringify({ id, content: text, inReplyTo }));

test("external mode creates independent, create-only turns and retries an interrupted write", async t => {
  const { page, files, calls, hooks } = await createRoom(t);
  assert.equal(await page.locator("#chatgptMode").inputValue(), "external_pro");

  for (const message of ["First request", "Second request"]) {
    await page.locator("#userInput").fill(message);
    await page.locator("#sendBtn").click();
    await settle(page);
  }
  const [first, second] = turnFiles(files).map(path => JSON.parse(files.get(path).content));
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual([first.latestMessage.text, second.latestMessage.text], ["First request", "Second request"]);
  assert.ok(calls.filter(call => call.method === "PUT").every(call => !Object.hasOwn(call.body, "sha")));

  hooks.beforePut = call => call.path.startsWith("inbox/turns/");
  await page.locator("#chatgptFirstBtn").click();
  await settle(page);
  assert.match(await status(page), /503/);
  const unconfirmed = Object.values(await getRequests(page)).find(request => request.status === "sending");
  assert.ok(unconfirmed);
  hooks.beforePut = null;
  hooks.afterPut = call => call.path.startsWith("inbox/turns/");
  await page.reload();
  await settle(page);
  await page.locator("#chatgptFirstBtn").click();
  await settle(page);
  assert.equal((await getRequests(page))[unconfirmed.id].status, "pending");
  assert.equal(turnFiles(files).length, 3);
  assert.match(await status(page), /turn queued/);
  assert.ok(calls.every(call => new URL(call.url).hostname === "api.github.com"));
});

test("Pause still imports safe replies, deduplicates and correlates out-of-order requests", async t => {
  const { page, calls, files, putFile, hooks } = await createRoom(t, { models: true });
  for (let n = 0; n < 2; n++) {
    await page.locator("#chatgptFirstBtn").click();
    await settle(page);
  }
  const [first, second] = turnFiles(files).map(path => JSON.parse(files.get(path).content).requestId);
  await page.locator("#stopBtn").click();
  const dangerous = '<img src="https://invalid.example/pixel" onerror="window.executed=true"> café 🐾';
  const badText = JSON.stringify({ id: "other-id", content: "Wrong ID" });
  putFile("inbox/chatgpt-pro/wrong-id.json", badText);
  addReply(putFile, "second-reply", dangerous, second);
  addReply(putFile, "unknown-reply", "Unsolicited", "unknown-request");
  const secondSha = files.get("inbox/chatgpt-pro/second-reply.json").sha;
  hooks.blob = sha => sha === secondSha;
  await poll(page);
  assert.equal((await getRequests(page))[second].status, "pending");
  assert.match(await page.locator("#chatBox").textContent(), /Unsolicited/);
  hooks.blob = null;
  await Promise.all([poll(page), poll(page)]);
  assert.deepEqual(Object.values(await getRequests(page)).map(r => r.status), ["pending", "fulfilled"]);
  assert.equal(await page.locator("#chatBox img").count(), 0);
  assert.ok((await page.locator("#chatBox").textContent()).includes(dangerous));

  addReply(putFile, "first-reply", "PASS", first);
  await page.reload();
  await settle(page);
  await poll(page);
  assert.equal(await page.locator(".msg.chatgpt").count(), 3);
  assert.equal((await getRequests(page))[first].replyId, "first-reply");
  assert.match(await status(page), /Paused/);
  assert.equal(calls.filter(call => [openai, claude, gemini].includes(call.url)).length, 0);

  await page.getByRole("button", { name: "Clear Chat" }).click();
  await poll(page);
  assert.equal(await page.locator(".msg.chatgpt").count(), 0);
});

test("an unpaused reply runs only configured room models and Pause stops an in-flight round", async t => {
  const { page, calls, files, putFile, hooks } = await createRoom(t, { models: true });
  await page.locator("#chatgptFirstBtn").click();
  await settle(page);
  const id = JSON.parse(files.get(turnFiles(files)[0]).content).requestId;
  addReply(putFile, "reply", "Ready for review.", id);

  let started;
  const modelStarted = new Promise(resolve => { started = resolve; });
  let release;
  const finishModel = new Promise(resolve => { release = resolve; });
  hooks.model = async call => {
    assert.equal(call.url, claude);
    assert.equal(call.body.model, "claude-sonnet-5-5");
    started();
    await finishModel;
  };
  const pending = poll(page);
  await modelStarted;
  try {
    await page.locator("#stopBtn").click();
  } finally { release(); }
  await pending;
  assert.equal(calls.filter(call => call.url === claude).length, 1);
  assert.equal(calls.filter(call => [gemini, openai].includes(call.url)).length, 0);
  assert.equal(await page.locator(".msg.claude").count(), 0);
  assert.equal(turnFiles(files).length, 1);
  assert.match(await status(page), /Paused/);

  hooks.model = null;
  await page.locator("#continueBtn").click();
  await settle(page);
  const nextId = JSON.parse(files.get(turnFiles(files)[1]).content).requestId;
  addReply(putFile, "next-reply", "Second demo reply", nextId);
  await poll(page);
  assert.ok(calls.some(call => call.url === gemini && call.headers["x-goog-api-key"] === "mock-gemini"));
  assert.equal(calls.filter(call => call.url === openai).length, 0);
  assert.equal(turnFiles(files).length, 2);
});

test("proposal approval stays with its target across tab switches and reloads", async t => {
  const { page, calls, putFile, hooks } = await createRoom(t, { bridge });
  addReply(putFile, "valid", 'Please review. <PROPOSED_DOC target="B.md">New B 🐾</PROPOSED_DOC>');
  addReply(putFile, "missing", '<PROPOSED_DOC target="Missing.md">Wrong target</PROPOSED_DOC>');
  addReply(putFile, "untargeted", '<PROPOSED_DOC>Wrong target</PROPOSED_DOC>');
  await poll(page);
  assert.equal(await page.getByText("Proposal needs an exact, unique tab name").count(), 2);
  assert.equal(calls.filter(call => call.url === bridge).length, 0);
  await page.getByRole("button", { name: "B.md", exact: true }).click();
  await page.getByRole("button", { name: "A.md", exact: true }).click();
  await page.reload();
  await settle(page);
  await page.getByRole("button", { name: "Approve & Apply to Working Doc" }).click();
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Synced"));
  assert.equal(await page.locator("#workingDocContent").inputValue(), "Original A");
  assert.deepEqual(calls.filter(call => call.url === bridge).map(call => call.body),
    [{ key: "mock-secret", docId: "mock-b", content: "New B 🐾" }]);
  assert.equal((await room(page)).workingDocs[1].content, "New B 🐾");
  await automaticBackup(page);
  await settle(page);
  assert.ok(calls.some(call => call.method === "PUT" && call.path === "workspace/B.md"));
  assert.ok(!calls.some(call => call.method === "PUT" && call.path === "workspace/A.md"));
  await page.reload();
  await settle(page);
  assert.equal(await page.getByRole("button", { name: "Applied", exact: true }).isDisabled(), true);

  await page.getByRole("button", { name: "B.md", exact: true }).click();
  let release;
  const finishPull = new Promise(resolve => { release = resolve; });
  hooks.bridge = () => finishPull;
  await page.getByRole("button", { name: "Pull GDoc" }).click();
  await page.getByRole("button", { name: "A.md", exact: true }).click();
  release();
  await page.waitForFunction(() => document.getElementById("statusText").textContent.startsWith("Pulled"));
  assert.equal(await page.locator("#workingDocContent").inputValue(), "Original A");
  assert.equal((await room(page)).workingDocs[1].content, "Mock pulled content");
});

test("automatic chat backup restores all tabs and preserves newer external IDs and replies", async t => {
  const { page, calls, files, putFile } = await createRoom(t);
  await page.getByRole("button", { name: "B.md", exact: true }).click();
  addReply(putFile, "earlier", "Earlier reply");
  await poll(page);
  await automaticBackup(page);
  await settle(page);
  const backup = files.get(backupPath).content;
  const saved = JSON.parse(backup);
  assert.deepEqual(saved.workingDocs, docs);
  assert.equal(saved.activeDocId, "b");
  assert.deepEqual(saved.inboxes[scope].importedExternalIds, ["earlier"]);
  assert.ok(!backup.includes("mock-token") && !backup.includes("mock-secret") && !backup.includes("mock-openai"));
  assert.deepEqual(calls.filter(call => call.method === "PUT").map(call => call.path),
    [backupPath, "transcripts/SHARED_CHAT.md"]);
  addReply(putFile, "later", "Later reply");
  await poll(page);
  await page.getByRole("button", { name: "A.md", exact: true }).click();
  await page.getByRole("button", { name: "Load from GitHub" }).click();
  await page.waitForFunction(() => !restoring);
  assert.match(await status(page), /Workspace restored/);
  assert.equal(await page.locator("#workingDocTitle").inputValue(), "B.md");
  await poll(page);
  assert.equal(await page.locator(".msg.chatgpt").count(), 2);
  assert.deepEqual((await room(page)).inboxes[scope].importedExternalIds, ["earlier", "later"]);

  await page.evaluate(key => localStorage.removeItem(key), roomKey);
  await page.reload();
  await settle(page);
  await page.getByRole("button", { name: "Load from GitHub" }).click();
  await page.waitForFunction(() => !restoring);
  await poll(page);
  assert.equal(await page.locator(".msg.chatgpt").count(), 2);
  assert.equal(await page.locator("#workingDocTitle").inputValue(), "B.md");
});

test("legacy workspace backup, reference files and OpenAI API mode still work", async t => {
  const legacy = [{ css: "human", speaker: "You", text: "Old chat", time: "10:00" }];
  const { page, calls, putFile } = await createRoom(t, { legacy });
  assert.equal(await page.locator(".msg.human").count(), 1);
  putFile(backupPath, JSON.stringify({ transcript: legacy, brief: "Old brief", workTitle: "B.md", workBody: "Legacy B" }));
  await page.getByRole("button", { name: "Load from GitHub" }).click();
  await page.waitForFunction(() => !restoring);
  assert.equal(await page.locator("#projectBrief").inputValue(), "Old brief");
  assert.equal(await page.locator("#workingDocContent").inputValue(), "Legacy B");
  assert.equal((await room(page)).workingDocs[0].content, "Original A");
  assert.equal((await room(page)).workingDocs[1].gdocUrl, docs[1].gdocUrl);

  await page.locator("#refFileInput").setInputFiles({ name: "fixture.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("fixture") });
  await page.waitForFunction(() => document.getElementById("refCount").textContent === "1");
  assert.equal((await room(page)).refDocs[0].content, "Mock extracted DOCX");

  await page.locator("details").nth(1).locator("summary").click();
  await page.locator("#chatgptMode").selectOption("api");
  await page.locator("#chatgptFirstBtn").click();
  await settle(page);
  assert.ok(calls.some(call => call.url === openai && call.headers.authorization === "Bearer mock-openai"));
  assert.ok(calls.find(call => call.url === openai).body.messages[0].content.includes("Mock extracted DOCX"));
  assert.ok(!calls.some(call => call.method === "PUT" && call.path.startsWith("inbox/turns/")));
});
