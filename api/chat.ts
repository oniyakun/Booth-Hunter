import { GoogleGenAI, Type } from "@google/genai";
import * as cheerio from "cheerio";

export const config = {
  runtime: 'edge', // Using Edge for better streaming support and timeout
};

const SEARCH_TOOL = {
  name: "search_booth",
  description: "Search for VRChat assets on Booth.pm (a marketplace). Use this tool to find real items, prices, and images. Always translate keywords to Japanese before searching.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      keyword: {
        type: Type.STRING,
        description: "The search keyword in Japanese (e.g., '髪' instead of 'Hair', '衣装' instead of 'Outfit').",
      },
    },
    required: ["keyword"],
  },
};

// Proxy definitions for rotation (Server-side compatible)
const PROXIES = [
  { name: "CodeTabs", url: (u: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`, type: 'html' },
  { name: "CorsProxy", url: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`, type: 'html' },
  // Direct fallback
  { name: "Direct", url: (u: string) => u, type: 'html' }
];

async function executeSearchBooth(keyword: string) {
  for (const proxy of PROXIES) {
    try {
      console.log(`Scraping ${keyword} via ${proxy.name}`);
      const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keyword)}`;
      const fetchUrl = proxy.url(targetUrl);
      
      const res = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      
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

          items.push({
            id,
            title,
            shopName,
            price,
            url: fullUrl,
            imageUrl,
            description: "",
            tags: []
          });
      });

      if (items.length > 0) return items.slice(0, 10);
    } catch (e) {
      console.error(`Proxy ${proxy.name} failed:`, e);
    }
  }
  return [];
}

export default async function handler(req: Request) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { messages } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) return new Response('Configuration Error: GEMINI_API_KEY missing', { status: 500 });

    const ai = new GoogleGenAI({ apiKey });
    
    // Convert frontend messages to Gemini history
    // Frontend sends: { role: 'user'|'model', text: string, ... }
    // Gemini expects: { role: 'user'|'model', parts: [{ text: string }] }
    
    // We take all messages except the last one as history
    const history = messages.slice(0, -1).map((m: any) => ({
        role: m.role,
        parts: [{ text: m.text }]
    }));

    const lastMsg = messages[messages.length - 1];
    
    const systemPrompt = `
        你是一个 VRChat Booth 资产导购助手。
        **工具使用规则**:
        1. 当用户寻找素材时，**必须**调用 \`search_booth\` 工具。
        2. 调用工具前，先将用户的中文关键词翻译成日文。
        3. 工具会返回真实的搜索结果（JSON格式）。
        **回复生成规则**:
        1. 收到工具返回的结果后，请从中挑选 4-8 个最符合用户需求的商品。
        2. 用 Markdown 列表向用户简要介绍这些商品。
        3. **关键**: 在回复的最后，必须包含一个 JSON 代码块，用于前端渲染卡片。
        **JSON 输出格式**:
        \`\`\`json
        [
          { "id": "商品ID", "title": "完整标题", "shopName": "店铺名", "price": "价格", "url": "...", "imageUrl": "...", "description": "...", "tags": ["Tag1"] }
        ]
        \`\`\`
    `;

    const chat = ai.chats.create({
      model: "gemini-2.0-flash", // Using flash for speed in serverless
      config: { 
          systemInstruction: systemPrompt, 
          tools: [{ functionDeclarations: [SEARCH_TOOL] }] 
      },
      history: history
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // First turn
          let result = await chat.sendMessageStream(lastMsg.text);
          let functionCalls: any[] = [];
          
          for await (const chunk of result) {
             const text = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("");
             if (text) {
                 controller.enqueue(encoder.encode(text));
             }
             
             // Collect function calls
             const calls = chunk.functionCalls;
             if (calls && calls.length > 0) {
                 functionCalls.push(...calls);
             }
          }

          // Handle function calls if any
          if (functionCalls.length > 0) {
              const toolResponses = [];
              // controller.enqueue(encoder.encode("\n\n*正在搜索 Booth...*\n\n")); 

              for (const call of functionCalls) {
                  if (call.name === 'search_booth') {
                      const keyword = (call.args as any).keyword;
                      const items = await executeSearchBooth(keyword);
                      toolResponses.push({
                          functionResponse: {
                              name: call.name,
                              id: call.id,
                              response: { result: items }
                          }
                      });
                  }
              }

              // Send tool results back
              const toolResultStream = await chat.sendMessageStream(toolResponses as any);
              for await (const chunk of toolResultStream) {
                  const text = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("");
                  if (text) {
                      controller.enqueue(encoder.encode(text));
                  }
              }
          }

          controller.close();
        } catch (e) {
          console.error(e);
          controller.enqueue(encoder.encode(`\n\nError: ${e}`));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: { 
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
