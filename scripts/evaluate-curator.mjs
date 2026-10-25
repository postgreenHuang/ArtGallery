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
for (const capture of captures) {
  if (!ids.has(capture.taskId)) throw new Error(`未知任务 ID：${capture.taskId}`);
  for (const stage of ["retrieved", "reviewed", "displayed"]) {
    if (!Array.isArray(capture[stage])) throw new Error(`${capture.taskId} 缺少 ${stage} 阶段`);
  }
}
const summary = Object.groupBy(captures, (capture) => tasks.find((task) => task.id === capture.taskId).group);
for (const [group, runs] of Object.entries(summary)) {
  const counts = ["retrieved", "reviewed", "displayed"].map((stage) => runs.reduce((sum, run) => sum + run[stage].length, 0));
  process.stdout.write(`${group}: ${runs.length} 次运行，召回 ${counts[0]}、复核后 ${counts[1]}、展示 ${counts[2]} 项\n`);
}
process.stdout.write("这些是数量，不是相关性分数；相关性需人工标注同一批结果。\n");
