import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const config = {
  runtime: "edge",
};


type ClientMessage = {
  id?: string;
  role: "user" | "model";
  text?: string;
  image?: string;
  // 前端会把 items 一起回传（历史消息）
  items?: AssetResult[];
};

type AssetResult = {
  id: string;
  title: string;
  shopName: string;
  price: string;
  url: string;
  imageUrl?: string;
  description: string;
  tags: string[];
};

type BoothRawItem = {
  id: string;
  title: string;
  shopName: string;
  price: string;
  url: string;
  imageUrl: string;
  // Booth 列表页通常没有完整详情，这里尽力抓；没有就为空
  description: string;
  tags: string[];
  variations?: { name: string; price: number }[];
};

type AgentDecision =
  | { action: "reply"; reply_zh: string }
  | { action: "search"; keyword_ja: string; need_summary_zh: string; page: number }
  | { action: "select"; selected: BatchPick[]; done?: boolean };

type BatchPick = {
  id: string;
  description_zh: string;
  tags: string[];
  reason_zh?: string;
};

function safeJsonParse<T>(raw: string): T | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    // 尝试从文本中提取第一个 JSON 对象/数组
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]) as T;
      } catch {
        return null;
      }
    }
    const arrMatch = s.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter((t) => !!t)
    .slice(0, 10);
}

function extractUserInstruction(messages: ClientMessage[]): { text: string; hasImage: boolean } {
  // 取最后一条 user 消息作为当前指令
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = (m.text || "").trim();
    const hasImage = !!m.image;
    if (text || hasImage) {
      return {
        text: text || "请根据我提供的图片风格与需求，在 Booth 上寻找匹配的 VRChat 资产。",
        hasImage,
      };
    }
  }
  return { text: "请在 Booth 上寻找匹配的 VRChat 资产。", hasImage: false };
}

function extractLastUserImage(messages: ClientMessage[]): string | undefined {
  // 取最后一条带 image 的 user 消息（用于多模态）
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const img = (m.image || "").trim();
    if (!img) continue;
    return img;
  }
  return undefined;
}

function buildRecentConversationForAgent(messages: ClientMessage[], maxTurns: number): string {
  // 只取最近 maxTurns 条，避免 prompt 过长；并携带 items/image 等元信息，帮助理解上下文。
  const start = Math.max(0, messages.length - Math.max(1, maxTurns));
  const sliced = messages.slice(start);

  return sliced
    .map((m, idx) => {
      const role = m.role === "model" ? "assistant" : "user";
      const text = (m.text || "").trim();
      const hasImage = !!m.image;
      const itemsCount = Array.isArray((m as any)?.items) ? ((m as any).items as any[]).length : 0;
      const meta = [
        hasImage ? "hasImage=1" : "hasImage=0",
        itemsCount ? `items=${itemsCount}` : "items=0",
      ].join(",");
      return `#${idx + 1} ${role} (${meta})\n${text || (hasImage ? "[image]" : "")}`.trim();
    })
    .join("\n\n");
}

function compactCandidatesForAgent(items: BoothRawItem[]): any[] {
  // 控制 token：只给 agent 必要字段。
  return (items || []).slice(0, 80).map((x) => ({
    id: x.id,
    title: x.title,
    shopName: x.shopName,
    price: x.price,
    url: x.url,
    description: x.description,
    tags: x.tags,
    variations: x.variations, // 传入规格信息，包含适配模型名称等关键决策依据
  }));
}

async function decideNextStepEndToEnd(params: {
  openai: OpenAI;
  model: string;
  messages: ClientMessage[];
  candidates?: BoothRawItem[];
  candidatesKeywordJa?: string;
  candidatesPage?: number;
  triedKeywords: string[];
  excludeIds: Set<string>;
  pickedIds: Set<string>;
  needMin: number;
  maxPick: number;
  signal?: AbortSignal;
  language?: string;
}): Promise<AgentDecision> {
  const {
    openai,
    model,
    messages,
    candidates,
    candidatesKeywordJa,
    candidatesPage,
    triedKeywords,
    excludeIds,
    pickedIds,
    needMin,
    maxPick,
    signal,
    language = "zh",
  } = params;

  const { text: userInstruction, hasImage } = extractUserInstruction(messages);
  const lastUserImage = extractLastUserImage(messages);
  const hint = extractLastKeywordAndPageHint(messages);
  const conversation = buildRecentConversationForAgent(messages, 18);

  const langName = language.startsWith("en") ? "English" : language.startsWith("ja") ? "Japanese" : "Chinese";

  const system = {
    role: "system",
    content: [
      "你是一个叫璃璃的可爱助手，是用户的 VRChat Booth 资产查找助手。你的语气比较可爱，随时愿意为用户提供帮助！",
      `\n用户当前的语言偏好是：${langName}。请务必使用 ${langName} 进行回复（reply_zh / reason_zh / need_summary_zh 字段的内容请使用 ${langName}）。`,
      "\n你需要根据【完整对话上下文】决定下一步动作：",
      "\n- action=reply：直接回复（闲聊/感谢/问怎么用/非找商品）。回复时请保持璃璃可爱的语气。",
      "\n- action=search：生成用于 Booth 搜索的日文关键词与页码，并给出需求摘要。",
      "\n- action=select：当提供了 candidates 时，从 candidates 中挑选商品。",
      "\n\n重要规则：",
      "\n1) 输出必须是严格 JSON（不要 Markdown，不要解释）。",
      "\n2) keyword_ja 必须是日文（可包含空格）；page 为正整数。",
      "\n3) 若用户在续聊（例如下一页/更多/换关键词），要结合 hint/上下文理解。",
      "\n4) select 时只能从 candidates 里选，且不要选 exclude_ids/picked_ids；最多选择 max_pick 个。",
      "\n5) 若不确定，优先 search（不要错过用户检索意图）。",
      "\n\n输出格式三选一：",
      "\n- {\"action\":\"reply\",\"reply_zh\":\"...\"}",
      "\n- {\"action\":\"search\",\"keyword_ja\":\"...\",\"need_summary_zh\":\"...\",\"page\":1}",
      "\n- {\"action\":\"select\",\"selected\":[{\"id\":\"...\",\"description_zh\":\"...\",\"tags\":[\"...\"],\"reason_zh\":\"...\"}],\"done\":true}",
    ].join(""),
  };

  const candidates_info = candidates
    ? {
        keyword_ja: candidatesKeywordJa,
        page: candidatesPage,
        candidates: compactCandidatesForAgent(candidates),
      }
    : null;

  const userPayloadText = JSON.stringify(
    {
      conversation,
      user_instruction: userInstruction,
      has_image: hasImage,
      hint,
      tried_keywords: triedKeywords,
      exclude_ids: Array.from(excludeIds).slice(0, 200),
      picked_ids: Array.from(pickedIds).slice(0, 200),
      picked_count: pickedIds.size,
      need_min: needMin,
      max_pick: maxPick,
      candidates_info,
    },
    null,
    0
  );

  // 关键修复：之前只传了 has_image=true，但没有把图片内容传给模型，模型当然“看不到图片”。
  // 这里在最后一条 user 消息包含 image 时，使用 OpenAI 兼容的多模态 content 格式传入。
  const user: any = lastUserImage
    ? {
        role: "user",
        content: [
          { type: "text", text: userPayloadText },
          { type: "image_url", image_url: { url: lastUserImage } },
        ],
      }
    : {
        role: "user",
        content: userPayloadText,
      };

  let res;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 强制 30s 超时控制，防止 API 挂起无响应，超时自动重试
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      // 合并传入的 signal
      if (signal) {
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort);
      }

      console.log(`[Agent] decideNextStep attempt ${attempt}/3...`);
      res = await openai.chat.completions.create(
        {
          model,
          messages: [system as any, user as any] as any,
          temperature: 0.2,
        },
        { signal: controller.signal } as any
      ).finally(() => clearTimeout(timeoutId));
      
      // 成功则跳出重试循环
      break;
    } catch (e: any) {
      lastError = e;
      const isTimeout = e?.name === 'AbortError' || e?.message?.includes('timeout');
      console.warn(`[Agent] attempt ${attempt} failed: ${e?.message || e} (timeout=${isTimeout})`);
      
      if (signal?.aborted) {
        throw e; // 用户主动中断，不重试
      }
      
      if (attempt === 3) {
        console.error("[Agent] decideNextStep final failure after 3 attempts.");
        return { action: "reply", reply_zh: "抱歉喵，璃璃刚才非常努力地思考了，但大脑还是有点转不过来... 可能是网络不太通畅，咱们稍后再试好不好喵？" };
      }
      // 继续下一次尝试
    }
  }

  const raw = (res?.choices?.[0] as any)?.message?.content || "";
  console.log(`[Agent] RAW Response: ${raw}`);

  const parsed = safeJsonParse<any>(raw) || {};
  console.log(`[Agent] PARSED Decision:`, JSON.stringify(parsed));

  // 兜底校验：如果 parsed 为空或没有合法 action
  if (!parsed || !parsed.action) {
    console.warn("[Agent] Invalid decision JSON:", raw);
    return { action: "reply", reply_zh: "璃璃刚才想得太投入了，结果没组织好语言喵... 请再给璃璃一次机会喔！" };
  }

  if (parsed?.action === "reply") {
    const reply = typeof parsed?.reply_zh === "string" ? parsed.reply_zh.trim() : "";
    return {
      action: "reply",
      reply_zh: reply || "你可以告诉我你想找的 Booth 资产类型与条件（例如衣装/发型/道具、风格、预算等），我来帮你筛选。",
    };
  }

  if (parsed?.action === "select") {
    const selected = Array.isArray(parsed?.selected) ? (parsed.selected as any[]) : [];
    const out: BatchPick[] = [];
    for (const s of selected) {
      const id = s?.id ? String(s.id) : "";
      if (!id) continue;
      if (excludeIds.has(id) || pickedIds.has(id)) continue;
      out.push({
        id,
        description_zh: typeof s?.description_zh === "string" ? String(s.description_zh).trim() : "",
        tags: normalizeTags(s?.tags),
        reason_zh: typeof s?.reason_zh === "string" ? String(s.reason_zh).trim() : undefined,
      });
    }
    return { action: "select", selected: out.slice(0, Math.max(0, maxPick)), done: !!parsed?.done };
  }

  // 默认 search
  const keyword_ja = typeof parsed?.keyword_ja === "string" ? parsed.keyword_ja.trim() : "";
  const need_summary_zh = typeof parsed?.need_summary_zh === "string" ? parsed.need_summary_zh.trim() : "";
  const page = Number.isFinite(parsed?.page) ? Math.max(1, Math.trunc(parsed.page)) : 1;
  return {
    action: "search",
    keyword_ja: keyword_ja || hint.keywordJa || userInstruction.slice(0, 24),
    need_summary_zh: need_summary_zh || "用户希望找到匹配条件的 VRChat 资产。",
    page,
  };
}

function collectPreviouslyShownIds(messages: ClientMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const items = (m as any)?.items as AssetResult[] | undefined;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it?.id) ids.add(String(it.id));
    }
  }
  return ids;
}

function extractLastKeywordAndPageHint(messages: ClientMessage[]): { keywordJa?: string; page?: number } {
  // 从历史 assistant 文本里尽量解析：
  // “当前关键词（日文）：xxx；当前页码：n”
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "model") continue;
    const t = (m.text || "");
    const kw = t.match(/当前关键词（?日文）?\s*[:：]\s*([^；\n\r]+)/);
    const pg = t.match(/当前页码\s*[:：]\s*(\d+)/);
    if (kw || pg) {
      const keywordJa = kw?.[1]?.trim();
      const page = pg?.[1] ? Number(pg[1]) : undefined;
      return {
        keywordJa: keywordJa || undefined,
        page: Number.isFinite(page as number) ? (page as number) : undefined,
      };
    }
  }
  return {};
}

function buildBoothItemJsonUrl(item: { id?: string; url?: string }): string {
  const id = String(item.id || "").trim();
  const url = String(item.url || "").trim();
  if (url) {
    const noHash = url.split("#")[0];
    const noQuery = noHash.split("?")[0];
    const normalized = noQuery.replace(/\/+$/, "");
    if (/\/items\/\d+$/i.test(normalized)) return `${normalized}.json`;
  }
  if (id) return `https://booth.pm/ja/items/${encodeURIComponent(id)}.json`;
  return "";
}

function extractPreviewImageFromBoothJson(data: any): string {
  const candidates = [
    data?.image?.original,
    data?.image?.resized,
    data?.image?.url,
    data?.image_url,
    data?.thumbnail_url,
    data?.main_image_url,
    data?.images?.[0]?.original,
    data?.images?.[0]?.resized,
    data?.images?.[0]?.url,
    data?.images?.[0]?.original_file?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function appendDeterministicPicks(params: {
  pageItems: BoothRawItem[];
  picked: AssetResult[];
  pickedIds: Set<string>;
  exclude: Set<string>;
  maxPick: number;
}): number {
  const { pageItems, picked, pickedIds, exclude, maxPick } = params;
  let added = 0;
  for (const raw of pageItems) {
    if (!raw?.id || !raw?.url) continue;
    if (exclude.has(raw.id) || pickedIds.has(raw.id)) continue;
    pickedIds.add(raw.id);
    picked.push({
      id: raw.id,
      title: raw.title,
      shopName: raw.shopName,
      price: raw.price,
      url: raw.url,
      imageUrl: raw.imageUrl,
      description: raw.description || "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
    });
    added++;
    if (picked.length >= maxPick) break;
  }
  return added;
}

async function enrichPickedItemsPreviewImage(items: AssetResult[]): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      const jsonUrl = buildBoothItemJsonUrl(item);
      if (!jsonUrl) return;
      try {
        const res = await fetch(jsonUrl, {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
          },
        });
        if (!res.ok) return;
        const data = await res.json();
        const preview = extractPreviewImageFromBoothJson(data);
        if (preview) item.imageUrl = preview;
      } catch {
        // ignore per-item fetch errors
      }
    })
  );
}

async function generateQueryEmbedding(params: {
  apiKey: string;
  baseURL: string;
  modelName: string;
  text: string;
  targetDimension: number;
}): Promise<number[] | null> {
  const { apiKey, baseURL, modelName, text, targetDimension } = params;
  try {
    let root = baseURL.replace(/\/$/, "");
    let version = "v1beta";
    if (root.includes("/v1beta")) {
      root = root.replace("/v1beta", "");
    } else if (root.includes("/v1")) {
      root = root.replace("/v1", "");
      version = "v1";
    }
    const url = `${root}/${version}/models/${modelName}:embedContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Proxy-Api-Key": apiKey,
      },
      body: JSON.stringify({
        model: modelName,
        content: { parts: [{ text }] },
      }),
    });
    if (!response.ok) {
      const msg = await response.text();
      throw new Error(`Embedding API ${response.status}: ${msg}`);
    }
    const data = await response.json();
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    const arr = values.map((v: any) => Number(v) || 0);
    if (!Number.isFinite(targetDimension) || targetDimension <= 0) return arr;
    if (arr.length === targetDimension) return arr;
    if (arr.length > targetDimension) return arr.slice(0, targetDimension);
    return [...arr, ...new Array(targetDimension - arr.length).fill(0)];
  } catch (e: any) {
    console.warn("[Vector] generateQueryEmbedding failed:", e?.message || e);
    return null;
  }
}

async function executeVectorSearchRemote(params: {
  query: string;
  offset: number;
  pageSize: number;
  apiKey: string;
  baseURL: string;
  embeddingModel: string;
  targetDimension: number;
  minScore: number;
  searchApiUrl?: string;
  searchApiToken?: string;
}): Promise<{ items: BoothRawItem[]; totalMatched: number; hasMore: boolean; nextOffset: number | null }> {
  const {
    query,
    offset,
    pageSize,
    apiKey,
    baseURL,
    embeddingModel,
    targetDimension,
    minScore,
    searchApiUrl,
    searchApiToken,
  } = params;

  if (!searchApiUrl || !searchApiToken || !apiKey || !baseURL) {
    throw new Error("Vector search configuration missing");
  }
  const embedding = await generateQueryEmbedding({
    apiKey,
    baseURL,
    modelName: embeddingModel,
    text: query,
    targetDimension,
  });
  if (!embedding) throw new Error("Failed to generate query embedding");

  const normalizedOffset = Math.max(0, Math.trunc(offset || 0));
  const response = await fetch(`${searchApiUrl.replace(/\/$/, "")}/v1/search_by_embedding`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${searchApiToken}`,
    },
    body: JSON.stringify({
      query_text: query,
      embedding,
      limit: pageSize,
      offset: normalizedOffset,
      min_score: minScore,
    }),
  });

  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`Search API ${response.status}: ${msg}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const items = rows.map((row: any) => ({
    id: String(row.id || ""),
    title: row.title || "No Title",
    shopName: row.shop_name || "Unknown Shop",
    price: row.price || "Unknown",
    url: row.url || "",
    imageUrl: row.image_url || "",
    description: row.description || "",
    tags: Array.isArray(row.tags) ? row.tags : [],
    variations: [],
  })).filter((x: BoothRawItem) => !!x.id && !!x.url);
  return {
    items,
    totalMatched: Number(payload?.total_matched || 0),
    hasMore: !!payload?.has_more,
    nextOffset: typeof payload?.next_offset === "number" ? payload.next_offset : null,
  };
}

async function executeVectorSearchRemoteMultiPage(params: {
  query: string;
  page: number;
  pageSize: number;
  targetFetch: number;
  maxPages: number;
  minScore: number;
  apiKey: string;
  baseURL: string;
  embeddingModel: string;
  targetDimension: number;
  searchApiUrl?: string;
  searchApiToken?: string;
}): Promise<{ items: BoothRawItem[]; fetchedCount: number; hasNextPage: boolean; totalMatched: number }> {
  const {
    query,
    page,
    pageSize,
    targetFetch,
    maxPages,
    minScore,
    apiKey,
    baseURL,
    embeddingModel,
    targetDimension,
    searchApiUrl,
    searchApiToken,
  } = params;

  const startOffset = Math.max(0, (Math.max(1, page) - 1) * pageSize);
  let offset = startOffset;
  let totalMatched = 0;
  let hasMore = false;
  const out: BoothRawItem[] = [];
  const seen = new Set<string>();
  const safeTarget = Math.max(1, targetFetch);
  const safeMaxPages = Math.max(1, maxPages);

  for (let i = 0; i < safeMaxPages && out.length < safeTarget; i++) {
    const remaining = safeTarget - out.length;
    const onePageSize = Math.max(1, Math.min(pageSize, remaining));
    const result = await executeVectorSearchRemote({
      query,
      offset,
      pageSize: onePageSize,
      minScore,
      apiKey,
      baseURL,
      embeddingModel,
      targetDimension,
      searchApiUrl,
      searchApiToken,
    });

    totalMatched = Math.max(totalMatched, result.totalMatched);
    hasMore = !!result.hasMore;

    for (const item of result.items) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= safeTarget) break;
    }

    if (!result.hasMore) break;
    offset = typeof result.nextOffset === "number" ? result.nextOffset : offset + onePageSize;
  }

  return {
    items: out,
    fetchedCount: out.length,
    hasNextPage: hasMore,
    totalMatched,
  };
}

interface ConsumeTurnResponse {
  allowed: boolean;
  reason?: string;
  session_turn_count?: number;
  daily_turn_count?: number;
  session_limit?: number;
  daily_limit?: number;
}

function withJsonHeaders(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function turnMetaHeaders(meta?: ConsumeTurnResponse): Record<string, string> {
  if (!meta) return {};
  const h: Record<string, string> = {};
  if (typeof meta.session_turn_count === 'number') h['x-session-turn-count'] = String(meta.session_turn_count);
  if (typeof meta.daily_turn_count === 'number') h['x-daily-turn-count'] = String(meta.daily_turn_count);
  if (typeof meta.session_limit === 'number') h['x-session-limit'] = String(meta.session_limit);
  if (typeof meta.daily_limit === 'number') h['x-daily-limit'] = String(meta.daily_limit);
  return h;
}

export default async function handler(req: any) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    let body;
    if (typeof req.json === 'function') body = await req.json();
    else body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    const { messages, chat_id, language } = body as { messages?: any[]; chat_id?: string; language?: string };
    const apiKey = process.env.GEMINI_API_KEY;
    const baseURL = process.env.GEMINI_API_BASE_URL;
    const embeddingApiKey = process.env.GEMINI_EMBEDDING_API_KEY || apiKey;
    const embeddingBaseURL = process.env.GEMINI_EMBEDDING_API_BASE_URL || baseURL;
    const modelName = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
    const embeddingModelName = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
    const vectorEmbeddingDimension = Number(process.env.VECTOR_EMBEDDING_DIMENSION || 2000);
    const vectorSearchApiUrl = process.env.VECTOR_SEARCH_API_URL || 'https://booth-embedding.vrc.one/';
    const vectorSearchApiToken = process.env.VECTOR_SEARCH_API_TOKEN;
    const vectorSearchPageSize = Math.max(1, Number(process.env.VECTOR_SEARCH_PAGE_SIZE || 60));
    const vectorSearchMaxPages = Math.max(1, Number(process.env.VECTOR_SEARCH_MAX_PAGES || 4));
    const vectorSearchTargetFetch = Math.max(1, Number(process.env.VECTOR_SEARCH_TARGET_FETCH || (vectorSearchPageSize * vectorSearchMaxPages)));
    const vectorSearchMinScore = Number(process.env.VECTOR_SEARCH_MIN_SCORE || 0.45);

    // 轮数限制：需要用户 JWT + chat_id
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const authHeader = (req?.headers && typeof req.headers.get === 'function')
      ? (req.headers.get('authorization') || '')
      : '';
    const token = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7)
      : '';

    if (!Array.isArray(messages)) return withJsonHeaders(400, { error: 'Invalid messages' });

    if (!chat_id) {
      return withJsonHeaders(400, { error: 'Missing chat_id' });
    }

    const visitorId = (req?.headers && typeof req.headers.get === 'function')
      ? (req.headers.get('x-visitor-id') || '')
      : '';

    if (!token && !visitorId) {
      return withJsonHeaders(401, { error: 'Missing authentication' });
    }

    if (!supabaseUrl || !supabaseAnonKey) {
      return withJsonHeaders(500, { error: 'Configuration Error: SUPABASE_URL / SUPABASE_ANON_KEY missing' });
    }

    if (!apiKey) return new Response('Configuration Error: GEMINI_API_KEY missing', { status: 500 });
    if (!embeddingApiKey || !embeddingBaseURL) {
      return new Response('Configuration Error: GEMINI_EMBEDDING_API_KEY / GEMINI_EMBEDDING_API_BASE_URL missing', { status: 500 });
    }
    if (!vectorSearchApiUrl || !vectorSearchApiToken) {
      return new Response('Configuration Error: VECTOR_SEARCH_API_URL / VECTOR_SEARCH_API_TOKEN missing', { status: 500 });
    }

    // 在真正调用模型前，先消耗 1 次对话轮数（原子校验/递增）
    let turnMeta: ConsumeTurnResponse | undefined;
    try {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      });

      if (token) {
        // 已登录用户逻辑
        const { data, error } = await supabase.rpc('consume_turn', { p_chat_id: chat_id }).single();
        if (error) {
          console.error('[Turns] consume_turn error:', error);
          return withJsonHeaders(500, { error: error.message });
        }

        const consumeData = data as ConsumeTurnResponse;
        turnMeta = consumeData;
        if (!consumeData?.allowed) {
          return new Response(
            JSON.stringify({
              error: 'TURN_LIMIT',
              reason: consumeData?.reason,
              session_turn_count: consumeData?.session_turn_count,
              daily_turn_count: consumeData?.daily_turn_count,
              session_limit: consumeData?.session_limit,
              daily_limit: consumeData?.daily_limit,
            }),
            { status: 429, headers: { 'content-type': 'application/json', ...turnMetaHeaders(consumeData) } }
          );
        }
      } else {
        // 游客逻辑
        const { data, error } = await supabase.rpc('consume_guest_turn', { p_visitor_id: visitorId }).single();
        if (error) {
          console.error('[Turns] consume_guest_turn error:', error);
          return withJsonHeaders(500, { error: error.message });
        }

        const consumeData = data as any;
        if (!consumeData?.allowed) {
          return new Response(
            JSON.stringify({
              error: 'TURN_LIMIT',
              reason: consumeData?.reason || 'limit_reached',
              current_count: consumeData?.current_count,
              limit_count: consumeData?.limit_count,
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'x-session-turn-count': String(consumeData?.current_count || 0),
                'x-session-limit': String(consumeData?.limit_count || 3),
              }
            }
          );
        }
        // 游客模式：借用 session 字段返回进度
        turnMeta = {
          allowed: true,
          session_turn_count: consumeData?.current_count,
          session_limit: consumeData?.limit_count,
        };
      }
    } catch (e: any) {
      console.error('[Turns] consumption failed:', e?.message || e);
      return withJsonHeaders(500, { error: e?.message || 'turn consumption failed' });
    }

    const openai = new OpenAI({ apiKey, baseURL });

    // 用 TransformStream 比 ReadableStream(controller.enqueue) 在一些平台上更不容易被整体缓冲
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // “终止生成”：当客户端中断 fetch / 连接关闭时，req.signal 会 abort
    let stopped = false;
    const requestSignal: AbortSignal | undefined = (req as any)?.signal;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await writer.close();
      } catch {
        // ignore
      }
    };
    if (requestSignal && typeof requestSignal.addEventListener === "function") {
      requestSignal.addEventListener("abort", () => {
        // 不能 await，这里尽快触发关闭
        void stop();
      });
    }

    (async () => {
      // 让 streamAssistantReply 等内部函数可以复用解析后的 clientMessages。
      // 注意：之前把 clientMessages 定义在 try 块里，会导致外层函数引用时报 TS 错误（例如第 618 行）。
      const clientMessages = messages as ClientMessage[];

      const write = async (text: string) => {
        if (stopped) return;
        await writer.write(encoder.encode(String(text)));
      };

      const flush = async () => {
        if (stopped) return;
        // 让出事件循环，给运行时/反代机会把已写入的数据刷到前端。
        await new Promise<void>((r) => setTimeout(r, 0));
      };

      const writeStatus = async (status: string) => {
        if (stopped) return;
        // 某些平台/反代会对“小 chunk”整体缓冲，导致前端看起来“不是流式”。
        // 这里把每次 status 也扩充到一个相对可观的大小（但不污染正文，因为都在 __STATUS__ 行内）。
        const trimmed = String(status ?? "");
        const targetChars = 2048;
        const padLen = Math.max(0, targetChars - trimmed.length);
        await write(`__STATUS__:${trimmed}${" ".repeat(padLen)}\n`);
        await flush();
      };

      const writeMeta = async (meta: {
        keyword_ja: string;
        page: number;
        fetched_count: number;
        total_matched: number;
        has_next_page: boolean;
      }) => {
        if (stopped) return;
        await write(`__STATUS__:__META__:${JSON.stringify(meta)}\n`);
        await flush();
      };

      const streamAssistantReply = async (params: {
        userInstruction: string;
        needSummaryZh: string;
        items: AssetResult[];
        keywordJa: string;
        page: number;
        fetchedCount: number;
        hasNextPage: boolean;
        totalMatched: number;
      }) => {
        if (stopped) return;
        const { userInstruction, needSummaryZh, items, keywordJa, page, fetchedCount, hasNextPage, totalMatched } = params;

        const itemsJson = JSON.stringify(items, null, 2);
        const langName = language?.startsWith("en") ? "English" : language?.startsWith("ja") ? "Japanese" : "Chinese";
        
        const system = {
          role: "system",
          content: [
            "你是一个叫璃璃的可爱助手，是用户的 VRChat Booth 资产查找助手。你的语气比较可爱，随时愿意为用户提供帮助！",
            `\n用户当前的语言偏好是：${langName}。请务必使用 ${langName} 进行回复。`,
            "\n你将收到用户指令、需求摘要、以及后端筛选出的真实商品数组 items（JSON）。",
            "\n你还会收到：本次取回的候选总数 fetched_count、总匹配数 total_matched、以及是否还有更多匹配 has_next_page。",
            "\n你的任务：给出推荐/说明。回复时请保持璃璃可爱的语气。",
            "\n- 你必须基于 has_next_page 判断是否还有更多匹配：",
            "\n  - has_next_page=true：说明还有更多匹配，请建议用户进一步细化条件（关键词、标签、价格、风格）。",
            "\n  - has_next_page=false：说明当前条件下已基本检索完，可建议用户换关键词或放宽条件。",
            "\n- 本系统是向量检索，不要建议用户翻页抓取；优先建议调整关键词、标签、风格或价格条件。",
            "\n- items 只是你最终挑选给用户展示的结果，数量可能远小于 fetched_count。不要用 items 的数量去推断是否还有下一页。",
            "\n重要规则：",
            "\n1) 禁止编造商品，只能基于 items。",
            "\n2) 必须使用 Markdown。",
            "\n2.1) 严禁在回复中出现字符串：__STATUS__: （这是前端的流式状态标记，会干扰解析）。",
            "\n3) 在 JSON 代码块之前，输出一行：当前关键词：<keyword>；当前页码：<page>。",
            "\n   - 无论 has_next_page 是否为 true，都要输出当前页码（方便前端续聊）；并且不要输出参数名字例如 fetched_count、total_matched、has_next_page。",
            "\n4) 回复的最后必须包含一个 JSON 代码块，并且该 JSON 必须【原样】等于提供的 items_json（不要增删字段、不要改值、不要改变数组顺序）。",
            "\n5) 除了这个 JSON 代码块以外，不要输出其它代码块。",
          ].join(""),
        };
        const userText = [
          `用户指令：${userInstruction}`,
          `\n需求摘要：${needSummaryZh}`,
          `\nkeyword_ja：${keywordJa}`,
          `\npage：${page}`,
          `\nfetched_count：${fetchedCount}`,
          `\ntotal_matched：${totalMatched}`,
          `\nhas_next_page：${hasNextPage ? "true" : "false"}`,
          "\nitems_json（必须原样输出到你回复末尾的 json 代码块）：\n" + itemsJson,
        ].join("");

        // 若本轮用户有上传图片，把图片也传给最终回复模型，让它能基于图片进行描述/检索建议。
        // 注意：这里复用“最后一条带图片的 user 消息”，不重复携带历史图片，避免 token/体积暴涨。
        const lastUserImage = extractLastUserImage(clientMessages);

        const user: any = lastUserImage
          ? {
              role: "user",
              content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: lastUserImage } },
              ],
            }
          : { role: "user", content: userText };

        const response = await openai.chat.completions.create(
          {
            model: modelName,
            messages: [system as any, user as any] as any,
            temperature: 0.2,
            stream: true,
          },
          // 最终流式回复可以给长一点超时，或者依赖 global 请求超时
          requestSignal ? ({ signal: requestSignal } as any) : undefined
        );

        for await (const chunk of response as any) {
          if (stopped) break;
          const delta = chunk?.choices?.[0]?.delta;
          const content = delta?.content;
          if (content) await write(content);
        }
      };

      // 有些部署环境/反代会对小响应做缓冲，导致“看起来不流式”。
      // 这里通过：
      // 1) 使用 SSE 友好 header（见下方 Response headers）
      // 2) 发送 padding，尽早触发首包 flush
      // 3) 后续文本完全由模型流式生成（不再插入手工提示语）
      const sendPadding = async () => {
        if (stopped) return;
        // 8KB：更接近常见代理 flush 阈值，确保前端能尽早拿到首包。
        await write(" ".repeat(8192) + "\n");
      };

      try {
        const excludeIds = collectPreviouslyShownIds(clientMessages);
        const { text: userInstruction } = extractUserInstruction(clientMessages);

        if (stopped) return;

        // 先发一次 status + padding：确保前端能立刻收到首包并开始展示状态。
        await writeStatus("收到请求，正在处理...");
        await sendPadding();
        await flush();

        await writeStatus("正在理解你的需求...");

        const minNeed = 5;
        const maxPick = 15;
        const maxSteps = 4;

        const picked: AssetResult[] = [];
        const pickedIds = new Set<string>();
        const exclude = new Set<string>(excludeIds);
        const triedKeywords: string[] = [];

        // 用于最终回复：告诉 assistant “本次抓取的候选数量”与“是否可能有下一页”
        // 说明：Booth 搜索通常一页最多 ~60 条；抓取到 60 往往意味着还有下一页（经验启发式）。
        let lastFetchedCount = 0;
        let lastTotalMatched = 0;
        let lastHasNextPage = false;

        // Step 1: 让 agent 基于完整上下文决定：直接回复 or 发起搜索
        await writeStatus("璃璃正在规划下一步...");
        const first = await decideNextStepEndToEnd({
          openai,
          model: modelName,
          messages: clientMessages,
          triedKeywords,
          excludeIds: exclude,
          pickedIds,
          needMin: minNeed,
          maxPick,
          signal: requestSignal,
          language,
        });

        if (stopped) return;

        if (first.action === "reply") {
          await write(first.reply_zh);
          await writer.close();
          return;
        }

        let currentKeywordJa = first.action === "search" ? first.keyword_ja : userInstruction.slice(0, 24);
        let currentPage = first.action === "search" ? first.page : 1;
        let needSummaryZh = first.action === "search" ? first.need_summary_zh : "用户希望找到匹配条件的 VRChat 资产。";
        if (currentKeywordJa) triedKeywords.push(currentKeywordJa);

        // Step 2..N: loop（search -> fetch -> deterministic pick -> (optional) next search）
        for (let step = 0; step < maxSteps; step++) {
          if (stopped) return;
          await writeStatus(`正在检索向量索引：关键词「${currentKeywordJa}」，起始页 ${currentPage}...`);
          let pageItems: BoothRawItem[] = [];
          try {
            const searchResult = await executeVectorSearchRemoteMultiPage({
              query: currentKeywordJa,
              page: currentPage,
              pageSize: vectorSearchPageSize,
              targetFetch: vectorSearchTargetFetch,
              maxPages: vectorSearchMaxPages,
              minScore: vectorSearchMinScore,
              apiKey: embeddingApiKey || "",
              baseURL: embeddingBaseURL || "",
              embeddingModel: embeddingModelName,
              targetDimension: vectorEmbeddingDimension,
              searchApiUrl: vectorSearchApiUrl,
              searchApiToken: vectorSearchApiToken,
            });
            pageItems = searchResult.items;
            lastFetchedCount = searchResult.fetchedCount;
            lastTotalMatched = searchResult.totalMatched;
            lastHasNextPage = searchResult.hasNextPage;
            console.log(
              `[Vector] query="${currentKeywordJa}" page=${currentPage} fetched=${searchResult.fetchedCount} total=${searchResult.totalMatched} has_more=${searchResult.hasNextPage}`
            );
            await writeMeta({
              keyword_ja: currentKeywordJa,
              page: currentPage,
              fetched_count: searchResult.fetchedCount,
              total_matched: searchResult.totalMatched,
              has_next_page: searchResult.hasNextPage,
            });
          } catch (e: any) {
            console.error(`[Vector] remote search failed: ${e?.message || e}`);
            throw e;
          }
          if (stopped) return;
          const addedCount = appendDeterministicPicks({
            pageItems,
            picked,
            pickedIds,
            exclude,
            maxPick,
          });
          await writeStatus(`抓取到 ${pageItems.length} 条，确定性筛选新增 ${addedCount} 条。`);

          if (picked.length >= minNeed || picked.length >= maxPick) break;
          if (step >= maxSteps - 1) break;

          await writeStatus("结果不足，璃璃正在决定下一步检索策略...");
          let next: AgentDecision;
          try {
            next = await decideNextStepEndToEnd({
              openai,
              model: modelName,
              messages: clientMessages,
              triedKeywords,
              excludeIds: exclude,
              pickedIds,
              needMin: minNeed,
              maxPick,
              signal: requestSignal,
              language,
            });
          } catch (e: any) {
            console.error(`[Agent] Loop Step ${step} Next Decision Error:`, e?.message || e);
            break;
          }

          if (stopped) return;
          if (next.action === "reply") {
            await write(next.reply_zh);
            await writer.close();
            return;
          }
          if (next.action === "search") {
            currentKeywordJa = next.keyword_ja || currentKeywordJa;
            currentPage = next.page || 1;
            needSummaryZh = next.need_summary_zh || needSummaryZh;
            if (currentKeywordJa && !triedKeywords.includes(currentKeywordJa)) triedKeywords.push(currentKeywordJa);
            continue;
          }

          // Fallback: keep current keyword and advance page when no clear search action.
          currentPage += 1;
          continue;
        }

        // 所有可见回复由 agent 生成（流式输出），不再手工拼接文案。
        await writeStatus("璃璃正在生成最终回复...");
        await enrichPickedItemsPreviewImage(picked);
        await streamAssistantReply({
          userInstruction,
          needSummaryZh,
          items: picked,
          keywordJa: currentKeywordJa,
          page: currentPage,
          fetchedCount: lastFetchedCount,
          hasNextPage: lastHasNextPage,
          totalMatched: lastTotalMatched,
        });

        if (!stopped) await writer.close();
      } catch (e: any) {
        if (!stopped) {
          console.error("[OpenAI] Error:", e?.message || e);
          try {
            await write(`\n\nError: ${e?.message || e}`);
          } finally {
            await writer.close();
          }
        }
      }
    })();

    return new Response(readable, {
      headers: {
        // 使用 event-stream 头部更容易让平台/代理关闭缓冲（即便我们发送的不是严格 SSE data: 格式，fetch reader 仍可正常读取）
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform 可避免某些 CDN/代理对响应做压缩/缓冲
        'Cache-Control': 'no-cache, no-transform',
        // 让 Nginx/部分反代关闭缓冲（如果存在）
        'X-Accel-Buffering': 'no',
        ...turnMetaHeaders(turnMeta),
      }
    });

  } catch (e: any) {
    console.error("[API] Handler Error:", e.message);
    return withJsonHeaders(500, { error: e.message });
  }
}
