import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const workKey = (art) => art?.recordKey || (Number.isSafeInteger(art?.id) ? `${art.provider || "commons"}:${art.id}` : null);
const keys = (items = []) => [...new Set(items.map(workKey).filter(Boolean))];

export function captureEvaluation(library, tasks, taskId, messageId) {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`未知任务 ID：${taskId}`);
  if (!Array.isArray(library?.conversations)) throw new Error("资料库缺少会话记录");
  const matches = library.conversations.flatMap((conversation) => (conversation.messages || [])
    .filter((message) => message.role === "assistant" && message.query &&
      (messageId ? message.id === messageId : message.originalRequest === task.prompt))
    .map((message) => ({ conversation, message })));
  if (!matches.length) throw new Error(`没有找到任务 ${taskId} 的已保存检索；请先在应用中运行原文任务`);
  if (matches.length > 1 && !messageId) throw new Error(`找到 ${matches.length} 次运行；请传入回答的 messageId 指定其中一次`);
  const { conversation, message } = matches[0];
  if (message.reviewPending || message.pageReviewPending) throw new Error("该轮仍在复核，不能作为完成的评测记录");
  const kept = keys(message.artworks);
  const rejected = keys(message.rejectedArtworks);
  return {
    taskId,
    conversationId: conversation.id,
    messageId: message.id,
    runId: message.retrievalDiagnostics?.runId || null,
    mode: message.reviewCompleted ? "ai-reviewed" : "direct-or-unverified",
    retrieved: [...new Set([...kept, ...rejected])],
    reviewed: kept,
    displayed: kept,
    rejected,
    webClueCount: (message.webResults || []).length,
    sourceCalls: message.retrievalDiagnostics?.sourceCalls ?? null,
    detailCalls: message.retrievalDiagnostics?.detailCalls ?? null,
    sourceStatuses: (message.retrievalDiagnostics?.sourceStatuses || []).map(({ provider, state, candidateCount, matchedCount }) =>
      ({ provider, state, candidateCount, matchedCount })),
    // Manual relevance and attribution labels must be entered independently.
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [libraryFile, taskId, messageId] = process.argv.slice(2);
  if (!libraryFile || !taskId) {
    process.stderr.write("用法：node scripts/capture-evaluation.mjs <library.json> <task-id> [message-id]\n");
    process.exitCode = 2;
  } else {
    try {
      const library = JSON.parse(readFileSync(libraryFile, "utf8"));
      const tasks = JSON.parse(readFileSync("docs/evaluation/tasks.json", "utf8"));
      process.stdout.write(`${JSON.stringify([captureEvaluation(library, tasks, taskId, messageId)], null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
