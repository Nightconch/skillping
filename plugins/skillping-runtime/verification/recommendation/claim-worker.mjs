import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [buildRoot, filename, timestamp] = process.argv.slice(2);
const root = path.dirname(path.resolve(filename));
assert.equal(path.basename(filename), "scout.sqlite", "FIXTURE: expected isolated database");
assert.equal(path.dirname(root), path.resolve(tmpdir()), "FIXTURE: database must be in temporary data");
assert.ok(path.basename(root).startsWith("skillping-recommendation-"), "FIXTURE: expected data prefix");
const { openStorage } = await import(pathToFileURL(path.join(buildRoot, "dist/storage.js")));
const now = Number(timestamp);
assert.ok(Number.isSafeInteger(now), "FIXTURE: controlled timestamp");
const store = await openStorage({ filename, now: () => now, recommendationPace: () => "eager" });
try {
  const command = once(process, "message", { signal: AbortSignal.timeout(15_000) });
  process.send({ kind: "ready" });
  assert.equal((await command)[0], "claim", "FIXTURE: parent releases the claim barrier");
  const claim = await store.claimDispatch({ codexTaskId: "task-3", turnId: "turn-3",
    cwd: "E:/fixture/workspace", claimedAt: now, recommendation: "web" });
  await new Promise((resolve, reject) => process.send({ kind: "claim", value: claim ?? null }, error => error ? reject(error) : resolve()));
} finally {
  store.close();
  if (process.connected) process.disconnect();
}
