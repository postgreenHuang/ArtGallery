# 公开馆藏连通性抽样（非选图质量评测）

时间：2026-10-27 01:11 UTC。本次只读请求来自当前 Windows 开发机，未使用用户密钥、Brave 或模拟人工点击。仅用于确认真实响应边界；样本量不足以计算来源成功率或作品相关性。

| 来源 | 请求范围 | 实际观察 | 不能据此推断 |
| --- | --- | --- | --- |
| Met | `/public/collection/v1.1/search?q=Claude%20Monet&hasImages=true&limit=1`，再读返回的首个作品 `459107` | 搜索 JSON 返回 `total=72`，首个 ID 为 `459107`；详情的 `isPublicDomain=false` 且 `primaryImageSmall` 为空。适配器应继续排除该记录，不把“搜索有结果”当成可展示公版作品。 | 其余 71 件的授权、图片或实际相关性。 |
| Cleveland | `/api/artworks/?q=Claude%20Monet&skip=0&limit=1&has_image=1&cc0` | JSON 返回 `total=18`；首件 ID `136510`，`share_license_status=CC0`，有 `images.web.url`。 | 18 件是否都符合指定作者本人及展示需求。 |
| Chicago | `/api/v1/artworks/search?q=Claude%20Monet&page=1&limit=1` | 当前环境返回 HTTP 403、`text/html`，未得到可解析馆藏 JSON。 | 403 的普遍发生率或确切原因；不能自动用点击模拟绕过。 |
| Wikimedia Commons | 小型 `action=query` 搜索 | 当前环境 12 秒连接超时，未得到 HTTP 状态。 | 该来源整体不可用或发生了 429。 |

下一步仍需在应用内用固定 48 任务记录相同时间窗的真实输出，再独立人工核对作品键、作者归属和条件符合性。当前样本不包含 AI 规划、复核或用户心流，不得作为 T10 发布门槛通过证据。用户暂不接入 Brave，故不以其可用性为依赖。
