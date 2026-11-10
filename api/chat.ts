import OpenAI from "openai";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const config = {
  runtime: "edge",
};


type ClientItem = {
  id: string;
  title?: string;
  tags?: string[];
};

type ClientMessage = {
  id?: string;
  role: "user" | "model";
  text?: string;
  image?: string;
  // 前端只回传精简后的商品信息（id/title/tags），用于去重和上下文指代
  items?: ClientItem[];
  // 历史消息的图片不会被重复上传，用这个标记让模型知道该条消息曾带图
  hasImage?: boolean;
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
  | {
      action: "search";
      keyword_ja: string;
      keywords_ja?: string[];
      targets_zh?: string[];
      need_summary_zh: string;
      page: number;
    }
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

function extractUserInstruction(messages: ClientMessage[]): { text: string; image?: string; hasImage: boolean } {
  // 取最后一条 user 消息作为当前指令；图片也只取这一条，
  // 避免把历史参考图当作本轮输入重复注入。
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = typeof m.text === "string" ? m.text.trim() : "";
    const image = typeof m.image === "string" ? m.image.trim() || undefined : undefined;
    if (text || image) {
      return {
        text: text || "请根据我提供的图片风格与需求，在 Booth 上寻找匹配的 VRChat 资产。",
        image,
        hasImage: !!image,
      };
    }
  }
  return { text: "请在 Booth 上寻找匹配的 VRChat 资产。", image: undefined, hasImage: false };
}

function buildRecentConversationForAgent(messages: ClientMessage[], maxTurns: number): string {
  // 只取最近 maxTurns 条，避免 prompt 过长；并携带 items/image 等元信息，帮助理解上下文。
  const start = Math.max(0, messages.length - Math.max(1, maxTurns));
  const sliced = messages.slice(start);

  // 只给最近两条带商品的 assistant 消息附摘要，控制 token，
  // 同时让模型理解“刚才那件 / 换成别的”等指代。
  const briefIdx = new Set<number>();
  for (let i = sliced.length - 1; i >= 0 && briefIdx.size < 2; i--) {
    const m = sliced[i];
    if (m?.role === "model" && Array.isArray(m.items) && m.items.length > 0) briefIdx.add(i);
  }

  return sliced
    .map((m, idx) => {
      const role = m.role === "model" ? "assistant" : "user";
      const text = typeof m.text === "string" ? m.text.trim() : "";
      const hasImage = !!m.image || !!m.hasImage;
      const items = Array.isArray(m.items) ? m.items.filter((it) => !!it && typeof it === "object") : [];
      const meta = [
        hasImage ? "hasImage=1" : "hasImage=0",
        items.length ? `items=${items.length}` : "items=0",
      ].join(",");
      const shown = briefIdx.has(idx) && items.length
        ? `\n[已展示] ${items
            .slice(0, 12)
            .map((it) => {
              const tags = (it.tags || []).slice(0, 3).join("/");
              return `${it.title || it.id}${tags ? `（${tags}）` : ""}`;
            })
            .join("；")}`
        : "";
      return `#${idx + 1} ${role} (${meta})\n${text || (hasImage ? "[image]" : "")}${shown}`.trim();
    })
    .join("\n\n");
}

function compactCandidatesForAgent(items: BoothRawItem[]): any[] {
  // 控制 token：只给 agent 必要字段，并对长文本做截断。
  // 多目标检索时一条候选可能来自不同关键词，因此保留顺序、由上游做类目交错合并。
  return (items || []).slice(0, 100).map((x) => ({
    id: x.id,
    title: x.title,
    shopName: x.shopName,
    price: x.price,
    url: x.url,
    description: (x.description || "").slice(0, 240),
    tags: (x.tags || []).slice(0, 10),
    variations: x.variations ? x.variations.slice(0, 10) : x.variations, // 传入规格信息，包含适配模型名称等关键决策依据
  }));
}

function mergeSearchCandidates(groups: BoothRawItem[][], perGroupCap: number): BoothRawItem[] {
  // 多个关键词的候选按「轮转」交错合并：保证每个目标类目都有候选进入挑选视野，
  // 避免第一个关键词的结果占满候选上限、后面类目被挤掉。
  const lists = (groups || []).map((g) => (g || []).slice(0, perGroupCap));
  const seen = new Set<string>();
  const out: BoothRawItem[] = [];
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function decisionKeywords(d: Extract<AgentDecision, { action: "search" }>): string[] {
  const raw = d.keywords_ja && d.keywords_ja.length ? d.keywords_ja : [d.keyword_ja];
  return Array.from(new Set(raw.map((k) => (k || "").trim()).filter(Boolean))).slice(0, 10);
}

async function decideNextStepEndToEnd(params: {
  openai: OpenAI;
  model: string;
  messages: ClientMessage[];
  candidates?: BoothRawItem[];
  candidatesKeywordJa?: string;
  candidatesKeywords?: string[];
  candidatesTargets?: string[];
  candidatesPage?: number;
  picked?: { id: string; title: string; tags: string[]; description?: string }[];
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
    candidatesKeywords,
    candidatesTargets,
    candidatesPage,
    picked,
    triedKeywords,
    excludeIds,
    pickedIds,
    needMin,
    maxPick,
    signal,
    language = "zh",
  } = params;

  const { text: userInstruction, image: currentUserImage, hasImage } = extractUserInstruction(messages);
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
      "\n\n组合/多目标需求（适用于任何领域）：",
      "\n- 当用户一次需要多个互补的不同目标时（例如一套穿搭的多个部位、一个房间的多件家具、某个作品的多个部件、成套的道具或装饰等），不要只用一个关键词硬搜。要先把需求拆成 2–10 个独立目标（用户提到的每个部分都算一个目标），并为每个目标各写一个日文搜索关键词。超过 10 个时把相近目标合并，不要静默丢弃。",
      "\n- 拆解结果放进 keywords_ja（按顺序），并在 targets_zh 中用用户的语言按相同顺序写每个目标的名称；两者长度必须一致。",
      "\n- 每个关键词只聚焦一个目标，不同关键词之间不要重复；不要在一个关键词里堆叠多个目标。",
      "\n- 例：用户说「白毛猫耳水手服搭配」→ keywords_ja:[\"セーラー服 衣装\",\"ショートパンツ\",\"ボブ 髪型\",\"メイク テクスチャ\"]，targets_zh:[\"衣服\",\"裤子\",\"头发\",\"妆容\"]。这只是格式示例，目标由用户的实际需求决定，不要套用示例内容。",
      "\n- 只涉及单一目标的请求，用一个关键词即可（此时 targets_zh 可省略）。",
      "\n- 用户明确提到的每个部分都要覆盖；拿不准时宁可多拆一个相关目标，也不要漏掉用户提到的部分。",
      "\n\n重要规则：",
      "\n1) 输出必须是严格 JSON（不要 Markdown，不要解释）。",
      "\n2) keyword_ja / keywords_ja 必须是日文（可包含空格）；page 为正整数。",
      "\n3) 若用户在续聊（例如下一页/更多/换关键词），要结合 hint/上下文理解。",
      "\n4) select 时只能从 candidates 里选，且不要选 exclude_ids/picked_ids；最多选择 max_pick 个。",
      "\n4.1) 若 candidates_info 中存在 targets_zh（多目标），selected 要尽量覆盖每个目标：每个目标至少 1 件（前提是候选里有合适的）；请在 description_zh 开头标明它对应的目标，例如「上衣｜…」。",
      "\n4.2) picked_items 是已经选过的商品，避免重复挑选。",
      "\n4.3) done 的含义：单目标=已选够合适的商品；多目标=每个目标都至少选了 1 件，或确认该目标没有合适结果。未满足时 done 必须为 false。",
      "\n5) 若不确定，优先 search（不要错过用户检索意图）。",
      "\n\n输出格式三选一：",
      "\n- {\"action\":\"reply\",\"reply_zh\":\"...\"}",
      "\n- {\"action\":\"search\",\"keyword_ja\":\"...\",\"keywords_ja\":[\"...\",\"...\"],\"targets_zh\":[\"...\",\"...\"],\"need_summary_zh\":\"...\",\"page\":1}",
      "\n- {\"action\":\"select\",\"selected\":[{\"id\":\"...\",\"description_zh\":\"...\",\"tags\":[\"...\"],\"reason_zh\":\"...\"}],\"done\":true}",
    ].join(""),
  };

  const candidates_info = candidates
    ? {
        keyword_ja: candidatesKeywordJa,
        keywords_ja: candidatesKeywords && candidatesKeywords.length > 1 ? candidatesKeywords : undefined,
        targets_zh: candidatesTargets && candidatesTargets.length > 1 ? candidatesTargets : undefined,
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
      picked_items: (picked || []).slice(-15).map((p) => ({
        id: p.id,
        title: p.title,
        tags: p.tags,
        summary: (p.description || "").slice(0, 120),
      })),
      need_min: needMin,
      max_pick: maxPick,
      candidates_info,
    },
    null,
    0
  );

  // 关键修复：之前只传了 has_image=true，但没有把图片内容传给模型，模型当然“看不到图片”。
  // 这里在最后一条 user 消息包含 image 时，使用 OpenAI 兼容的多模态 content 格式传入。
  const user: any = currentUserImage
    ? {
        role: "user",
        content: [
          { type: "text", text: userPayloadText },
          { type: "image_url", image_url: { url: currentUserImage } },
        ],
      }
    : {
        role: "user",
        content: userPayloadText,
      };

  let res;
  let lastError;
  for (let attempt = 1; attempt <= 1; attempt++) {
    try {
      // 单次 90 秒超时，没结果就直接超时
      const timeoutMs = 90000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      // 合并传入的 signal
      if (signal) {
        const onAbort = () => controller.abort();
        signal.addEventListener('abort', onAbort);
      }

      console.log(`[Agent] decideNextStep timeout=${timeoutMs}ms...`);
      res = await openai.chat.completions.create(
        {
          model,
          messages: [system as any, user as any] as any,
          temperature: 0.2,
          reasoning_effort: "low",
        },
        { signal: controller.signal } as any
      ).finally(() => clearTimeout(timeoutId));
      
      // 成功
      console.log(`[Agent] Decision succeeded`);
      break;
    } catch (e: any) {
      lastError = e;
      const isTimeout = e?.name === 'AbortError' || e?.message?.includes('timeout');
      console.warn(`[Agent] attempt ${attempt} failed: ${e?.message || e} (timeout=${isTimeout})`);
      
      if (signal?.aborted) {
        throw e; // 用户主动中断，不重试
      }
      
      console.error("[Agent] decideNextStep timeout or error.");
      return { action: "reply", reply_zh: "抱歉喵，璃璃刚才非常努力地思考了，但大脑还是有点转不过来... 你可以告诉璃璃“再试一次”噢！"};
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

  // 多目标：keywords_ja + targets_zh（按顺序一一对应），最多 10 个。
  const rawKeywords: unknown[] = Array.isArray(parsed?.keywords_ja) ? parsed.keywords_ja : [];
  const keywords: string[] = rawKeywords
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => !!k);
  if (keyword_ja && !keywords.includes(keyword_ja)) keywords.unshift(keyword_ja);
  const uniqueKeywords: string[] = Array.from(new Set(keywords)).slice(0, 10);

  const rawTargets: unknown[] = Array.isArray(parsed?.targets_zh) ? parsed.targets_zh : [];
  const targets: string[] = rawTargets
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => !!x)
    .slice(0, uniqueKeywords.length);

  return {
    action: "search",
    keyword_ja: uniqueKeywords[0] || hint.keywordJa || userInstruction.slice(0, 24),
    keywords_ja: uniqueKeywords.length ? uniqueKeywords : undefined,
    targets_zh: targets.length > 1 ? targets : undefined,
    need_summary_zh: need_summary_zh || "用户希望找到匹配条件的 VRChat 资产。",
    page,
  };
}

function collectPreviouslyShownIds(messages: ClientMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const items = m?.items;
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

function parseBoothSearchPage(htmlContent: string): BoothRawItem[] {
  const $ = cheerio.load(htmlContent);
  const items: BoothRawItem[] = [];

  $("li.item-card").each((_, el) => {
    const $el = $(el);

    const title = $el.find(".item-card__title").text().trim() || "No Title";
    const shopName = $el.find(".item-card__shop-name").text().trim() || "Unknown Shop";
    const price = $el.find(".price").text().trim() || "Free";

    const linkEl = $el.find(".item-card__title-anchor");
    const urlPath = (linkEl.attr("href") || "").trim();
    const id = ($el.attr("data-product-id") || urlPath.split("/").filter(Boolean).pop() || "").trim();

    // 兜底：有些情况下列表卡片拿不到 href，但 data-product-id 仍存在
    const fallbackPath = id ? `/ja/items/${encodeURIComponent(id)}` : "";
    const resolvedPath = urlPath || fallbackPath;
    const fullUrl = resolvedPath.startsWith("http") ? resolvedPath : `https://booth.pm${resolvedPath}`;

    const imgEl = $el.find(".item-card__thumbnail-image");
    const imageUrl = imgEl.attr("data-original") || imgEl.attr("data-src") || imgEl.attr("src") || "";

    // 尽力抓简介/标签（不同页面结构可能不一致）
    const description =
      $el.find(".item-card__description").text().trim() ||
      $el.find(".u-text-ellipsis-2").text().trim() ||
      "";

    const tags: string[] = [];
    $el.find("a.tag, .item-card__tags a, .item-card__tags span").each((_, tagEl) => {
      const tag = $(tagEl).text().trim();
      if (tag) tags.push(tag);
    });

    if (!id || !fullUrl) return;
    items.push({
      id: String(id),
      title,
      shopName,
      price,
      url: fullUrl,
      imageUrl,
      description,
      tags: Array.from(new Set(tags)).slice(0, 12),
    });
  });

  return items;
}

async function fetchItemDetailsJson(id: string): Promise<{ tags?: string[], description?: string, shopUrl?: string, variations?: { name: string, price: number }[] } | null> {
  const jsonUrl = `https://booth.pm/ja/items/${id}.json`;
  try {
    const res = await fetch(jsonUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    if (res.ok) {
      const json = await res.json();
      return {
        tags: Array.isArray(json.tags) ? json.tags.map((t: any) => t.name) : undefined,
        description: json.description,
        shopUrl: json.shop?.url,
        variations: Array.isArray(json.variations) ? json.variations.map((v: any) => ({
          name: v.name,
          price: v.price
        })) : undefined
      };
    }
  } catch (e: any) {
    // ignore
  }
  return null;
}

async function executeSearchBoothPage(keywordJa: string, page: number = 1, maxItems?: number): Promise<BoothRawItem[]> {
  console.log(`[Scraper] Starting direct search for: "${keywordJa}" (Page ${page})`);
  let items: BoothRawItem[] = [];

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keywordJa)}?page=${page}`;
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    if (timeoutId) clearTimeout(timeoutId);
    if (res.ok) {
      const htmlContent = await res.text();
      if (htmlContent && htmlContent.length > 500) {
        items = parseBoothSearchPage(htmlContent);
        // 多目标并行检索时限制每个关键词的候选数，控制请求量与 token。
        if (maxItems && items.length > maxItems) items = items.slice(0, maxItems);
      }
    }
  } catch (e: any) {
    if (timeoutId) clearTimeout(timeoutId);
    console.error(`[Scraper] Search error: ${e?.message || e}`);
  }

  if (items.length > 0) {
    // 改进：全量增强。对搜索到的所有商品发起 JSON 请求以获取精准信息。
    // 使用分批处理（每批 15 个）以平衡速度与稳定性。
    console.log(`[Scraper] Enhancing all ${items.length} items with JSON data...`);
    
    const BATCH_SIZE = 15;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (item) => {
      const details = await fetchItemDetailsJson(item.id);
      if (details) {
        if (details.tags) item.tags = details.tags;
        if (details.description) item.description = details.description;
        if (details.variations) {
          item.variations = details.variations;
          // 重新计算更准确的价格范围
          const prices = details.variations.map(v => v.price).filter(p => typeof p === 'number');
          if (prices.length > 0) {
            const min = Math.min(...prices);
            const max = Math.max(...prices);
            item.price = min === max ? `${min} JPY` : `${min} ~ ${max} JPY`;
          }
        }
      }
    }));
    }
  }

  return items;
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
    const modelName = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

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

      const streamAssistantReply = async (params: {
        userInstruction: string;
        needSummaryZh: string;
        items: AssetResult[];
        keywordJa: string;
        keywordsJa?: string[];
        targetsZh?: string[];
        page: number;
        fetchedCount: number;
        hasNextPage: boolean;
      }) => {
        if (stopped) return;
        const { userInstruction, needSummaryZh, items, keywordJa, keywordsJa, targetsZh, page, fetchedCount, hasNextPage } = params;

        const itemsJson = JSON.stringify(items, null, 2);
        const langName = language?.startsWith("en") ? "English" : language?.startsWith("ja") ? "Japanese" : "Chinese";
        
        const system = {
          role: "system",
          content: [
            "你是一个叫璃璃的可爱助手，是用户的 VRChat Booth 资产查找助手。你的语气比较可爱，随时愿意为用户提供帮助！",
            `\n用户当前的语言偏好是：${langName}。请务必使用 ${langName} 进行回复。`,
            "\n你将收到用户指令、需求摘要、以及后端筛选出的真实商品数组 items（JSON）。",
            "\n你还会收到：本次抓取到的候选总数 fetched_count、以及是否可能有下一页 has_next_page。",
            "\n你的任务：给出推荐/说明。回复时请保持璃璃可爱的语气。",
            "\n- 你必须基于 has_next_page 判断是否还有下一页：",
            "\n  - has_next_page=true：说明还有下一页，可以问用户要翻页还是换关键词。",
            "\n  - has_next_page=false：说明没有下一页，只能建议换关键词或调整条件。",
            "\n- items 只是你最终挑选给用户展示的结果，数量可能远小于 fetched_count。不要用 items 的数量去推断是否还有下一页。",
            "\n- 如果本轮 targets_zh 有多个目标，说明用户要的是一组需要互相配合的素材：请按目标分组介绍，说明每件在组合中的作用以及它与其它目标的关系；某个目标没有合适结果时，坦诚说明并给出可替代的搜索建议，不要假装已覆盖。",
            "\n重要规则：",
            "\n1) 禁止编造商品，只能基于 items。",
            "\n2) 必须使用 Markdown。",
            "\n2.1) 严禁在回复中出现字符串：__STATUS__: （这是前端的流式状态标记，会干扰解析）。",
            "\n3) 在 JSON 代码块之前，输出一行：当前关键词：<keyword>；当前页码：<page>。",
            "\n   - 如果本轮有多个关键词（keywords_ja），用「、」把它们连接后输出。",
            "\n   - 如果 has_next_page=false，也要输出当前页码（方便前端做续聊提示）；但你需要在正文里明确说明「没有下一页」。不要输出任何参数名字例如fetched_count或者has_next_page等。",
            "\n4) 回复的最后必须包含一个 JSON 代码块，并且该 JSON 必须【原样】等于提供的 items_json（不要增删字段、不要改值、不要改变数组顺序）。",
            "\n5) 除了这个 JSON 代码块以外，不要输出其它代码块。",
          ].join(""),
        };
        const userText = [
          `用户指令：${userInstruction}`,
          `\n需求摘要：${needSummaryZh}`,
          `\nkeywords_ja：${keywordsJa && keywordsJa.length ? keywordsJa.join("、") : keywordJa}`,
          `\ntargets_zh：${targetsZh && targetsZh.length ? targetsZh.join("、") : "（单一目标）"}`,
          `\npage：${page}`,
          `\nfetched_count：${fetchedCount}`,
          `\nhas_next_page：${hasNextPage ? "true" : "false"}`,
          "\nitems_json（必须原样输出到你回复末尾的 json 代码块）：\n" + itemsJson,
        ].join("");

        // 若本轮用户有上传图片，把图片也传给最终回复模型。
        // 只取当前轮（最后一条 user 消息）的图片，避免把历史参考图重复注入。
        const currentUserImage = extractUserInstruction(clientMessages).image;

        const user: any = currentUserImage
          ? {
              role: "user",
              content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: currentUserImage } },
              ],
            }
          : { role: "user", content: userText };

        const response = await openai.chat.completions.create(
          {
            model: modelName,
            messages: [system as any, user as any] as any,
            temperature: 0.2,
            reasoning_effort: "low",
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

        // 一次可能覆盖多个目标（例如一套搭配的多个部位）：当前批次的关键词与目标按顺序对应。
        let currentKeywords: string[] =
          first.action === "search" ? decisionKeywords(first) : [userInstruction.slice(0, 24)];
        if (!currentKeywords.length) currentKeywords = [userInstruction.slice(0, 24)];
        let currentTargets: string[] = first.action === "search" ? (first.targets_zh || []).slice(0, currentKeywords.length) : [];
        let currentPage = first.action === "search" ? first.page : 1;
        let needSummaryZh = first.action === "search" ? first.need_summary_zh : "用户希望找到匹配条件的 VRChat 资产。";
        // 本轮出现过多目标后，收尾条件始终按多目标处理，避免后续单关键词轮次把 done 语义降级。
        let sawMultiTarget = currentTargets.length > 1;
        const overallTargets: string[] = [...currentTargets];
        const rememberTargets = (targets: string[]) => {
          if (targets.length > 1) sawMultiTarget = true;
          for (const tg of targets) if (!overallTargets.includes(tg)) overallTargets.push(tg);
        };
        rememberTargets(currentTargets);
        for (const k of currentKeywords) if (k && !triedKeywords.includes(k)) triedKeywords.push(k);

        // Step 2..N: agent loop（search -> fetch -> select -> (optional) 再 search）
        for (let step = 0; step < maxSteps; step++) {
          if (stopped) return;
          const batchKeywords = currentKeywords.slice(0, 10);
          if (!batchKeywords.length) break;
          const batchTargets = currentTargets.slice(0, batchKeywords.length);
          const multiBatch = batchKeywords.length > 1;
          // 目标多时压缩每个关键词的候选数与并发波次，控制请求量和时延。
          const perKeywordCap = multiBatch ? (batchKeywords.length > 4 ? 15 : 30) : undefined;

          await writeStatus(
            multiBatch
              ? `正在同时检索 ${batchKeywords.length} 个目标（第 ${currentPage} 页）：${batchKeywords.slice(0, 3).map((k) => `「${k}」`).join("、")}${batchKeywords.length > 3 ? " 等" : ""}...`
              : `正在抓取 Booth：关键词「${batchKeywords[0]}」第 ${currentPage} 页...`
          );

          // 多目标：按 5 个一组并行检索、组间串行，避免一次向 Booth 发起过多请求。
          const searchResults: BoothRawItem[][] = [];
          for (let i = 0; i < batchKeywords.length; i += 5) {
            const chunk = batchKeywords.slice(i, i + 5);
            const part = await Promise.all(
              chunk.map((kw) => executeSearchBoothPage(kw, currentPage, perKeywordCap))
            );
            searchResults.push(...part);
            if (stopped) return;
          }
          const pageItems = multiBatch
            ? mergeSearchCandidates(searchResults, 30)
            : searchResults[0] || [];
          lastFetchedCount = searchResults.reduce((n, items) => n + (items?.length || 0), 0);
          lastHasNextPage = !multiBatch && (searchResults[0]?.length || 0) >= 60;
          if (stopped) return;
          await writeStatus(`抓取到 ${lastFetchedCount} 条，璃璃正在选择/决定下一步...`);

          const pickedBrief = picked.map((p) => ({
            id: p.id,
            title: p.title,
            tags: p.tags,
            description: p.description,
          }));

          let decision: AgentDecision;
          try {
            console.log(`[Loop] Step ${step} starting decision...`);
            decision = await decideNextStepEndToEnd({
              openai,
              model: modelName,
              messages: clientMessages,
              candidates: pageItems,
              candidatesKeywordJa: batchKeywords.join(" / "),
              candidatesKeywords: batchKeywords,
              candidatesTargets: multiBatch ? batchTargets : undefined,
              candidatesPage: currentPage,
              triedKeywords,
              excludeIds: exclude,
              pickedIds,
              picked: pickedBrief,
              needMin: minNeed,
              maxPick,
              signal: requestSignal,
              language,
            });
            console.log(`[Loop] Step ${step} decision action: ${decision.action}`);
          } catch (e: any) {
            console.error(`[Agent] Loop Step ${step} Decision Error:`, e?.message || e);
            break;
          }

          if (stopped) return;

          if (decision.action === "reply") {
            await write(decision.reply_zh);
            await writer.close();
            return;
          }

          if (decision.action === "search") {
            currentKeywords = decisionKeywords(decision);
            if (!currentKeywords.length) currentKeywords = [batchKeywords[0]];
            currentTargets = (decision.targets_zh || []).slice(0, currentKeywords.length);
            rememberTargets(currentTargets);
            currentPage = decision.page || 1;
            needSummaryZh = decision.need_summary_zh || needSummaryZh;
            for (const k of currentKeywords) if (k && !triedKeywords.includes(k)) triedKeywords.push(k);
            continue;
          }

          if (decision.action === "select") {
            // 把 agent 选择映射成最终 items
            let selectCountInThisStep = 0;
            for (const s of decision.selected) {
              const raw = pageItems.find((x) => x.id === s.id);
              if (!raw) continue;
              if (exclude.has(raw.id) || pickedIds.has(raw.id)) continue;

              pickedIds.add(raw.id);
              selectCountInThisStep++;
              picked.push({
                id: raw.id,
                title: raw.title,
                shopName: raw.shopName,
                price: raw.price,
                url: raw.url,
                imageUrl: raw.imageUrl,
                description: s.description_zh || raw.description || "",
                tags: (s.tags && s.tags.length ? s.tags : raw.tags) || [],
              });
            }

            // 收尾策略：
            // - 单目标：选够 minNeed 或模型判定 done 即可进入生成阶段。
            // - 多目标：必须由模型确认 done（每个目标都已覆盖或确认无合适结果），
            //   否则继续检索，避免只覆盖了第一个目标就收尾。
            const doneEnough = sawMultiTarget ? !!decision.done : (picked.length >= minNeed || !!decision.done);
            if (doneEnough || (selectCountInThisStep === 0 && picked.length > 0)) break;

            // 结果还不够，且还有重试空间：让 agent 再决定下一次 search（翻页/换关键词/补齐目标）
            // 增加判断：如果已经到了最后一步循环，没必要再请求一次决策，直接 break 让后面生成回复。
            if (step >= maxSteps - 1) break;

            await writeStatus("结果不足，璃璃正在决定下一步检索策略...");
            let next: AgentDecision;
            try {
              console.log(`[Loop] Step ${step} need more, deciding next search...`);
              next = await decideNextStepEndToEnd({
                openai,
                model: modelName,
                messages: clientMessages,
                triedKeywords,
                excludeIds: exclude,
                pickedIds,
                picked: picked.map((p) => ({
                  id: p.id,
                  title: p.title,
                  tags: p.tags,
                  description: p.description,
                })),
                needMin: minNeed,
                maxPick,
                signal: requestSignal,
                language,
              });
              console.log(`[Loop] Step ${step} next search decision: ${next.action}`);
            } catch (e: any) {
              console.error(`[Agent] Loop Step ${step} Next Decision Error:`, e?.message || e);
              break;
            }

            if (stopped) return;

            if (next.action === "reply") {
              // 已经有选中的商品时，不要让一个“补充说明式”的 reply 吞掉结果：
              // 交给最终回复阶段，连同 items 一起输出。
              if (picked.length > 0) break;
              await write(next.reply_zh);
              await writer.close();
              return;
            }
            if (next.action === "search") {
              currentKeywords = decisionKeywords(next);
              if (!currentKeywords.length) currentKeywords = [batchKeywords[0]];
              currentTargets = (next.targets_zh || []).slice(0, currentKeywords.length);
              rememberTargets(currentTargets);
              currentPage = next.page || 1;
              needSummaryZh = next.need_summary_zh || needSummaryZh;
              for (const k of currentKeywords) if (k && !triedKeywords.includes(k)) triedKeywords.push(k);
              continue;
            }
            // 如果 next.action 又是 select，可能会导致无限循环，这里强制下一次循环
            continue;
          }
        }

        // 所有可见回复由 agent 生成（流式输出），不再手工拼接文案。
        await writeStatus("璃璃正在生成最终回复...");
        await streamAssistantReply({
          userInstruction,
          needSummaryZh,
          items: picked,
          keywordJa: currentKeywords.join(" / "),
          keywordsJa: currentKeywords,
          targetsZh: overallTargets.slice(0, 10),
          page: currentPage,
          fetchedCount: lastFetchedCount,
          hasNextPage: lastHasNextPage,
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




