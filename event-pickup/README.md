# AI Group Room event pickup pilot

This local prototype connects signed GitHub push notifications to ChatGPT MCP Events. It is scoped to a single pilot branch and one subscribing chat. The relay sends a signal to check the inbox. The subscribing ChatGPT Work chat would use its existing GitHub connection to read turn files and create replies. The Room already handles importing replies through its GitHub inbox.

A new, valid `inbox/turns/turn-*.json` file counts as activity. The first check can happen immediately, subject to the three-minute spacing between checks. Further checks are due every three minutes while the most recent new turn request is under 15 minutes old. After that, checks are due hourly, measured from the last successful event delivery. A new turn makes the Room active again. Reply commits, backups, edits to existing turn files, and other branches do not extend the active period.

The prototype sends repository, branch, and active or idle status. The event contains no conversation text or document contents. An event signals that ChatGPT should check for work. Actual execution time also depends on event delivery and ChatGPT's processing.

## Test locally

Run from the repository root with Node.js 22 or newer.

```sh
node --test event-pickup/relay.test.mjs
```

The tests use a synthetic clock, a local HTTP server, fake secrets, and a mock ChatGPT callback. They cover both cadences, activation after new activity, duplicate GitHub deliveries, webhook signatures, callback verification, and delivery retries across restarts.

The development entry point is `node event-pickup/server.mjs`. It binds to `127.0.0.1` and accepts these environment settings.

| Setting | Purpose |
| --- | --- |
| `ROOM_REPOSITORY` | Exact GitHub repository, for example `tamturner/ai-group-room` |
| `ROOM_BRANCH` | Exact branch under `pilot/` |
| `GITHUB_WEBHOOK_SECRET` | Secret for checking GitHub's request signature |
| `ROOM_MCP_TOKEN` | Bearer token for the local MCP endpoint |
| `ROOM_CALLBACK_HOSTS` | Comma-separated allowlist of exact callback hostnames |
| `ROOM_STATE_FILE` | Private local file for subscription and delivery state |
| `PORT` | Loopback port, default 8787 |

## Requirements before a live connection

- Put the relay behind an authenticated HTTPS endpoint that GitHub and ChatGPT Work can reach. The loopback bearer-token setup is for local tests. Use a ChatGPT-supported authentication flow for a hosted connection and keep the webhook and subscription secrets private.
- Connect the private plugin to the relay and confirm that the intended chat can subscribe to MCP Events. The existing Pro chat was verified for ChatGPT Scheduled; MCP Events eligibility and delivery in that chat still need a live test.
- Use a test branch for the first GitHub webhook and send one synthetic turn. Confirm the event starts the intended chat and the Room imports the matching reply. Then confirm the three-minute and hourly behavior. Before using both the event relay and the native hourly task in the same room, disable duplicate hourly checks or explicitly treat the native task as a backup. Reply writers should share the same deterministic filename to avoid duplicate commits.
- The existing hourly pilot is separate. This prototype does not change that task, the app's default branch, its deployment, or any Google Docs.

References

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [GitHub webhook signature verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
