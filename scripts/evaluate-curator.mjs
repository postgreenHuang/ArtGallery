import { readFileSync } from "node:fs";

const [tasksFile = "docs/evaluation/tasks.json", capturesFile] = process.argv.slice(2);
const tasks = JSON.parse(readFileSync(tasksFile, "utf8"));
if (!Array.isArray(tasks) || tasks.length !== new Set(tasks.map((task) => task.id)).size) {
  throw new Error("评测任务必须是 ID 唯一的数组");
}
if (!capturesFile) {
  process.stdout.write(`已加载 ${tasks.length} 个评测任务。尚无真实运行记录，不生成质量分数。\n`);
  process.exit(0);
}

const captures = JSON.parse(readFileSync(capturesFile, "utf8"));
if (!Array.isArray(captures)) throw new Error("运行记录必须是数组");
const ids = new Set(tasks.map((task) => task.id));
const itemKey = (item) => typeof item === "string" ? item : item && typeof item === "object" ? item.recordKey || item.key : undefined;
for (const capture of captures) {
  if (!ids.has(capture.taskId)) throw new Error(`未知任务 ID：${capture.taskId}`);
  for (const stage of ["retrieved", "reviewed", "displayed"]) {
    if (!Array.isArray(capture[stage])) throw new Error(`${capture.taskId} 缺少 ${stage} 阶段`);
    if (capture[stage].some((item) => typeof itemKey(item) !== "string" || !itemKey(item)))
      throw new Error(`${capture.taskId} 的 ${stage} 阶段包含无效作品键`);
  }
  if (capture.rejected !== undefined && !Array.isArray(capture.rejected)) throw new Error(`${capture.taskId} 的 rejected 必须是数组`);
  if (capture.manualLabels !== undefined && (!capture.manualLabels || typeof capture.manualLabels !== "object" || Array.isArray(capture.manualLabels)))
    throw new Error(`${capture.taskId} 的 manualLabels 必须按作品键记录人工判断`);
}
const summary = Object.groupBy(captures, (capture) => tasks.find((task) => task.id === capture.taskId).group);
for (const [group, runs] of Object.entries(summary)) {
  const counts = ["retrieved", "reviewed", "displayed"].map((stage) => runs.reduce((sum, run) => sum + run[stage].length, 0));
  process.stdout.write(`${group}: ${runs.length} 次运行，召回 ${counts[0]}、复核后 ${counts[1]}、展示 ${counts[2]} 项\n`);
}
const labeled = captures.filter((capture) => capture.manualLabels);
if (!labeled.length) {
  process.stdout.write("这些是数量，不是相关性分数；相关性需人工标注同一批结果。\n");
  process.exit(0);
}
let displayed = 0, judgedDisplayed = 0, relevantDisplayed = 0, judgedAttribution = 0, wrongAttribution = 0;
let rejected = 0, judgedRejected = 0, wronglyRejected = 0, completeRuns = 0, hitRuns = 0;
for (const capture of labeled) {
  const labels = capture.manualLabels;
  const displayKeys = capture.displayed.map(itemKey);
  displayed += displayKeys.length;
  let complete = true, hit = false;
  for (const key of displayKeys) {
    const label = labels[key];
    if (!label || typeof label.relevant !== "boolean") { complete = false; continue; }
    judgedDisplayed++;
    if (label.relevant) { relevantDisplayed++; hit = true; }
    if (typeof label.attributionCorrect === "boolean") {
      judgedAttribution++;
      if (!label.attributionCorrect) wrongAttribution++;
    }
  }
  if (complete) { completeRuns++; if (hit) hitRuns++; }
  for (const key of (capture.rejected || []).map(itemKey)) {
    rejected++;
    const label = labels[key];
    if (!label || typeof label.relevant !== "boolean") continue;
    judgedRejected++;
    if (label.relevant) wronglyRejected++;
  }
}
process.stdout.write(`人工判定的展示项：相关 ${relevantDisplayed}/${judgedDisplayed}；已判定 ${judgedDisplayed}/${displayed}。\n`);
process.stdout.write(`人工判定的排除项：错排 ${wronglyRejected}/${judgedRejected}；已判定 ${judgedRejected}/${rejected}。\n`);
process.stdout.write(`人工判定的作者归属：错误 ${wrongAttribution}/${judgedAttribution}。完整标注运行中至少命中一件：${hitRuns}/${completeRuns}。\n`);
if (judgedDisplayed < displayed || judgedRejected < rejected)
  process.stdout.write("标注不完整；以上分母仅限已判定项，不可当作整组质量结论。\n");
