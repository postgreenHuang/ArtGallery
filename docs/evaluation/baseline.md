# 艺术发现基线

基线 commit：`ae445cf`。起点文档：`../product-strategy-execution-plan.md`。状态：代码和固定响应测试已核对；真实供应商质量未测。

## 可重复任务

`tasks.json` 收录 48 条任务，身份、主题、发散、连续性四组各 12 条。后 24 条为评测情境扩展，不冒充用户逐字原话。任务中的 `checks` 是人工审核清单，不是作品的真实标签；仍需逐条核对真实作品和来源。

运行 `node scripts/evaluate-curator.mjs` 只检查任务集，不输出虚假的选图质量分数。可选择传入一份人工收集的 JSON 运行记录，例如 `node scripts/evaluate-curator.mjs docs/evaluation/tasks.json path/to/captures.json`，记录形如：

```json
[{"taskId":"identity-01","retrieved":["commons:123"],"reviewed":["commons:123"],"displayed":["commons:123"]}]
```

三个数组分别是原始候选、复核保留和用户看见的记录键。若实际运行记录另有 `rejected` 和 `manualLabels`，脚本只在明确标注的对象上统计相关、错排和作者错归属，例如：

```json
[{"taskId":"identity-01","retrieved":["commons:123"],"reviewed":["commons:123"],"displayed":["commons:123"],"rejected":[],"manualLabels":{"commons:123":{"relevant":true,"attributionCorrect":true}}}]
```

该示例仅说明格式，不是一次真实运行。缺少人工标签时脚本只统计阶段数量；标注不完整时分母只包括已判定项，不推断整组质量或召回率。

桌面版实际完成一次与 `tasks.json` 原文一致的检索后，可用 `npm run capture:evaluation -- <资料库/library.json> <任务 ID>` 从本地资料库只读提取该轮 `recordKey`、阶段集合、来源与详情请求数；若同一任务运行多次，必须再传回答的 `messageId` 指定一次。输出是一项记录的 JSON 数组，可汇总后交给 `npm run evaluate -- docs/evaluation/tasks.json <汇总文件>`。导出工具不发送网络请求，也不输出会话正文、模型地址、密钥或完整资料库；仍应在分享前核查作品键与运行标识。`reviewed` 和 `displayed` 当前可能相同，这反映尚未实现真正的渐进结果流，不能伪称两阶段独立测得。人工相关性与归属标签必须另行核查，工具不会自动填入。

## 已有代码可确认的失败机制

以下是基线版本的失败机制，部分已在后续切片修复，不能当作当前版本仍存在的断言：

1. 首页曾由固定 15 位画家轮换；现已改为主题轮换与曝光记忆，但真实覆盖仍待测：`src/services/discovery.ts`。
2. 多馆藏曾共用单一关键词；现已对部分来源下推类型/媒材条件，其余维度仍待扩充：`src/services/artSearch.ts` 与各馆藏适配器。
3. 网页依据曾主要从全文抽取；现增加作品块、JSON-LD 与同作品引用边界，但真实网页误关联率仍待测：`src/services/pageEvidence.ts`、`src/services/review.ts`。
4. 作者匹配曾缺少 `after`、`workshop` 等归属限定语；现有保守过滤，真实反例仍需回放：`src/services/artSearch.ts`。

这些是由实现推得的风险，不等于已经测得的用户错误率。

## 用户已报告的具体失败（尚未在本轮真实网络复现）

1. 首页部分卡片显示“图片暂不可用”，进入详情却能看到小缩略图；说明卡片与详情的图片回退链路仍需统一验证。
2. Chicago IIIF 的 `/full/full/0/default.jpg` 原图请求出现过 403；缩略图可用不等于原图可取，画架必须能独立保存记录。
3. Commons 多次 429 后，用户报告连“加入画架”都受到影响；需分别测试记录保存、原图延迟下载与本地缓存浏览。

这些是用户提供的场景与截图/错误地址，不是本轮测出的发生频率。旧版本针对部分情况已有修复，发布前仍须原生环境回归。

## 待填写的真实基线

| 环境 | 状态 | 记录要求 |
| --- | --- | --- |
| 固定响应单元测试 | 42 项曾在审视时通过 | 仅说明行为回归，不说明推荐质量 |
| 原生桌面 AI 模型 | 未运行 | 模型实际标识、图片能力、调用数、延迟、token 用量 |
| Brave 网页与图片 | 用户暂不接入，不作为当前交付依赖 | 保持可选代码，不用未运行的网页结果补齐馆藏质量报告 |
| 馆藏真实查询 | 未在本次评测运行 | 四源成功率、429、有效作者、无图记录 |
| 人工相关性标注 | 未开始 | 每项 recordKey、作品源、判断与理由 |
| 用户心流试用 | 未开始 | 找画、阅读、按维度发散、返回、收藏 |

下一步须用相同任务记录各阶段结果并人工标注，再比较新旧版本。不要删掉失败任务，也不要把未配置密钥视为服务返回无结果。
