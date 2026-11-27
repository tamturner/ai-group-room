import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { AuthorizationError, OAuthProvider, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { equalSecret, openRelay, RelayError } from "../relay.mjs";
import { verifyGitHubPush } from "./github.mjs";

const scope = "group-room:watch";
const protocol = "2026-07-28";
const toolName = "get_group_room_pickup_status";
const owner = "pilot-owner";
const initialized = new Map();

function relayStub(env) {
  return env.ROOM_RELAY.getByName(env.ROOM_REPOSITORY + "@" + env.ROOM_BRANCH);
}

function isChatGPTRedirect(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash &&
      (/^\/connector\/oauth\/[a-zA-Z0-9_-]+$/.test(url.pathname) || url.pathname === "/connector_platform_oauth_redirect");
  } catch {
    return false;
  }
}

async function postCallback(address, { headers, body }) {
  const url = new URL(address);
  // Only OpenAI-controlled cloud callback origins are permitted. The worker's
  // global_fetch_strictly_public flag excludes nonpublic network destinations.
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !/^(?:[a-z0-9-]+\.)*(?:openai\.com|chatgpt\.com)$/.test(url.hostname)) {
    throw new Error("Callback must be on an OpenAI HTTPS origin.");
  }
  const response = await fetch(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
  return {
    status: response.status,
    data: JSON.parse(body).type === "verification" && response.ok ? await response.json() : null
  };
}

export class RoomRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS relay_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const store = {
      read: () => {
        const [row] = ctx.storage.sql.exec("SELECT value FROM relay_state WHERE key = 'relay'").toArray();
        return row ? JSON.parse(row.value) : null;
      },
      write: next => {
        ctx.storage.sql.exec("INSERT OR REPLACE INTO relay_state VALUES ('relay', ?)", JSON.stringify(next));
      }
    };
    this.relay = openRelay({ repository: env.ROOM_REPOSITORY, branch: env.ROOM_BRANCH, store, post: postCallback });
    this.serial = Promise.resolve();
  }

  run(operation) {
    const result = this.serial.then(async () => {
      const relay = await this.relay;
      try { return await operation(relay); }
      finally {
        const next = relay.nextWakeAt();
        if (next === null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 100));
      }
    });
    this.serial = result.catch(() => {});
    return result;
  }

  recordPush(payload) { return this.run(relay => relay.recordPush(payload)); }
  describeEvent() { return this.relay.then(relay => relay.definition); }
  status() {
    return this.relay.then(relay => {
      const at = relay.nextWakeAt();
      return { repository: this.env.ROOM_REPOSITORY, branch: this.env.ROOM_BRANCH,
        subscribed: at !== null, nextCheckDue: at === null ? null : new Date(at).toISOString() };
    });
  }
  subscribe(params) {
    return this.run(async relay => {
      try { return { result: await relay.subscribe(params) }; }
      catch (err) {
        if (!(err instanceof RelayError)) throw err;
        return { error: { code: err.code, message: err.message, ...(err.reason && { data: { reason: err.reason } }) } };
      }
    });
  }
  unsubscribe(params) { return this.run(relay => relay.unsubscribe(params)); }
  alarm() { return this.run(async relay => { await relay.tick(); }); }

  reservePairingCode(hash, reservation) {
    // The HTTPS Worker checks the current secret and expiry before calling this
    // private binding. The Durable Object only enforces single use.
    return this.ctx.storage.transactionSync(() => {
      const key = "pairing:" + hash;
      const [used] = this.ctx.storage.sql.exec(
        "SELECT 1 FROM relay_state WHERE key = ? OR (key = 'pairing' AND value = ?)", key, hash
      ).toArray();
      if (used) return false;
      this.ctx.storage.sql.exec("INSERT INTO relay_state VALUES (?, ?)", key, reservation);
      return true;
    });
  }

  releasePairingCode(hash, reservation) {
    this.ctx.storage.sql.exec("DELETE FROM relay_state WHERE key = ? AND value = ?", "pairing:" + hash, reservation);
  }
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function setupPage(origin) {
  const endpoint = escapeHTML(origin + "/mcp");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AI Group Room Pickup Pilot</title>
<style>
  :root { color-scheme: light dark }
  body { font: 1rem/1.55 system-ui, sans-serif; margin: 0; padding: 12vh 1.5rem 2rem }
  main { max-width: 37rem; margin: auto }
  h1 { font-size: 2rem; line-height: 1.2 }
  label { display: block; font-weight: 600; margin-top: 1.5rem }
  input { box-sizing: border-box; width: 100%; padding: .65rem; font: inherit; margin: .3rem 0 }
  ol { padding-left: 1.4rem }
</style></head><body><main>
<h1>AI Group Room Pickup Pilot</h1>
<p>The pilot server is online. To connect it to ChatGPT, copy the server address below.</p>
<label for="endpoint">Server address</label>
<input id="endpoint" type="url" value="${endpoint}" readonly spellcheck="false">
<ol>
  <li>Open <a href="https://chatgpt.com/plugins">ChatGPT Plugins</a>.</li>
  <li>Choose <strong>+</strong>, then <strong>Add custom MCP server</strong>.</li>
  <li>Paste the server address, select <strong>OAuth</strong>, and follow the connection prompt.</li>
</ol>
<p>The one-time pairing code belongs on the connection form that opens after ChatGPT starts OAuth.</p>
</main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
    }
  });
}

async function renderAuthorization(request, oauth, notice = "") {
  const parsed = await oauth.parseAuthRequest(request);
  if (!isChatGPTRedirect(parsed.redirectUri) || parsed.codeChallengeMethod !== "S256") return new Response("Unsupported ChatGPT client.", { status: 400 });
  const { handle, headers } = await oauth.beginConsent(parsed);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connect AI Group Room Pilot</title><main><h1>Connect AI Group Room Pilot</h1>
<p>Allow ChatGPT (chatgpt.com) to subscribe to inbox events for the Group Room test branch. This connection cannot edit GitHub or your documents.</p>
${notice ? "<p role=\"status\">" + escapeHTML(notice) + "</p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${escapeHTML(handle)}">
<label>One-time pairing code <input name="code" type="password" autocomplete="off" required></label>
<button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></form></main></html>`,
  { headers });
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  if (request.method === "GET") return renderAuthorization(request, oauth);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (request.headers.get("origin") !== env.ROOM_ORIGIN) return new Response(null, { status: 403 });
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const code = String(form.get("code") ?? "").trim().toLowerCase().replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/.test(code)) return new Response("Enter the one-time code from the pilot setup.", { status: 403 });
  const hash = createHash("sha256").update(code).digest("hex");
  if (!equalSecret(hash, env.ROOM_PAIRING_HASH)) return new Response("The pairing code is invalid.", { status: 403 });
  const expiresAt = Date.parse(env.ROOM_PAIRING_EXPIRY);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return new Response("This pairing code has expired.", { status: 403 });
  }
  let approved;
  try {
    approved = await oauth.approveConsent(request, handle, { scope: [scope] });
  } catch (err) {
    if (!(err instanceof AuthorizationError) || err.code !== "invalid_request") throw err;
    // The consent form has its own short-lived, browser-bound transaction.
    // Renew it from the original, validated OAuth parameters before reserving the pairing code.
    return renderAuthorization(new Request(request.url, { headers: request.headers }), oauth,
      "The connection form was refreshed. Enter the same pairing code again and click Allow.");
  }
  if (!isChatGPTRedirect(approved.request.redirectUri)) {
    return new Response("Open Connect again in ChatGPT to start a new authorization.", { status: 400 });
  }

  const stub = relayStub(env);
  const reservation = crypto.randomUUID();
  if (!await stub.reservePairingCode(hash, reservation)) {
    return new Response("This pairing code has already been used.", { status: 403 });
  }
  let grant;
  try {
    grant = await oauth.completeAuthorization({
      request: approved.request, userId: owner, metadata: { name: "AI Group Room Pickup Pilot" },
      scope: [scope], props: { userId: owner }
    });
  } catch (err) {
    await stub.releasePairingCode(hash, reservation);
    throw err;
  }
  approved.headers.set("Location", grant.redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

async function mcp(request, env, ctx) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (ctx.props?.userId !== owner || !ctx.auth?.scope.includes(scope)) return insufficientScope(ctx.auth, [scope]);

  let wire;
  try { wire = await request.json(); }
  catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); }
  if (wire?.jsonrpc !== "2.0" || typeof wire.method !== "string") {
    return Response.json({ jsonrpc: "2.0", id: wire?.id ?? null, error: { code: -32600, message: "Invalid request." } });
  }
  if (!Object.hasOwn(wire, "id")) return new Response(null, { status: 202 });

  const stub = relayStub(env);
  const capabilities = { tools: {}, events: {} };
  const serverInfo = { name: "group-room-pickup-pilot", version: "0.1.0" };
  const schema = { type: "object", properties: {}, additionalProperties: false };
  let result;
  let error;
  switch (wire.method) {
    case "server/discover":
      result = { resultType: "complete", supportedVersions: [protocol], capabilities, serverInfo };
      break;
    case "initialize":
      result = { protocolVersion: "2025-03-26", capabilities, serverInfo };
      break;
    case "ping": result = {}; break;
    case "tools/list":
      result = { tools: [{ name: toolName, description: "Check the branch and subscription status of the Group Room pilot.",
        inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
      break;
    case "tools/call":
      if (wire.params?.name === toolName) {
        result = { content: [{ type: "text", text: JSON.stringify(await stub.status()) }] };
      } else { error = { code: -32602, message: "Unknown tool." }; }
      break;
    case "events/list": result = { events: [await stub.describeEvent()] }; break;
    case "events/subscribe": ({ result, error } = await stub.subscribe(wire.params)); break;
    case "events/unsubscribe": result = await stub.unsubscribe(wire.params); break;
    default: error = { code: -32601, message: "Method not found." };
  }
  return Response.json({ jsonrpc: "2.0", id: wire.id, ...(error ? { error } : { result }) });
}

function workerHandler(env) {
  if (!initialized.has(env.ROOM_ORIGIN)) {
    initialized.set(env.ROOM_ORIGIN, new OAuthProvider({
      apiRoute: "/mcp", apiHandler: { fetch: mcp },
      defaultHandler: { async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === "/" && request.method === "GET") return setupPage(env.ROOM_ORIGIN);
        if (path === "/healthz" && request.method === "GET") return Response.json({ status: "ready", service: "group-room-pickup-pilot" });
        if (path === "/authorize") {
          try { return await authorize(request, env); }
          catch (err) {
            if (!(err instanceof AuthorizationError)) {
              console.error("Group Room OAuth failed:", err?.name ?? "unknown");
            }
            return new Response("Open the AI Group Room Pickup Pilot in ChatGPT and select Connect to start a fresh sign-in.",
              { status: err instanceof AuthorizationError ? 400 : 503, headers: { "Cache-Control": "no-store" } });
          }
        }
        if (path !== "/github" || request.method !== "POST") return new Response(null, { status: 404 });
        let push;
        try { push = await verifyGitHubPush(request, env); }
        catch { return new Response("Invalid GitHub turn signal.", { status: 400 }); }
        if (!push) return new Response(null, { status: 401 });
        return Response.json({ added: await relayStub(env).recordPush(push) }, { status: 202 });
      } },
      authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [scope], requiredScopes: [scope], refreshTokenTTL: 7 * 86400,
      resourceMetadata: { resource: env.ROOM_ORIGIN + "/mcp", authorization_servers: [env.ROOM_ORIGIN] },
      clientRegistrationCallback({ clientMetadata }) {
        if (!Array.isArray(clientMetadata.redirect_uris) || !clientMetadata.redirect_uris.length ||
            !clientMetadata.redirect_uris.every(isChatGPTRedirect)) {
          return { code: "invalid_redirect_uri", description: "Only documented ChatGPT OAuth redirects are accepted." };
        }
      }
    }));
  }
  return initialized.get(env.ROOM_ORIGIN);
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).origin !== env.ROOM_ORIGIN || !env.ROOM_BRANCH?.startsWith("pilot/")) {
      return new Response(null, { status: 404 });
    }
    const { pathname } = new URL(request.url);
    const accept = request.headers.get("accept") ?? "";
    if (pathname === "/mcp" && request.method === "GET" && accept.includes("text/html") &&
        !accept.includes("application/json") && !accept.includes("text/event-stream")) {
      return Response.redirect(env.ROOM_ORIGIN + "/", 303);
    }
    return workerHandler(env).fetch(request, env, ctx);
  }
};
