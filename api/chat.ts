import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import * as cheerio from "cheerio";

export const config = {
  runtime: 'nodejs', // Using Node.js runtime for stability with cheerio/SDK
};

const SEARCH_TOOL: any = {
  name: "search_booth",
  description: "Search for VRChat assets on Booth.pm (a marketplace). Use this tool to find real items, prices, and images. Always translate keywords to Japanese before searching.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      keyword: {
        type: SchemaType.STRING,
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

export default async function handler(req: any, res: any) {
  // Use Vercel's standard Node.js handler signature if possible, or Web API
  // Since we use 'nodejs' runtime, we can use standard req/res or Web API if configured.
  // But let's stick to Web API signature by not using 'res' object methods if we return Response.
  // Actually, Vercel Node runtime supports Web API Request/Response if we don't use 'res'.
  
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    // Need to handle both Web API Request and Node.js IncomingMessage
    // If runtime is 'nodejs', req is IncomingMessage usually, but we can parse body.
    // To make it simple and consistent, we'll assume standard JSON body parsing.
    
    // BUT wait, in 'nodejs' runtime, we should use res.status().json() or stream.
    // Let's use standard Web Streams API with Response object which Vercel supports.
    
    let body;
    if (req.json) {
        body = await req.json();
    } else {
        // Node.js buffering style if req.json is not available
        body = JSON.parse(req.body); 
    }
    
    const { messages } = body;
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) return new Response('Configuration Error: GEMINI_API_KEY missing', { status: 500 });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        systemInstruction: `
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
        `,
        tools: [{ functionDeclarations: [SEARCH_TOOL] }]
    });
    
    const history = messages.slice(0, -1).map((m: any) => {
        const parts: any[] = [];
        if (m.text) parts.push({ text: m.text });
        if (m.image) {
             const match = m.image.match(/^data:(.*?);base64,(.*)$/);
             if (match) {
                 parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
             }
        }
        if (parts.length === 0) parts.push({ text: " " });
        return { role: m.role, parts };
    });

    const chat = model.startChat({ history });

    const lastMsg = messages[messages.length - 1];
    const lastMsgParts: any[] = [];
    if (lastMsg.text) lastMsgParts.push({ text: lastMsg.text });
    if (lastMsg.image) {
         const match = lastMsg.image.match(/^data:(.*?);base64,(.*)$/);
         if (match) lastMsgParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
    if (lastMsgParts.length === 0) lastMsgParts.push({ text: " " });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let result = await chat.sendMessageStream(lastMsgParts);
          
          let functionCalls: any[] = [];
          
          for await (const chunk of result.stream) {
             const text = chunk.text();
             if (text) {
                 controller.enqueue(encoder.encode(text));
             }
             
             // Check for function calls
             // In @google/generative-ai, chunk.functionCalls() returns array
             const calls = chunk.functionCalls();
             if (calls && calls.length > 0) {
                 functionCalls.push(...calls);
             }
          }

          // Handle function calls
          if (functionCalls.length > 0) {
              const toolResponses = [];
              for (const call of functionCalls) {
                  if (call.name === 'search_booth') {
                      const keyword = (call.args as any).keyword;
                      const items = await executeSearchBooth(keyword);
                      toolResponses.push({
                          functionResponse: {
                              name: call.name,
                              response: { result: items }
                          }
                      });
                  } else {
                      toolResponses.push({
                          functionResponse: {
                              name: call.name,
                              response: { error: "Unknown tool" }
                          }
                      });
                  }
              }

              // Send tool results back
              // NOTE: In @google/generative-ai, we send Parts array
              const toolResultStream = await chat.sendMessageStream(toolResponses);
              for await (const chunk of toolResultStream.stream) {
                  const text = chunk.text();
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
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}
