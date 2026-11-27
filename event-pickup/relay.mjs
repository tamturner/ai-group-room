import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const EVENT_NAME = "group_room.inbox_check_due";
const MINUTE = 60_000;
const ACTIVE_INTERVAL = 3 * MINUTE;
const IDLE_AFTER = 15 * MINUTE;
const IDLE_INTERVAL = 60 * MINUTE;
const RETRY_INTERVAL = 30_000;
const SUBSCRIPTION_LIFETIME = 24 * IDLE_INTERVAL;
const TURN_PATH = /^inbox\/turns\/(turn-[0-9]+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.json$/;

export function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validGitHubSignature(bytes, secret, signature) {
  const expected = "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex");
  return equalSecret(signature, expected);
}

export function turnIdsFromPush(payload, { repository, branch }) {
  if (payload?.repository?.full_name !== repository || payload.ref !== "refs/heads/" + branch ||
      payload.created || payload.deleted || payload.forced || !Array.isArray(payload.commits)) return [];
  return [...new Set(payload.commits.flatMap(commit => Array.isArray(commit?.added) ? commit.added : [])
    .map(path => typeof path === "string" ? TURN_PATH.exec(path)?.[1] : null).filter(Boolean))];
}

export function signedDelivery(subscription, id, body, at) {
  const timestamp = String(Math.floor(at / 1000));
  const signature = createHmac("sha256", Buffer.from(subscription.secret.slice(6), "base64"))
    .update(id + "." + timestamp + "." + body).digest("base64");
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": "v1," + signature,
    "X-MCP-Subscription-Id": subscription.id
  };
}

export class RelayError extends Error {
  constructor(code, message, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export async function openRelay({ repository, branch, store, post, now = Date.now }) {
  const scope = { repository, branch };
  let state = await store.read() ?? {
    ...scope, seenTurns: [], lastActivityAt: null, subscription: null, lastWakeAt: null, pending: null
  };
  if (state.repository !== repository || state.branch !== branch) {
    throw new Error("Use a separate event relay state file for each repository and branch.");
  }
  let serial = Promise.resolve();
  const exclusive = work => {
    const result = serial.then(work);
    serial = result.catch(() => {});
    return result;
  };
  const save = async changes => {
    const next = { ...state, ...changes };
    await store.write(next);
    state = next;
  };
  const send = (sub, id, payload, at) => {
    const body = JSON.stringify(payload);
    return post(sub.url, { body, headers: signedDelivery(sub, id, body, at) });
  };

  function schedule(at) {
    const sub = state.subscription;
    if (!sub || at >= sub.expiresAt) return null;
    const active = state.lastActivityAt !== null && at - state.lastActivityAt < IDLE_AFTER;
    const interval = active ? ACTIVE_INTERVAL : IDLE_INTERVAL;
    const due = active && state.lastWakeAt === null ? state.lastActivityAt
      : (state.lastWakeAt ?? sub.startedAt) + interval;
    return { sub, active, due: state.pending?.retryAt ?? due };
  }

  return {
    nextWakeAt() {
      const planned = schedule(now());
      return planned && planned.due < planned.sub.expiresAt ? planned.due : null;
    },

    definition: {
      name: EVENT_NAME,
      description: "Check the configured AI Group Room GitHub inbox for unanswered turn requests.",
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      payloadSchema: {
        type: "object", additionalProperties: false, required: ["repository", "branch", "cadence"],
        properties: {
          repository: { type: "string" }, branch: { type: "string" },
          cadence: { type: "string", enum: ["active", "idle"] }
        }
      }
    },

    recordPush(payload) {
      return exclusive(async () => {
        const ids = turnIdsFromPush(payload, scope);
        const known = new Set(state.seenTurns);
        const added = ids.filter(id => !known.has(id));
        if (!added.length) return 0;
        // A branch rotation bounds storage while preserving deduplication for the entire pilot.
        if (known.size + added.length > 10_000) throw new Error("The relay's turn history is full.");
        await save({ seenTurns: [...state.seenTurns, ...added], lastActivityAt: now() });
        return added.length;
      });
    },

    subscribe(params) {
      return exclusive(async () => {
        const { name, arguments: filters = {}, delivery } = params ?? {};
        const secret = delivery?.secret;
        const secretLength = typeof secret === "string" && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
          ? Buffer.from(secret.slice(6), "base64").length : 0;
        if (name !== EVENT_NAME || !filters || typeof filters !== "object" || Array.isArray(filters) ||
            Object.keys(filters).length || delivery?.mode !== "webhook" ||
            typeof delivery.url !== "string" || secretLength < 24 || secretLength > 64) {
          throw new RelayError(-32602, "Invalid event subscription.");
        }

        const at = now();
        const id = "sub_" + createHash("sha256")
          .update(JSON.stringify([repository, branch, EVENT_NAME, delivery.url])).digest("hex");
        const previous = state.subscription;
        if (previous && previous.expiresAt > at && previous.id !== id) {
          throw new RelayError(-32602, "This relay has a single authorized chat subscription.");
        }
        const subscription = { id, url: delivery.url, secret, expiresAt: at + SUBSCRIPTION_LIFETIME, startedAt: at };

        const refresh = previous?.id === id && previous.expiresAt > at;
        const recentlyVerified = refresh && equalSecret(previous.secret, secret) && at - previous.verifiedAt < IDLE_INTERVAL;
        if (!recentlyVerified) {
          const challenge = randomUUID();
          let result;
          try {
            result = await send(subscription, "verify_" + randomUUID(), { type: "verification", challenge }, at);
          } catch {
            throw new RelayError(-32015, "Could not verify the callback endpoint.", "challenge_failed");
          }
          if (result.status < 200 || result.status >= 300 || !equalSecret(result.data?.challenge, challenge)) {
            throw new RelayError(-32015, "Could not verify the callback endpoint.", "challenge_failed");
          }
          subscription.verifiedAt = at;
        } else {
          subscription.verifiedAt = previous.verifiedAt;
        }
        if (refresh) subscription.startedAt = previous.startedAt;
        await save({ subscription, ...(refresh ? {} : { pending: null, lastWakeAt: null }) });
        return { id, refreshBefore: new Date(subscription.expiresAt).toISOString(), cursor: null, truncated: false };
      });
    },

    unsubscribe({ id } = {}) {
      return exclusive(async () => {
        if (state.subscription?.id === id && typeof id === "string") await save({ subscription: null, pending: null });
        return {};
      });
    },

    tick() {
      return exclusive(async () => {
        const at = now();
        const planned = schedule(at);
        if (!planned || at < planned.due) return null;
        const { sub, active } = planned;
        if (!state.pending) {
          await save({
            pending: {
              retryAt: at,
              event: {
                eventId: "room_" + randomUUID(), name: EVENT_NAME, timestamp: new Date(at).toISOString(),
                data: { ...scope, cadence: active ? "active" : "idle" }, cursor: null
              }
            }
          });
        }
        const { event } = state.pending;
        try {
          const result = await send(sub, event.eventId, event, at);
          if (result.status >= 200 && result.status < 300) {
            await save({ lastWakeAt: at, pending: null });
            return event;
          }
        } catch {
          // The event and ID remain durable in case the receiver accepted it before the connection failed.
        }
        await save({ pending: { event, retryAt: at + RETRY_INTERVAL } });
        return null;
      });
    }
  };
}
