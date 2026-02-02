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
      description: "Search for VRChat assets on Booth.pm (a marketplace). Always translate keywords to Japanese before searching. If user wants more or different results, change keywords or increment the page number.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "The search keyword in Japanese.",
          },
          page: {
            type: "integer",
            description: "The page number (starts from 1). Use this to get different results for the same keyword.",
            default: 1
          }
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

async function executeSearchBooth(keyword: string, page: number = 1) {
  console.log(`[Scraper] Starting search for: "${keyword}" (Page ${page})`);
  for (const proxy of PROXIES) {
    let timeoutId: any;
    try {
      console.log(`[Scraper] Attempting via ${proxy.name}...`);
      const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keyword)}?page=${page}`;
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

    // Transform messages to OpenAI format (supporting image_url)
    const openAIMessages: any[] = [
        {
            role: "system",
            content: `
        你是一个 VRChat Booth 资产导购助手。
        
        **工具使用规则**:
        1. 当用户寻找素材时，**必须**调用 \`search_booth\` 工具，不要凭空编造商品！
        2. 调用工具前，先将用户的中文关键词翻译成日文。
        3. 工具会返回真实的搜索结果（JSON格式）。
        4. **结果多样性**: 当用户要求“再找找”、“换一批”或对当前结果不满意时，你必须采取行动：通过增加 \`page\` 参数来获取后续页面的商品。要记住之前对话里面已经展示过的商品，不要对用户重复展示相同的商品！
        5. **多轮搜索逻辑**: 如果第一次搜索的结果中没有符合用户要求的物品，或者结果太少，或者有重复结果，请尝试优化关键词再次调用工具，直到你找到足够多（建议 4-8 个）符合条件的商品。

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
        ...messages.map((m: any) => {
            const role = m.role === 'model' ? 'assistant' : 'user';
            
            if (m.image) {
                return {
                    role,
                    content: [
                        { type: "text", text: m.text || "请分析这张图片并根据其风格在 Booth 上寻找相似的 VRChat 资产。" },
                        {
                            type: "image_url",
                            image_url: {
                                url: m.image // Base64 data URI
                            }
                        }
                    ]
                };
            }
            
            return {
                role,
                content: m.text
            };
        })
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let currentMessages = [...openAIMessages];
        let turn = 0;
        const maxTurns = 8; 
        let lastTurnProducedText = false;

        try {
          while (turn < maxTurns) {
            turn++;
            console.log(`[OpenAI] Starting Loop Turn ${turn} using model: ${modelName}...`);
            const response = await openai.chat.completions.create({
              model: modelName,
              messages: currentMessages,
              tools: TOOLS,
              stream: true,
            });

            let currentTurnText = "";
            let toolCalls: any[] = [];

            for await (const chunk of response) {
              const delta = chunk.choices[0]?.delta;
              if (delta?.content) {
                currentTurnText += delta.content;
                controller.enqueue(encoder.encode(delta.content));
              }

              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.id) {
                      toolCalls[tc.index] = { 
                          id: tc.id, 
                          type: "function",
                          function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } 
                      };
                  } else {
                      if (toolCalls[tc.index]) {
                          toolCalls[tc.index].function.arguments += tc.function?.arguments || "";
                      }
                  }
                }
              }
            }

            lastTurnProducedText = currentTurnText.trim().length > 0;

            if (toolCalls.length > 0) {
              console.log(`[OpenAI] Turn ${turn} requested ${toolCalls.length} tools`);
              controller.enqueue(encoder.encode(`__STATUS__:正在搜寻相关资产 (第${turn}轮尝试)...`));
              
              const toolResults = [];
              for (const tc of toolCalls) {
                let args = { keyword: "", page: 1 };
                try {
                    args = JSON.parse(tc.function.arguments);
                } catch (e) {
                    console.error("[OpenAI] Arg parse fail:", tc.function.arguments);
                }
                
                const items = await executeSearchBooth(args.keyword, args.page || 1);
                const simplifiedItems = items.slice(0, 5).map(item => ({
                    title: item.title,
                    price: item.price,
                    shop: item.shopName,
                    url: item.url,
                    imageUrl: item.imageUrl
                }));

                toolResults.push({
                  tool_call_id: tc.id,
                  role: "tool",
                  name: tc.function.name,
                  content: JSON.stringify(simplifiedItems),
                });
              }

              currentMessages.push({ role: "assistant", content: currentTurnText || null, tool_calls: toolCalls });
              currentMessages.push(...toolResults);
              
              if (turn >= maxTurns) {
                  console.log("[OpenAI] Max turns reached after tool call.");
                  break;
              }
              continue; 
            } else {
              break; 
            }
          }

          // FINAL SUMMARY HANDLER: Only run if AI ended with tool results but without generating text summary
          const hasUsedTools = currentMessages.some(m => m.role === 'tool');
          if (hasUsedTools && !lastTurnProducedText) {
              console.log("[OpenAI] Final Phase: Generating summary as AI remained silent...");
              controller.enqueue(encoder.encode("__STATUS__:正在为您整理最佳推荐..."));
              
              const forceResponse = await openai.chat.completions.create({
                model: modelName,
                messages: [
                  ...currentMessages,
                  { role: "user", content: "请根据以上所有搜索结果，挑选最符合要求的商品。要记住之前对话里面已经展示过的商品，不要对用户重复展示相同的商品！" }
                ],
                stream: true,
              });

              let finalReplyText = "";
              for await (const chunk of forceResponse) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                  finalReplyText += content;
                  controller.enqueue(encoder.encode(content));
                }
              }
              
              if (!finalReplyText.trim()) {
                  console.log("[OpenAI] Manual fallback triggered.");
                  controller.enqueue(encoder.encode("抱歉，我找到了搜索结果但目前无法生成文字。请查看以下卡片：\n\n"));
                  const allItems = currentMessages
                    .filter(m => m.role === 'tool')
                    .map(m => JSON.parse(m.content))
                    .flat()
                    .slice(0, 8);
                  const manualJson = `\n\n\`\`\`json\n${JSON.stringify(allItems)}\n\`\`\``;
                  controller.enqueue(encoder.encode(manualJson));
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
