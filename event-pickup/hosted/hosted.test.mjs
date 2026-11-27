import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";

import { verifyGitHubPush, GITHUB_ISSUER } from "./github.mjs";

const origin = "https://pickup.example.com";
const repo = "tamturner/ai-group-room";
const branch = "pilot/request-001-scheduled-chat";
const scope = "group-room:watch";
const settings = {
  ROOM_ORIGIN: origin, ROOM_REPOSITORY: repo, ROOM_REPOSITORY_ID: "1474236393", ROOM_BRANCH: branch
};
const syntheticCode = "a".repeat(32);
const hash = value => createHash("sha256").update(value).digest("hex");
const redirect = "https://chatgpt.com/connector/oauth/test-client";
const version = "2026-07-28";

test("hosted OAuth authorizes one owner, consumes the pairing code once and exposes MCP Events", async t => {
  const mf = new Miniflare({
    modules: true, scriptPath: fileURLToPath(new URL("./dist/worker.mjs", import.meta.url)),
    compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    durableObjects: { ROOM_RELAY: { className: "RoomRelay", useSQLite: true } },
    kvNamespaces: ["OAUTH_KV"],
    bindings: { ...settings, ROOM_PAIRING_HASH: hash(syntheticCode), ROOM_PAIRING_EXPIRY: "2099-01-01T00:00:00Z" }
  });
  t.after(() => mf.dispose());
  const get = path => mf.dispatchFetch(origin + path);
  const post = (path, body, headers = {}) => mf.dispatchFetch(origin + path, {
    method: "POST", body, headers, redirect: "manual"
  });
  const postJSON = (path, data, headers = {}) => post(path, JSON.stringify(data), { "Content-Type": "application/json", ...headers });
  const mcp = (method, params = {}, token) => postJSON("/mcp", { jsonrpc: "2.0", id: 1, method, params },
    token ? { authorization: "Bearer " + token } : {});

  assert.equal((await get("/healthz")).status, 200);
  assert.equal((await postJSON("/github", { files: [] })).status, 401);
  const unauthorized = await mcp("server/discover");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /oauth-protected-resource/);
  const metadata = await (await get("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(metadata.resource, origin + "/mcp");
  assert.deepEqual(metadata.authorization_servers, [origin]);
  const authMetadata = await (await get("/.well-known/oauth-authorization-server")).json();
  assert.equal(authMetadata.issuer, origin);
  assert.equal(authMetadata.registration_endpoint, origin + "/oauth/register");
  assert.equal((await postJSON("/oauth/register", { redirect_uris: ["https://outside.example/callback"] })).status, 400);
  const response = await postJSON("/oauth/register", {
    redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], client_name: "ChatGPT", scope
  });
  assert.equal(response.status, 201, await response.clone().text());
  const registration = await response.json();
  const verifier = "b".repeat(48);
  const params = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirect, scope,
    state: "one-test-state", response_type: "code", resource: origin + "/mcp",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256"
  });
  const authorize = "/authorize?" + params;
  async function confirm(code, sender = origin) {
    const page = await get(authorize);
    const html = await page.text();
    assert.equal(page.status, 200, html);
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(handle);
    assert.match(html, /One-time pairing code/);
    const cookie = page.headers.getSetCookie().map(header => header.split(";")[0]).join("; ");
    return post(authorize, new URLSearchParams({ handle, decision: "approve", code }), { cookie, origin: sender });
  }
  assert.equal((await confirm(syntheticCode, "https://unrelated.example")).status, 403);
  assert.equal((await confirm("c".repeat(32))).status, 403);
  const allowed = await confirm(syntheticCode);
  assert.equal(allowed.status, 302, await allowed.clone().text());
  const target = new URL(allowed.headers.get("location"));
  assert.equal(target.pathname, "/connector/oauth/test-client");
  assert.equal(target.searchParams.get("state"), "one-test-state");
  assert.equal((await confirm(syntheticCode)).status, 403);
  const exchange = await post("/oauth/token", new URLSearchParams({
    grant_type: "authorization_code", code: target.searchParams.get("code"),
    redirect_uri: redirect, client_id: registration.client_id, code_verifier: verifier,
    resource: origin + "/mcp"
  }));
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const { access_token: token } = await exchange.json();
  assert.ok(token);
  const result = await (await mcp("server/discover", {}, token)).json();
  assert.deepEqual(result.result.supportedVersions, [version]);
  assert.ok(Object.hasOwn(result.result.capabilities, "events"));
  assert.equal((await (await mcp("events/list", {}, token)).json()).result.events[0].name, "group_room.inbox_check_due");
  const status = await (await mcp("tools/call", { name: "get_group_room_pickup_status" }, token)).json();
  assert.deepEqual(JSON.parse(status.result.content[0].text), { repository: repo, branch, subscribed: false, nextCheckDue: null });
});

test("GitHub signal verifies the signed identity and rejects different branch, workflow, audience and commit", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const sha = "a".repeat(40);
  const file = "inbox/turns/turn-1795811882073-f26386c7-2147-431b-bb9c-86d54f170bc0.json";
  const payload = { sha, files: [file] };
  async function signed(overrides = {}, audience = origin + "/github", body = payload) {
    const token = await new SignJWT({
      repository: repo, repository_id: settings.ROOM_REPOSITORY_ID, sha, event_name: "push",
      runner_environment: "github-hosted", ref: "refs/heads/" + branch,
      workflow_ref: repo + "/.github/workflows/group-room-pickup-pilot.yml@refs/heads/" + branch, ...overrides
    }).setProtectedHeader({ alg: "RS256" }).setIssuer(GITHUB_ISSUER).setAudience(audience)
      .setSubject("synthetic").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    return new Request(origin + "/github", { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify(body) });
  }
  const check = request => verifyGitHubPush(request, settings, async () => publicKey);
  assert.deepEqual(await check(await signed()), { repository: { full_name: repo }, ref: "refs/heads/" + branch, commits: [{ added: [file] }] });
  assert.equal(await check(await signed({ ref: "refs/heads/main" })), null);
  assert.equal(await check(await signed({ repository_id: "123" })), null);
  assert.equal(await check(await signed({ workflow_ref: "another-workflow" })), null);
  assert.equal(await check(await signed({}, "https://outside.example")), null);
  await assert.rejects(check(await signed({}, origin + "/github", { ...payload, sha: "b".repeat(40) })));
  await assert.rejects(check(await signed({}, origin + "/github", { ...payload, files: ["workspace/SESSION_BACKUP.json"] })));
});
