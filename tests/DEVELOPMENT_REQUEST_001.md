# Development Request 001 acceptance

## Local browser tests

Run from the repository root with Node.js and Chrome. The suite uses fake credentials and intercepts every page request, including GitHub, AI providers, the Google Docs bridge, and the DOCX browser library.

```sh
test_runtime=$(mktemp -d)
npm install --no-save --ignore-scripts --prefix "$test_runtime" playwright-core
NODE_PATH="$test_runtime/node_modules" \
  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  node --test tests/request-001.test.cjs
```

## Live acceptance without deploying

1. Use a disposable GitHub repository with an initial commit and a branch named `request-001-acceptance`. Use only synthetic test content. The room writes chat and workspace backups to its configured repository, where public repositories make those files readable to anyone.
2. In a new folder, download the development copy and start a server bound to this Mac.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tamturner/ai-group-room/refs/heads/dev/request-001-external-chatgpt-pro/index.html -o index.html
   python3 -m http.server 8765 --bind 127.0.0.1
   ```

   Open [the local test room](http://localhost:8765/) in a fresh browser profile. In **API Keys, Personas, GitHub Sync & Google Doc Bridge**, select **External ChatGPT Pro (GitHub inbox)** and enter your disposable repository, the `request-001-acceptance` branch, and a GitHub token with Contents read/write for that repository. Leave all three model API keys blank. Enter the GitHub token again after a reload if you chose to keep it out of browser storage.
3. Create two working tabs named `Room A.md` and `Room B.md`. Give them different sample text. Select `Room A.md`. Send `Acceptance turn one` and wait for **ChatGPT Pro turn queued**, then send `Acceptance turn two`. In GitHub, select the disposable branch and check `inbox/turns/` for two new files with distinct `requestId` values and the matching `latestMessage.text`. Click **Pause**.
4. Open your existing ChatGPT Pro conversation. Ask it to read both exact request paths on the disposable branch through its GitHub connection and report back the two test phrases. Then ask it to create `inbox/chatgpt-pro/acceptance-reply-two.json` on that same branch, using the second request ID in place of the placeholder below. Have it confirm the file path and commit SHA.

   ```json
   {
     "id": "acceptance-reply-two",
     "inReplyTo": "PASTE_SECOND_REQUEST_ID_HERE",
     "content": "Acceptance reply two. <PROPOSED_DOC target=\"Room B.md\">Approved test text for B.</PROPOSED_DOC>"
   }
   ```

   Ask it to create a second file with ID `acceptance-reply-one`, the first request ID and plain text `Acceptance reply one.`. Each reply must use a new file. The optional `timestamp` field is an ISO 8601 date string. If ChatGPT cannot read and commit on that branch, record the connector leg as unverified. Creating the same two files through GitHub's web interface can still verify the room's import path.
5. Keep the test room open in the foreground. On the next polling cycle, confirm reply two appears once while paused, and the waiting count drops from two to one. After the other reply lands, confirm both replies appear once and the waiting count disappears. The original turn request files should retain their original contents. The fulfillment state is recorded in the room and its backup.
6. With `Room A.md` still selected, verify both original documents are intact before approval. Click **Approve & Apply to Working Doc** on reply two, then check that only `Room B.md` changed. If you also want to verify the live Google Docs bridge, link the tabs to two disposable Docs before importing the proposal and confirm the push changes only the Doc linked to `Room B.md`.
7. Wait for **GitHub Sync: Saved**, then check that `workspace/SESSION_BACKUP.json` contains both tabs, both reply IDs and both fulfilled requests. Reload the room, re-enter the GitHub token if needed, then click **Load from GitHub** and confirm the restore. The replies should still appear once each, the approved proposal should show **Applied**, and both test tabs should be available. Check that the production site and documents were outside the test.

## Operational limits

- An active ChatGPT session or an independently configured writer must create replies. The room polls GitHub while it is open, approximately every 12 seconds in a foreground browser tab.
- Use a new ID for each reply. A file is treated as immutable by the room once imported. GitHub permissions determine who can write or edit files in the repository.
- GitHub's Contents API lists at most 1,000 entries in an inbox directory. Backups are full snapshots for one room browser at a time. Separate browsers can still compete to write the same snapshot and transcript.
- Pause prevents new automatic model calls and discards a model reply if its call was already in flight. It does not cancel a service request that already started. This no-key live checklist exercises the GitHub path. The mocked browser suite checks that configured model calls are suppressed during Pause.
