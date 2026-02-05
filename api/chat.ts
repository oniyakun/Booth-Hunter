import OpenAI from "openai";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

export const config = {
  runtime: "edge",
};

const PROXIES = [
  { name: "Direct", url: (u: string) => u, type: 'html' },
  { name: "CodeTabs", url: (u: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, type: 'html' },
  { name: "CorsProxy", url: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`, type: 'html' }
];

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
  } = params;

  const { text: userInstruction, hasImage } = extractUserInstruction(messages);
  const lastUserImage = extractLastUserImage(messages);
  const hint = extractLastKeywordAndPageHint(messages);
  const conversation = buildRecentConversationForAgent(messages, 18);

  const system = {
    role: "system",
    content: [
      "你是一个叫璃璃的可爱助手，是用户的 VRChat Booth 资产导购专属助手。你的语气比较可爱，经常带上喵、呀、喔等语气词，随时愿意为用户提供帮助！",
      "\n你需要根据【完整对话上下文】决定下一步动作：",
      "\n- action=reply：直接用中文回复（闲聊/感谢/问怎么用/非找商品）。回复时请保持璃璃可爱的语气。",
      "\n- action=search：生成用于 Booth 搜索的日文关键词与页码，并给出中文需求摘要。",
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
      candidates_info: candidates
        ? {
            keyword_ja: candidatesKeywordJa,
            page: candidatesPage,
            candidates: compactCandidatesForAgent(candidates),
          }
        : null,
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

  const res = await openai.chat.completions.create(
    {
      model,
      messages: [system as any, user as any] as any,
      temperature: 0.2,
    },
    // OpenAI SDK: AbortSignal 应该放在 RequestOptions（第二个参数）里
    signal ? ({ signal } as any) : undefined
  );

  const raw = (res.choices?.[0] as any)?.message?.content || "";
  const parsed = safeJsonParse<any>(raw) || {};

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

async function executeSearchBoothPage(keywordJa: string, page: number = 1): Promise<BoothRawItem[]> {
  console.log(`[Scraper] Starting search for: "${keywordJa}" (Page ${page})`);
  for (const proxy of PROXIES) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      console.log(`[Scraper] Attempting via ${proxy.name}...`);
      const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keywordJa)}?page=${page}`;
      const fetchUrl = proxy.url(targetUrl);

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });

      if (timeoutId) clearTimeout(timeoutId);
      if (!res.ok) continue;

      const htmlContent = await res.text();
      if (!htmlContent || htmlContent.length < 500) continue;

      const items = parseBoothSearchPage(htmlContent);
      if (items.length > 0) {
        console.log(`[Scraper] Success! Found ${items.length} items via ${proxy.name}`);
        return items;
      }
    } catch (e: any) {
      if (timeoutId) clearTimeout(timeoutId);
      console.log(`[Scraper] ${proxy.name} error: ${e?.message || e}`);
    }
  }
  return [];
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
    
    const { messages, chat_id } = body as { messages?: any[]; chat_id?: string };
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

    if (!token) {
      return withJsonHeaders(401, { error: 'Missing bearer token' });
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
        global: { headers: { Authorization: `Bearer ${token}` } },
      });

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
    } catch (e: any) {
      console.error('[Turns] consume_turn failed:', e?.message || e);
      return withJsonHeaders(500, { error: e?.message || 'consume_turn failed' });
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
        page: number;
        fetchedCount: number;
        hasNextPage: boolean;
      }) => {
        if (stopped) return;
        const { userInstruction, needSummaryZh, items, keywordJa, page, fetchedCount, hasNextPage } = params;

        const itemsJson = JSON.stringify(items, null, 2);
        const system = {
          role: "system",
          content: [
            "你是一个叫璃璃的可爱助手，是用户的 VRChat Booth 资产导购专属助手。你的语气比较可爱，经常带上喵、呀、喔等语气词，随时愿意为用户提供帮助！",
            "\n你将收到用户指令、需求摘要、以及后端筛选出的真实商品数组 items（JSON）。",
            "\n你还会收到：本次抓取到的候选总数 fetched_count、以及是否可能有下一页 has_next_page。",
            "\n你的任务：用中文给出推荐/说明。回复时请保持璃璃可爱的语气。",
            "\n- 你必须基于 has_next_page 判断是否还有下一页：",
            "\n  - has_next_page=true：说明还有下一页，可以问用户要翻页还是换关键词。",
            "\n  - has_next_page=false：说明没有下一页，只能建议换关键词或调整条件。",
            "\n- items 只是你最终挑选给用户展示的结果，数量可能远小于 fetched_count。不要用 items 的数量去推断是否还有下一页。",
            "\n重要规则：",
            "\n1) 禁止编造商品，只能基于 items。",
            "\n2) 必须使用 Markdown。",
            "\n2.1) 严禁在回复中出现字符串：__STATUS__: （这是前端的流式状态标记，会干扰解析）。",
            "\n3) 在 JSON 代码块之前，输出一行：当前关键词：<keyword>；当前页码：<page>。",
            "\n   - 如果 has_next_page=false，也要输出当前页码（方便前端做续聊提示）；但你需要在正文里明确说明“没有下一页”。不要输出任何参数名字例如fetched_count或者has_next_page等。",
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
          // OpenAI SDK: AbortSignal 应该放在 RequestOptions（第二个参数）里
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

        // Step 2..N: agent loop（search -> fetch -> select -> (optional) 再 search）
        for (let step = 0; step < maxSteps; step++) {
          if (stopped) return;
          await writeStatus(`正在抓取 Booth：关键词「${currentKeywordJa}」第 ${currentPage} 页...`);
          const pageItems = await executeSearchBoothPage(currentKeywordJa, currentPage);
          lastFetchedCount = pageItems.length;
          lastHasNextPage = pageItems.length >= 60;
          if (stopped) return;
          await writeStatus(`抓取到 ${pageItems.length} 条，璃璃正在选择/决定下一步...`);

          const decision = await decideNextStepEndToEnd({
            openai,
            model: modelName,
            messages: clientMessages,
            candidates: pageItems,
            candidatesKeywordJa: currentKeywordJa,
            candidatesPage: currentPage,
            triedKeywords,
            excludeIds: exclude,
            pickedIds,
            needMin: minNeed,
            maxPick,
            signal: requestSignal,
          });

          if (stopped) return;

          if (decision.action === "reply") {
            await write(decision.reply_zh);
            await writer.close();
            return;
          }

          if (decision.action === "search") {
            currentKeywordJa = decision.keyword_ja || currentKeywordJa;
            currentPage = decision.page || 1;
            needSummaryZh = decision.need_summary_zh || needSummaryZh;
            if (currentKeywordJa && !triedKeywords.includes(currentKeywordJa)) triedKeywords.push(currentKeywordJa);
            continue;
          }

          if (decision.action === "select") {
            // 把 agent 选择映射成最终 items
            for (const s of decision.selected) {
              const raw = pageItems.find((x) => x.id === s.id);
              if (!raw) continue;
              if (exclude.has(raw.id) || pickedIds.has(raw.id)) continue;

              pickedIds.add(raw.id);
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

            if (picked.length >= minNeed || decision.done) break;

            // 结果还不够：让 agent 再决定下一次 search（翻页/换关键词）
            await writeStatus("结果不足，璃璃正在决定下一步检索策略...");
            const next = await decideNextStepEndToEnd({
              openai,
              model: modelName,
              messages: clientMessages,
              triedKeywords,
              excludeIds: exclude,
              pickedIds,
              needMin: minNeed,
              maxPick,
              signal: requestSignal,
            });

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
          }
        }

        // 所有可见回复由 agent 生成（流式输出），不再手工拼接文案。
        await writeStatus("璃璃正在生成最终回复...");
        await streamAssistantReply({
          userInstruction,
          needSummaryZh,
          items: picked,
          keywordJa: currentKeywordJa,
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
