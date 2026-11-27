import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EVENT_NAME, openRelay, turnIdsFromPush } from "./relay.mjs";
import { allowedCallback, createRelayServer, fileStore } from "./server.mjs";

const repository = "tamturner/ai-group-room";
const branch = "pilot/request-001-scheduled-chat";
const scope = { repository, branch };
const minute = 60_000;
const epoch = Date.parse("2026-11-27T20:00:00Z");
const turn = "inbox/turns/turn-1795811882073-f26386c7-2147-431b-bb9c-86d54f170bc0.json";
const secondTurn = "inbox/turns/turn-1795811882074-f26386c7-2147-431b-bb9c-86d54f170bc0.json";
const callback = "https://events.example.com/mcp";
const secret = Buffer.alloc(32, 42);
const githubSecret = "synthetic-github-secret";
const mcpToken = "synthetic-mcp-token";
const subscription = {
  name: EVENT_NAME,
  arguments: {},
  delivery: { mode: "webhook", url: callback, secret: "whsec_" + secret.toString("base64") }
};
const push = (added, overrides = {}) => ({
  ref: "refs/heads/" + branch, repository: { full_name: repository }, commits: [{ added }], ...overrides
});
const pushHeaders = body => ({
  "x-github-event": "push",
  "x-hub-signature-256": "sha256=" + createHmac("sha256", githubSecret).update(body).digest("hex")
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "room-event-relay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = fileStore(join(directory, "state.json"));
  let at = epoch;
  let response = 204;
  let verify = true;
  const attempts = [];
  const post = async (address, { body, headers }) => {
    const event = JSON.parse(body);
    const id = headers["webhook-id"];
    const timestamp = headers["webhook-timestamp"];
    const signed = createHmac("sha256", secret).update(id + "." + timestamp + "." + body).digest("base64");
    assert.equal(address, callback);
    assert.equal(headers["webhook-signature"], "v1," + signed);
    assert.equal(timestamp, String(Math.floor(at / 1000)));
    attempts.push({ event, id, subId: headers["X-MCP-Subscription-Id"] });
    if (event.type === "verification") {
      return { status: 200, data: { challenge: verify ? event.challenge : "wrong" } };
    }
    return { status: response };
  };
  const open = () => openRelay({ ...scope, store, post, now: () => at });
  return {
    relay: await open(), open, store, attempts, at: ms => { at = epoch + ms; },
    setStatus: status => { response = status; }, disableVerification: () => { verify = false; }
  };
}

test("only newly added, correctly scoped turn request files count as activity", () => {
  assert.deepEqual(turnIdsFromPush(push([turn, turn, "workspace/SESSION_BACKUP.json", "inbox/chatgpt-pro/reply.json"]), scope),
    [turn.split("/").at(-1).slice(0, -5)]);
  assert.deepEqual(turnIdsFromPush(push([turn], { ref: "refs/heads/main" }), scope), []);
  assert.deepEqual(turnIdsFromPush(push([turn], { repository: { full_name: "other/room" } }), scope), []);
  assert.deepEqual(turnIdsFromPush(push([turn], { forced: true }), scope), []);
  assert.deepEqual(turnIdsFromPush(push([turn], { created: true }), scope), []);
  assert.deepEqual(turnIdsFromPush(push([], { commits: [{ modified: [turn] }] }), scope), []);
});

test("runs at three-minute intervals while active, then hourly after the idle cutoff", async t => {
  const { relay, at, attempts } = await setup(t);
  const sub = await relay.subscribe(subscription);
  assert.equal(attempts[0].subId, sub.id);
  assert.equal(sub.cursor, null);
  assert.equal(await relay.tick(), null);
  assert.equal(await relay.recordPush(push([turn])), 1);
  assert.equal((await relay.tick()).data.cadence, "active");
  at(3 * minute - 1);
  assert.equal(await relay.tick(), null);
  for (const n of [3, 6, 9, 12]) {
    at(n * minute);
    const event = await relay.tick();
    assert.deepEqual(event.data, { ...scope, cadence: "active" });
    assert.equal(event.eventId, attempts.at(-1).id);
  }
  at(14 * minute);
  assert.equal(await relay.recordPush(push([turn])), 0);
  at(15 * minute);
  assert.equal(await relay.tick(), null);
  at(72 * minute - 1);
  assert.equal(await relay.tick(), null);
  at(72 * minute);
  assert.equal((await relay.tick()).data.cadence, "idle");
  at(132 * minute);
  assert.equal((await relay.tick()).data.cadence, "idle");
  at(136 * minute);
  assert.equal(await relay.recordPush(push([secondTurn])), 1);
  assert.equal((await relay.tick()).data.cadence, "active");
});

test("additional activity extends the window without producing extra immediate runs", async t => {
  const { relay, at } = await setup(t);
  await relay.subscribe(subscription);
  await relay.recordPush(push([turn]));
  await relay.tick();
  at(2 * minute);
  await relay.recordPush(push([secondTurn]));
  assert.equal(await relay.tick(), null);
  for (const n of [3, 6, 9, 12, 15]) {
    at(n * minute);
    assert.equal((await relay.tick()).data.cadence, "active");
  }
  at(18 * minute);
  assert.equal(await relay.tick(), null);
});

test("failed delivery retains its event ID across restart and a renewal does not reset the cadence", async t => {
  const { relay, open, at, attempts, setStatus } = await setup(t);
  const first = await relay.subscribe(subscription);
  await relay.recordPush(push([turn]));
  setStatus(503);
  assert.equal(await relay.tick(), null);
  const failedId = attempts.at(-1).id;
  const reopened = await open();
  at(20_000);
  assert.equal(await reopened.tick(), null);
  assert.equal((await reopened.subscribe(subscription)).id, first.id);
  at(30_000);
  setStatus(204);
  assert.equal((await reopened.tick()).eventId, failedId);
  assert.equal(attempts.filter(x => x.id === failedId).length, 2);
  at(3 * minute);
  assert.equal(await reopened.tick(), null);
  await reopened.unsubscribe({ id: first.id });
  at(6 * minute);
  assert.equal(await reopened.tick(), null);
});

test("the callback must pass its challenge and URL policy", async t => {
  const { relay, disableVerification } = await setup(t);
  disableVerification();
  await assert.rejects(relay.subscribe(subscription), { code: -32015 });
  const hosts = new Set(["events.example.com"]);
  assert.equal(allowedCallback(callback, hosts).hostname, "events.example.com");
  for (const url of ["http://events.example.com/mcp", "https://events.example.com:8443/mcp",
    "https://user@events.example.com/mcp", "https://events.example.com.attacker.test/mcp"]) {
    assert.throws(() => allowedCallback(url, hosts));
  }
});

test("the HTTP entry points require credentials and accept signed GitHub push notifications", async t => {
  const { relay } = await setup(t);
  const server = createRelayServer({ relay, mcpToken, githubSecret });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = "http://127.0.0.1:" + server.address().port;
  const version = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } };
  const send = (path, body, headers = {}) => fetch(root + path, { method: "POST", body, headers });
  const rpc = message => send("/mcp", JSON.stringify(message), { authorization: "Bearer " + mcpToken });
  assert.equal((await send("/mcp", JSON.stringify(version))).status, 401);
  assert.deepEqual((await (await rpc(version)).json()).result.capabilities, { events: {} });
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "events/list" })).json();
  assert.equal(list.result.events[0].name, EVENT_NAME);
  const install = await (await rpc({ jsonrpc: "2.0", id: 3, method: "events/subscribe", params: subscription })).json();
  assert.ok(install.result.id);
  const body = JSON.stringify(push([turn]));
  assert.equal((await send("/github", body + " ", pushHeaders(body))).status, 401);
  const valid = await send("/github", body, pushHeaders(body));
  assert.equal(valid.status, 202);
  assert.deepEqual(await valid.json(), { added: 1 });
  assert.equal((await relay.tick()).data.cadence, "active");
});
