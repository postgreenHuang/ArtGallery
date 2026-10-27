import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureEvaluation } from "./capture-evaluation.mjs";

const tasks = [{ id: "identity-01", prompt: "只看 Claude Monet 本人的画，不要 after Monet" }];
const library = { conversations: [{ id: "chat", messages: [{ id: "answer", role: "assistant", query: "Claude Monet",
  originalRequest: tasks[0].prompt, reviewCompleted: true,
  artworks: [{ id: 1, provider: "met", recordKey: "met:1" }],
  rejectedArtworks: [{ id: 2, provider: "chicago", recordKey: "chicago:2" }],
  webResults: [{ url: "https://example.org" }], retrievalDiagnostics: { runId: "run", sourceCalls: 4, detailCalls: 8,
    sourceStatuses: [{ provider: "met", state: "error", candidateCount: 0, matchedCount: 0, detail: "private query text" }] } }] }] };

describe("evaluation capture", () => {
  it("exports only work keys and counts, not saved user text or settings", () => {
    const capture = captureEvaluation(library, tasks, "identity-01");
    assert.deepEqual(capture.retrieved, ["met:1", "chicago:2"]);
    assert.deepEqual(capture.displayed, ["met:1"]);
    assert.deepEqual(capture.rejected, ["chicago:2"]);
    assert.equal(capture.detailCalls, 8);
    assert.equal(JSON.stringify(capture).includes(tasks[0].prompt), false);
    assert.equal(JSON.stringify(capture).includes("private query text"), false);
  });
  it("refuses unfinished or ambiguous runs", () => {
    assert.throws(() => captureEvaluation({ conversations: [library.conversations[0], library.conversations[0]] }, tasks, "identity-01"), /找到 2 次运行/);
    const pending = structuredClone(library);
    pending.conversations[0].messages[0].reviewPending = true;
    assert.throws(() => captureEvaluation(pending, tasks, "identity-01"), /仍在复核/);
  });
});
