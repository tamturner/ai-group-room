import { Resolver } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { BlockList } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { equalSecret, openRelay, RelayError, validGitHubSignature } from "./relay.mjs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const PROTOCOL = "2025-03-26";

export function fileStore(filename) {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(filename, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        return null;
      }
    },
    async write(state) {
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      const temporaryFile = filename + ".next";
      await writeFile(temporaryFile, JSON.stringify(state), { mode: 0o600 });
      await rename(temporaryFile, filename);
    }
  };
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(network, prefix, "ipv4");

export function allowedCallback(value, hosts) {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password ||
      url.hash || !hosts.has(url.hostname)) throw new Error("Callback destination is outside the configured HTTPS allowlist.");
  return url;
}

function callbackSender(hosts) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  return async (address, { headers, body }) => {
    const url = allowedCallback(address, hosts);
    const addresses = await resolver.resolve4(url.hostname);
    if (!addresses.length || addresses.some(address => blocked.check(address, "ipv4"))) {
      throw new Error("Callback hostname must resolve to public IPv4 addresses.");
    }
    return new Promise((resolveResult, reject) => {
      const req = request(url, {
        method: "POST", headers, family: 4,
        lookup: (_, options, done) => options.all
          ? done(null, [{ address: addresses[0], family: 4 }]) : done(null, addresses[0], 4),
        agent: false
      }, async res => {
        try {
          const bytes = await readBody(res, MAX_RESPONSE_BYTES);
          let data;
          if (bytes.length) {
            try { data = JSON.parse(bytes.toString("utf8")); }
            catch { data = null; }
          }
          resolveResult({ status: res.statusCode, data });
        } catch (err) { reject(err); }
      });
      const deadline = setTimeout(() => req.destroy(new Error("Callback timed out.")), 5000);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end(body);
    });
  };
}

async function readBody(readable, maximum = MAX_REQUEST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    if (size > maximum) throw new Error("Request body exceeded the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function respond(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  return res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function mcpRequest(relay, wire) {
  if (wire?.jsonrpc !== "2.0" || typeof wire.method !== "string") {
    return { jsonrpc: "2.0", id: wire?.id ?? null, error: { code: -32600, message: "Invalid request." } };
  }
  if (!Object.hasOwn(wire, "id")) return undefined;
  const id = wire.id ?? null;
  try {
    let result;
    switch (wire.method) {
      case "initialize":
        result = {
          protocolVersion: PROTOCOL, capabilities: { events: {} },
          serverInfo: { name: "group-room-event-pickup-pilot", version: "0.1.0" }
        };
        break;
      case "ping": result = {}; break;
      case "events/list": result = { events: [relay.definition] }; break;
      case "events/subscribe": result = await relay.subscribe(wire.params); break;
      case "events/unsubscribe": result = await relay.unsubscribe(wire.params); break;
      default: throw new RelayError(-32601, "Method not found.");
    }
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    const error = err instanceof RelayError
      ? { code: err.code, message: err.message, ...(err.reason && { data: { reason: err.reason } }) }
      : { code: -32603, message: "Internal relay error." };
    return { jsonrpc: "2.0", id, error };
  }
}

export function createRelayServer({ relay, mcpToken, githubSecret }) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    if (req.url !== "/github" && req.url !== "/mcp") return respond(res, 404);
    if (req.method !== "POST") return respond(res, 405);
    if (req.url === "/mcp" && !equalSecret(req.headers.authorization, "Bearer " + mcpToken)) {
      return respond(res, 401);
    }
    try {
      const bytes = await readBody(req);
      if (req.url === "/github") {
        if (!validGitHubSignature(bytes, githubSecret, req.headers["x-hub-signature-256"])) return respond(res, 401);
        if (req.headers["x-github-event"] !== "push") return respond(res, 204);
        const added = await relay.recordPush(JSON.parse(bytes.toString("utf8")));
        return respond(res, 202, { added });
      }
      const reply = await mcpRequest(relay, JSON.parse(bytes.toString("utf8")));
      return respond(res, reply ? 200 : 202, reply);
    } catch (err) {
      const invalid = err instanceof SyntaxError || err.message === "Request body exceeded the size limit.";
      return respond(res, invalid ? 400 : 500);
    }
  });
}

async function main() {
  const repository = process.env.ROOM_REPOSITORY;
  const branch = process.env.ROOM_BRANCH;
  const githubSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const mcpToken = process.env.ROOM_MCP_TOKEN;
  const hosts = new Set((process.env.ROOM_CALLBACK_HOSTS ?? "").split(",").map(host => host.trim().toLowerCase()).filter(Boolean));
  if (!repository || !branch || !githubSecret || !mcpToken || !hosts.size || !process.env.ROOM_STATE_FILE) {
    throw new Error("Set the repository, pilot branch, webhook secret, MCP token, callback hosts and state file.");
  }
  if (!branch.startsWith("pilot/")) throw new Error("The prototype accepts a pilot branch only.");
  const relay = await openRelay({
    repository, branch, store: fileStore(resolve(process.env.ROOM_STATE_FILE)), post: callbackSender(hosts)
  });
  const server = createRelayServer({ relay, mcpToken, githubSecret });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, "127.0.0.1", () => console.log("Pilot relay listening on 127.0.0.1:" + port));
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await relay.tick(); }
    catch { console.error("Could not update the pilot relay state."); }
    finally { ticking = false; }
  }, 1000);
  timer.unref();
  server.once("close", () => clearInterval(timer));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
