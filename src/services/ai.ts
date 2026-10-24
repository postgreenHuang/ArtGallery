import { invoke } from "@tauri-apps/api/core";
import { desktop } from "./storage";
import type { ArtistSuggestion, Artwork, Message, Settings } from "../types";
export interface Plan {
  query: string;
  explanation: string;
  recommendations?: ArtistSuggestion[];
}
export function isRecommendationRequest(input: string): boolean {
  return /类似|相似|同风格|相近风格|同派|风格.{0,12}(推荐|画家|艺术家|作品)|像.{0,18}(画家|艺术家|作品)/i.test(
    input,
  );
}
const dictionary: [RegExp, string][] = [
  [/莫奈|monet/i, "Claude Monet"],
  [/梵高|van gogh/i, "Vincent van Gogh"],
  [/维米尔|vermeer/i, "Johannes Vermeer"],
  [/葛饰北斋|北斋|hokusai/i, "Hokusai"],
  [/透纳|turner/i, "William Turner"],
  [/伦勃朗|rembrandt/i, "Rembrandt"],
  [/希施金|希什金|希什金|shishkin/i, "Ivan Shishkin"],
  [/列宾|repin/i, "Ilya Repin"],
  [/艾瓦佐夫斯基|aivazovsky/i, "Ivan Aivazovsky"],
  [/列维坦|levitan/i, "Isaac Levitan"],
  [/睡莲/, "water lilies"],
  [/海|浪|sea/i, "seascape"],
  [/花|flower/i, "flowers"],
  [/风景|自然|landscape/i, "landscape"],
  [/肖像|portrait/i, "portrait"],
  [/印象|impression/i, "impressionism"],
];
export function localPlan(input: string): Plan {
  const terms = dictionary
    .filter(([pattern]) => pattern.test(input))
    .map(([, term]) => term);
  return {
    query: terms.length ? terms.slice(0, 2).join(" ") : input.trim(),
    explanation: isRecommendationRequest(input)
      ? "你想比较画风并发现其他艺术家。直接检索无法判断风格关联；请在偏好中开启 AI，让策展人先解释相似与差异，再核对开放馆藏中的推荐作品。"
      : "已为你检索开放馆藏。点击作品欣赏细节，也可以把喜欢的作品收入画架。",
  };
}
export function parsePlan(text: string): Plan {
  const parsed = JSON.parse(
    text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
  );
  if (
    typeof parsed.query !== "string" ||
    !parsed.query.trim() ||
    typeof parsed.explanation !== "string"
  )
    throw new Error("AI 返回格式无效，请重试或关闭 AI 使用直接搜索");
  return {
    query: parsed.query.replace(/[":]/g, " ").slice(0, 160),
    explanation: parsed.explanation.slice(0, 1200),
    recommendations: Array.isArray(parsed.recommendations)
      ? parseSuggestions(text)
      : undefined,
  };
}
export async function planSearch(
  input: string,
  history: Message[],
  settings: Settings,
  key: string,
  signal: AbortSignal,
): Promise<Plan> {
  if (!settings.useAi) return localPlan(input);
  if (!desktop) throw new Error("请在桌面版使用 AI；浏览器预览支持直接搜索。");
  const recommendation = isRecommendationRequest(input);
  const artworkContext = history
    .filter((message) => message.artworks?.length)
    .slice(-3)
    .flatMap((message) => (message.artworks || []).slice(0, 2))
    .map(
      (art) =>
        `${art.title} — ${art.artist} (${art.date}); ${art.description.slice(0, 160)}`,
    )
    .join("\n");
  const messages = [
    {
      role: "system",
      content: recommendation
        ? `You are a careful art curator. The user asks for artists or works with a similar style. Use the conversation and the factual artwork metadata below to identify the reference artist or painting. Think through visible/known stylistic traits, then recommend 2-4 OTHER real artists suitable for comparison. Distinguish similarities and meaningful differences; do not treat shared keywords or nationality alone as proof of similar style. Return ONLY JSON {"query":"English name of the first recommended artist","explanation":"Chinese, 100-260 characters: concrete stylistic comparison and why these artists are worth exploring; distinguish facts from interpretation; do not claim you found specific works","recommendations":[{"nameZh":"common Chinese name","nameEn":"canonical English name","query":"English artist name only","reason":"short Chinese comparison with reference"}]}. No URLs or invented painting titles. Artwork context:\n${artworkContext || "No artwork metadata in history; infer reference only from the user wording."}`
        : 'You are an art curator. Interpret the latest request with the conversation context. Return ONLY JSON {"query":"short English Wikimedia Commons search terms (artist and/or subject, no search operators, no URLs)","explanation":"brief Chinese curatorial introduction"}. Prefer 1-3 specific terms. Never claim you have found specific works; search will happen after your reply. Suggest a concrete artist or subject for broad recommendation requests.',
    },
    ...history
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.text.slice(0, 1500) })),
    { role: "user", content: input },
  ];
  const content = await invoke<string>("ai_plan", {
    baseUrl: settings.baseUrl,
    model: settings.model,
    key,
    messages,
  });
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  const plan = parsePlan(content);
  if (recommendation && !plan.recommendations?.length)
    throw new Error("AI 未给出可核对的风格推荐，请换一种说法重试。");
  return plan;
}

export function parseSuggestions(text: string): ArtistSuggestion[] {
  const parsed = JSON.parse(
    text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
  );
  const candidates = parsed.candidates ?? parsed.recommendations;
  if (!Array.isArray(candidates)) throw new Error("AI 未返回可选画家名称");
  return candidates
    .slice(0, 4)
    .filter((candidate: unknown): candidate is ArtistSuggestion => {
      if (!candidate || typeof candidate !== "object") return false;
      const item = candidate as Record<string, unknown>;
      return (
        ["nameZh", "nameEn", "query", "reason"].every(
          (key) =>
            typeof item[key] === "string" &&
            String(item[key]).trim().length > 0,
        ) &&
        String(item.query).length <= 120 &&
        !/https?:\/\/|[\r\n]/i.test(String(item.query))
      );
    });
}

export async function suggestArtists(
  original: string,
  attempted: string,
  settings: Settings,
  signal: AbortSignal,
): Promise<ArtistSuggestion[]> {
  if (!desktop) throw new Error("AI 画家辨认需在桌面版使用");
  const content = await invoke<string>("ai_plan", {
    baseUrl: settings.baseUrl,
    model: settings.model,
    key: "",
    messages: [
      {
        role: "system",
        content:
          'A Wikimedia artwork search found no results. The user may have misspelled or transliterated an artist name. Return ONLY JSON: {"candidates":[{"nameZh":"common Chinese name","nameEn":"canonical English name","query":"canonical English name only","reason":"brief Chinese reason"}]}. Provide at most 4 plausible artist names, with search queries only. Do not invent artwork titles or claim a candidate is certain. If no plausible person, return an empty array.',
      },
      {
        role: "user",
        content: `用户原话：${original.slice(0, 500)}\n未命中的检索词：${attempted.slice(0, 160)}`,
      },
    ],
  });
  if (signal.aborted) throw new DOMException("已停止", "AbortError");
  return parseSuggestions(content);
}

export async function explainArtwork(
  art: Artwork,
  question: string,
  history: Message[],
  settings: Settings,
  signal: AbortSignal,
): Promise<{ text: string; usedImage: boolean }> {
  if (!desktop) throw new Error("作品讲解 AI 请在桌面版使用");
  const context = `作品：${art.title}\n作者：${art.artist}\n年代：${art.date}\n馆藏描述：${art.description || "无"}\n原始来源：${art.source}\n授权标记：${art.license}`;
  const system =
    "你是有耐心的中文艺术讲解员，围绕当前这一幅作品持续回答提问。依据给定馆藏资料与图片进行观察和解释；分清可见事实、一般艺术史知识和你的推测。资料未给出的尺寸、收藏机构、创作动机、逸事不要编造。回答自然、具体、约 2 至 4 段，主动回应用户追问，不要提供画作搜索结果。";
  const previous = history.slice(-8).map((message) => ({
    role: message.role,
    content: message.text.slice(0, 1800),
  }));
  const call = (withImage: boolean) =>
    invoke<string>("ai_plan", {
      baseUrl: settings.baseUrl,
      model: settings.model,
      key: "",
      messages: [
        { role: "system", content: `${system}\n${context}` },
        ...previous,
        {
          role: "user",
          content: withImage
            ? [
                { type: "text", text: question.slice(0, 2000) },
                {
                  type: "image_url",
                  image_url: { url: art.thumb, detail: "low" },
                },
              ]
            : question.slice(0, 2000),
        },
      ],
    });
  try {
    const text = await call(true);
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    return { text, usedImage: true };
  } catch (error) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    if (!/400|422|image|vision|图片|多模态/i.test(String(error))) throw error;
    const text = await call(false);
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    return { text, usedImage: false };
  }
}
