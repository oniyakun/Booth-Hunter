import OpenAI from "openai";
import * as cheerio from "cheerio";

export const config = {
  runtime: 'edge', 
};

const TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "search_booth",
      description: "Search for VRChat assets on Booth.pm (a marketplace). Use this tool to find real items, prices, and images. Always translate keywords to Japanese before searching.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "The search keyword in Japanese (e.g., '髪' instead of 'Hair', '衣装' instead of 'Outfit').",
          },
        },
        required: ["keyword"],
      },
    }
  }
];

const PROXIES = [
  { name: "Direct", url: (u: string) => u, type: 'html' },
  { name: "CodeTabs", url: (u: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, type: 'html' },
  { name: "CorsProxy", url: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`, type: 'html' }
];

async function executeSearchBooth(keyword: string) {
  console.log(`[Scraper] Starting search for: "${keyword}"`);
  for (const proxy of PROXIES) {
    let timeoutId: any;
    try {
      console.log(`[Scraper] Attempting via ${proxy.name}...`);
      const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keyword)}`;
      const fetchUrl = proxy.url(targetUrl);
      
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
        }
      });
      
      if (timeoutId) clearTimeout(timeoutId);
      if (!res.ok) continue;
      
      let htmlContent = "";
      if (proxy.type === 'json') {
          const data = await res.json();
          htmlContent = data.contents;
      } else {
          htmlContent = await res.text();
      }

      if (!htmlContent || htmlContent.length < 500) continue;

      const $ = cheerio.load(htmlContent);
      const items: any[] = [];
      $("li.item-card").each((_, el) => {
          const $el = $(el);
          const title = $el.find(".item-card__title").text().trim() || "No Title";
          const shopName = $el.find(".item-card__shop-name").text().trim() || "Unknown Shop";
          const price = $el.find(".price").text().trim() || "Free";
          const linkEl = $el.find(".item-card__title-anchor");
          const urlPath = linkEl.attr("href") || "";
          const fullUrl = urlPath.startsWith("http") ? urlPath : `https://booth.pm${urlPath}`;
          const id = $el.attr("data-product-id") || urlPath.split("/").pop() || "";
          const imgEl = $el.find(".item-card__thumbnail-image");
          const imageUrl = imgEl.attr("data-original") || imgEl.attr("data-src") || imgEl.attr("src") || "";
          items.push({ id, title, shopName, price, url: fullUrl, imageUrl, description: "", tags: [] });
      });

      if (items.length > 0) {
          console.log(`[Scraper] Success! Found ${items.length} items via ${proxy.name}`);
          return items.slice(0, 10);
      }
    } catch (e: any) {
      if (timeoutId) clearTimeout(timeoutId);
      console.log(`[Scraper] ${proxy.name} error: ${e.message}`);
    }
  }
  return [];
}

export default async function handler(req: any) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    let body;
    if (typeof req.json === 'function') body = await req.json();
    else body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    const { messages } = body;
    const apiKey = process.env.GEMINI_API_KEY;
    const baseURL = process.env.GEMINI_API_BASE_URL;
    const modelName = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

    if (!apiKey) return new Response('Configuration Error: GEMINI_API_KEY missing', { status: 500 });

    const openai = new OpenAI({ apiKey, baseURL });

    // Transform messages to OpenAI format
    const openAIMessages: any[] = [
        {
            role: "system",
            content: `
        你是一个 VRChat Booth 资产导购助手。
        
        **工具使用规则**:
        1. 当用户寻找素材时，**必须**调用 \`search_booth\` 工具。不要凭空编造商品。
        2. 调用工具前，先将用户的中文关键词翻译成日文。
        3. 工具会返回真实的搜索结果（JSON格式）。

        **回复生成规则**:
        1. 收到工具返回的结果后，请从中挑选 4-8 个最符合用户需求的商品。
        2. 用 Markdown 列表向用户简要介绍这些商品（标题、价格、推荐理由）。
        3. **关键**: 在回复的最后，必须包含一个 JSON 代码块，用于前端渲染卡片。
        
        **JSON 输出格式**:
        \`\`\`json
        [
          {
            "id": "商品ID",
            "title": "完整标题",
            "shopName": "店铺名",
            "price": "价格",
            "url": "https://booth.pm/...",
            "imageUrl": "工具结果中的图片URL", 
            "description": "简短中文介绍",
            "tags": ["Tag1"]
          }
        ]
        \`\`\`
            `
        },
        ...messages.map((m: any) => ({
            role: m.role === 'model' ? 'assistant' : 'user',
            content: m.text
            // Image handling for OpenAI if needed: content: [{ type: 'text', text: m.text }, { type: 'image_url', image_url: ... }]
        }))
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          console.log(`[OpenAI] Starting Turn 1 using model: ${modelName}...`);
          const result = await openai.chat.completions.create({
            model: modelName,
            messages: openAIMessages,
            tools: TOOLS,
            stream: true,
          });

          let fullContent = "";
          let toolCalls: any[] = [];

          for await (const chunk of result) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              controller.enqueue(encoder.encode(delta.content));
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                    toolCalls[tc.index] = { ...tc, function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } };
                } else {
                    toolCalls[tc.index].function.arguments += tc.function?.arguments || "";
                }
              }
            }
          }

          if (toolCalls.length > 0) {
            console.log(`[OpenAI] Processing ${toolCalls.length} tool calls...`);
            controller.enqueue(encoder.encode("\n\n*(正在抓取商品信息...)*\n\n"));
            
            const toolResults = [];
            for (const tc of toolCalls) {
              let args = { keyword: "" };
              try {
                  args = JSON.parse(tc.function.arguments);
              } catch (e) {
                  console.error("[OpenAI] Failed to parse arguments:", tc.function.arguments);
              }
              
              const items = await executeSearchBooth(args.keyword);
              toolResults.push({
                tool_call_id: tc.id,
                role: "tool",
                name: tc.function.name,
                content: JSON.stringify(items),
              });
            }

            console.log("[OpenAI] Sending tool results back...");
            const secondResponse = await openai.chat.completions.create({
              model: modelName,
              messages: [
                ...openAIMessages,
                { role: "assistant", content: fullContent || null, tool_calls: toolCalls },
                ...toolResults,
              ],
              stream: true,
            });

            let secondTurnHasContent = false;
            for await (const chunk of secondResponse) {
              const content = chunk.choices[0]?.delta?.content;
              if (content) {
                secondTurnHasContent = true;
                controller.enqueue(encoder.encode(content));
              }
            }

            if (!secondTurnHasContent) {
                console.log("[OpenAI] Empty tool response, forcing summary...");
                controller.enqueue(encoder.encode("\n\n*(正在整理推荐列表...)*\n\n"));
                const forceResponse = await openai.chat.completions.create({
                  model: modelName,
                  messages: [
                    ...openAIMessages,
                    { role: "assistant", content: fullContent || null, tool_calls: toolCalls },
                    ...toolResults,
                    { role: "user", content: "搜索已完成，请直接列出推荐商品并附带 JSON 块。" }
                  ],
                  stream: true,
                });
                for await (const chunk of forceResponse) {
                  const content = chunk.choices[0]?.delta?.content;
                  if (content) controller.enqueue(encoder.encode(content));
                }
            }
          }

          console.log("[API] Finished.");
          controller.close();
        } catch (e: any) {
          console.error("[OpenAI] Error:", e.message);
          controller.enqueue(encoder.encode(`\n\nError: ${e.message}`));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }
    });

  } catch (e: any) {
    console.error("[API] Handler Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
