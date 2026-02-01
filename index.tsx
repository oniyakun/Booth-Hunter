import React, { useState, useRef, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Chat, Type, FunctionDeclaration } from "@google/genai";
import { Search, Image as ImageIcon, Upload, ExternalLink, Loader2, Sparkles, ShoppingBag, X, AlertCircle, Terminal, ChevronDown, ChevronUp, Send, Bot, User, MoveHorizontal, Hammer } from "lucide-react";
import ReactMarkdown from "react-markdown";

// --- Types ---

interface AssetResult {
  id: string;
  title: string;
  shopName: string;
  price: string;
  url: string;
  imageUrl?: string;
  description: string;
  tags: string[];
}

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  items?: AssetResult[];
  image?: string;
  timestamp: number;
  toolCall?: string; // Track if this message involved a tool call
  isStreaming?: boolean;
}

interface DebugLog {
  timestamp: string;
  label: string;
  content: string | object;
  type: 'info' | 'request' | 'response' | 'error' | 'success' | 'tool';
}

// --- Components ---

const DebugConsole = ({ logs, isOpen, setIsOpen }: { logs: DebugLog[], isOpen: boolean, setIsOpen: (v: boolean) => void }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isOpen]);

  return (
    <div className={`fixed bottom-0 left-0 right-0 bg-[#0c0c0e] border-t border-zinc-800 transition-all duration-300 z-50 flex flex-col ${isOpen ? 'h-80' : 'h-10'}`}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="h-10 bg-zinc-900 flex items-center justify-between px-4 text-xs font-mono text-zinc-400 hover:text-white border-b border-zinc-800"
      >
        <div className="flex items-center gap-2">
          <Terminal size={14} />
          <span>DEBUG CONSOLE {logs.length > 0 && `(${logs.length})`}</span>
        </div>
        {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      
      {isOpen && (
        <div ref={scrollRef} className="flex-1 overflow-auto p-4 font-mono text-xs space-y-4">
          {logs.map((log, i) => (
            <div key={i} className="border-l-2 border-zinc-800 pl-3">
              <div className="flex items-center gap-2 mb-1 opacity-50">
                <span className="text-[10px]">{log.timestamp}</span>
                <span className={`px-1.5 rounded text-[10px] font-bold ${
                  log.type === 'request' ? 'bg-blue-900 text-blue-200' :
                  log.type === 'response' ? 'bg-purple-900 text-purple-200' :
                  log.type === 'success' ? 'bg-green-900 text-green-200' :
                  log.type === 'error' ? 'bg-red-900 text-red-200' :
                  log.type === 'tool' ? 'bg-yellow-900 text-yellow-200' :
                  'bg-zinc-800 text-zinc-300'
                }`}>
                  {log.label}
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words text-zinc-300 leading-relaxed">
                {typeof log.content === 'string' ? log.content : JSON.stringify(log.content, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// High Performance Draggable Container (Memoized + RAF)
const DraggableContainer = React.memo(({ children }: { children: React.ReactNode }) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDown = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);
  const rafId = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    if (!scrollContainerRef.current) return;
    isDown.current = true;
    scrollContainerRef.current.style.cursor = 'grabbing';
    scrollContainerRef.current.style.userSelect = 'none';
    scrollContainerRef.current.style.scrollBehavior = 'auto'; 
    startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
    scrollLeft.current = scrollContainerRef.current.scrollLeft;
  };

  const onMouseLeave = () => { stopDragging(); };
  const onMouseUp = () => { stopDragging(); };

  const stopDragging = () => {
    if (!scrollContainerRef.current) return;
    isDown.current = false;
    scrollContainerRef.current.style.cursor = 'grab';
    scrollContainerRef.current.style.removeProperty('user-select');
    scrollContainerRef.current.style.removeProperty('scroll-behavior');
    if (rafId.current) cancelAnimationFrame(rafId.current);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDown.current || !scrollContainerRef.current) return;
    e.preventDefault();
    
    // Use requestAnimationFrame for smoother updates
    if (rafId.current) cancelAnimationFrame(rafId.current);
    
    const x = e.pageX - scrollContainerRef.current.offsetLeft;
    const walk = (x - startX.current) * 1.5; // Adjusted sensitivity
    
    rafId.current = requestAnimationFrame(() => {
        if(scrollContainerRef.current) {
            scrollContainerRef.current.scrollLeft = scrollLeft.current - walk;
        }
    });
  };

  return (
    <div 
      ref={scrollContainerRef}
      className="mt-6 w-full overflow-x-auto pb-8 scrollbar-hide flex gap-5 cursor-grab"
      onMouseDown={onMouseDown}
      onMouseLeave={onMouseLeave}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
    >
      {children}
    </div>
  );
});

const AssetCard = React.memo(({ asset }: { asset: AssetResult }) => {
  const [imgError, setImgError] = useState(false);

  const getGradient = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c1 = Math.abs(hash) % 360;
    const c2 = (c1 + 40) % 360;
    return `linear-gradient(135deg, hsl(${c1}, 70%, 20%), hsl(${c2}, 70%, 15%))`;
  };

  return (
    <div className="group relative bg-[#18181b] border border-[#27272a] rounded-2xl overflow-hidden hover:border-[#fc4d50] transition-all duration-300 flex flex-col w-[300px] flex-shrink-0 shadow-lg hover:shadow-2xl hover:shadow-[#fc4d50]/10">
      <div className="h-56 w-full relative overflow-hidden bg-zinc-900 border-b border-[#27272a]">
        {asset.imageUrl && !imgError ? (
          <img 
            src={asset.imageUrl} 
            alt={asset.title} 
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div 
            className="w-full h-full flex flex-col items-center justify-center p-6 text-center"
            style={{ background: getGradient(asset.title) }}
          >
            <ShoppingBag size={40} className="mb-4 text-white/40" />
            <span className="text-sm text-zinc-300 font-medium line-clamp-3 px-4 leading-relaxed">{asset.title}</span>
          </div>
        )}
        <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-md text-white text-sm font-bold px-2.5 py-1 rounded-md border border-white/10 shadow-sm">
          {asset.price}
        </div>
      </div>

      <div className="p-5 flex flex-col flex-grow">
        <div className="flex justify-between items-start mb-3 min-h-[3rem]">
          <h3 className="font-bold text-base text-white leading-snug line-clamp-2 group-hover:text-[#fc4d50] transition-colors">
            {asset.title}
          </h3>
        </div>
        
        <p className="text-sm text-zinc-400 mb-4 line-clamp-2 flex-grow leading-relaxed">
          {asset.description || asset.shopName}
        </p>

        <div className="flex flex-wrap gap-2 mb-4 h-6 overflow-hidden">
          {asset.tags && asset.tags.slice(0, 3).map((tag, i) => (
            <span key={i} className="text-[10px] px-2 py-0.5 bg-[#27272a] border border-zinc-800 rounded text-zinc-300">
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-auto pt-4 border-t border-[#27272a] flex justify-between items-center">
             <div className="flex items-center gap-1.5 max-w-[60%]">
               <div className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-500">
                 <ShoppingBag size={10} />
               </div>
               <span className="text-xs text-zinc-400 truncate">{asset.shopName}</span>
             </div>
             <a 
              href={asset.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-[#fc4d50] hover:bg-[#d93f42] px-4 py-2 rounded-lg transition-colors shadow-lg shadow-red-900/20"
            >
              详情
              <ExternalLink size={12} />
            </a>
        </div>
      </div>
    </div>
  );
});

const ChatMessageBubble = React.memo(({ message }: { message: Message }) => {
  const isUser = message.role === 'user';
  
  // Filter out JSON code blocks from display text
  const displayText = React.useMemo(() => {
    let text = message.text;
    // Remove completed JSON blocks
    text = text.replace(/```json[\s\S]*?```/gi, '');
    // Remove potentially incomplete JSON block at the end if streaming
    text = text.replace(/```json[\s\S]*/gi, '');
    return text.trim();
  }, [message.text]);

  return (
    <div className={`flex w-full mb-8 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col max-w-[95%] md:max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        
        {/* Avatar & Name */}
        <div className={`flex items-center gap-3 mb-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg border border-white/5 ${isUser ? 'bg-zinc-700' : 'bg-[#fc4d50]'}`}>
            {isUser ? <User size={18} /> : <Bot size={18} />}
          </div>
          <span className="text-sm font-medium text-zinc-400">{isUser ? 'You' : 'Booth Hunter'}</span>
        </div>

        {/* Bubble Content with Markdown */}
        <div className={`px-6 py-4 rounded-3xl shadow-md ${
          isUser 
            ? 'bg-zinc-800 text-zinc-100 rounded-tr-sm' 
            : 'bg-zinc-900/90 border border-zinc-800 text-zinc-200 rounded-tl-sm'
        }`}>
          {message.image && (
            <img src={message.image} alt="Upload" className="max-h-64 rounded-xl mb-4 border border-zinc-700" />
          )}
          
          {/* Tool Call Indicator */}
          {message.toolCall && (
            <div className={`mb-3 flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-lg border transition-all duration-300 ${
              message.toolCall.includes("重试") 
                ? "text-red-400/90 bg-red-500/10 border-red-500/20 animate-pulse" 
                : "text-yellow-500/80 bg-yellow-500/10 border-yellow-500/20"
            }`}>
              <Hammer size={12} className={message.toolCall.includes("重试") ? "animate-spin" : ""} />
              <span>调用工具: {message.toolCall}</span>
            </div>
          )}

          {/* Markdown Rendering */}
          <div className="markdown-body text-base leading-relaxed">
            <ReactMarkdown>
                {displayText}
            </ReactMarkdown>
            {message.isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-[#fc4d50] animate-pulse align-middle"></span>}
          </div>
        </div>

        {/* Asset Cards Grid */}
        {message.items && message.items.length > 0 && (
          <div className="w-full mt-6 pl-2">
            <DraggableContainer>
              {message.items.map((item, idx) => (
                <AssetCard key={item.id || idx} asset={item} />
              ))}
            </DraggableContainer>
            <div className="flex items-center justify-center gap-2 text-xs text-zinc-600 mt-3 opacity-60 font-medium">
                <MoveHorizontal size={12} />
                <span>按住卡片左右拖动查看更多</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

// --- Main App ---

const SEARCH_TOOL: FunctionDeclaration = {
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

// Proxy definitions for rotation
const PROXIES = [
  { name: "CodeTabs", url: (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`, type: 'html' },
  { name: "AllOrigins", url: (u: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, type: 'json' },
  { name: "CorsProxy", url: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`, type: 'html' }
];

const App = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [processingTool, setProcessingTool] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  
  const chatSessionRef = useRef<Chat | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Scraper Implementation ---
  const executeSearchBooth = async (keyword: string, attemptIndex: number = 0) => {
    // Select proxy based on attempt index (round-robin)
    const proxy = PROXIES[attemptIndex % PROXIES.length];
    
    try {
      addLog('TOOL_EXEC', `Scraping Booth for: ${keyword} via ${proxy.name} (Attempt ${attemptIndex + 1})`, 'tool');
      
      const targetUrl = `https://booth.pm/ja/search/${encodeURIComponent(keyword)}`;
      const proxyUrl = proxy.url(targetUrl);
      
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`Proxy ${proxy.name} returned ${res.status}`);
      
      let htmlContent = "";
      
      if (proxy.type === 'json') {
          const data = await res.json();
          htmlContent = data.contents;
          if (!htmlContent) throw new Error("No content in JSON response");
      } else {
          htmlContent = await res.text();
      }
      
      if (htmlContent.length < 500) {
           addLog('PROXY_WARN', `Content suspiciously short (${htmlContent.length} chars)`, 'info');
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, "text/html");
      const items = Array.from(doc.querySelectorAll("li.item-card")).map((el) => {
          const title = el.querySelector(".item-card__title")?.textContent?.trim() || "No Title";
          const shopName = el.querySelector(".item-card__shop-name")?.textContent?.trim() || "Unknown Shop";
          const price = el.querySelector(".price")?.textContent?.trim() || "Free";
          const linkEl = el.querySelector(".item-card__title-anchor") as HTMLAnchorElement;
          const url = linkEl?.getAttribute("href") || "";
          const fullUrl = url.startsWith("http") ? url : `https://booth.pm${url}`;
          const id = el.getAttribute("data-product-id") || url.split("/").pop() || "";
          
          const imgEl = el.querySelector(".item-card__thumbnail-image") as HTMLImageElement;
          const imageUrl = imgEl?.getAttribute("data-original") || imgEl?.getAttribute("data-src") || imgEl?.getAttribute("src") || "";

          return {
            id,
            title,
            shopName,
            price,
            url: fullUrl,
            imageUrl,
            description: "",
            tags: []
          };
      });

      addLog('TOOL_RESULT', `Found ${items.length} raw items`, 'success');
      return items.slice(0, 10);
    } catch (e: any) {
      addLog('TOOL_ERROR', `${proxy.name} failed: ${e.message}`, 'error');
      return [];
    }
  };

  useEffect(() => {
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      const ai = new GoogleGenAI({ apiKey });
      
      const systemPrompt = `
        你是一个 VRChat Booth 资产导购助手。
        
        **工具使用规则**:
        1.  当用户寻找素材时，**必须**调用 \`search_booth\` 工具。不要凭空编造商品。
        2.  调用工具前，先将用户的中文关键词翻译成日文。
        3.  工具会返回真实的搜索结果（JSON格式）。

        **回复生成规则**:
        1.  收到工具返回的结果后，请从中挑选 4-8 个最符合用户需求的商品。
        2.  用 Markdown 列表向用户简要介绍这些商品（标题、价格、推荐理由）。
        3.  **关键**: 在回复的最后，必须包含一个 JSON 代码块，用于前端渲染卡片。
        
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
      `;

      chatSessionRef.current = ai.chats.create({
        model: "gemini-3-pro-preview",
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: [SEARCH_TOOL] }],
        }
      });
      
      setMessages([{
        id: 'init',
        role: 'model',
        text: '你好！我是 Booth Hunter。\n\n现在的我拥有了**实时抓取**能力！\n告诉我你想要什么（例如：“帮我找适合桔梗的朋克风衣服”），我会直接调用工具去 Booth.pm 帮你“爬”下来！',
        timestamp: Date.now()
      }]);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, processingTool]);

  const addLog = (label: string, content: string | object, type: DebugLog['type'] = 'info') => {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    setDebugLogs(prev => [...prev, { timestamp, label, content, type }]);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
        addLog('USER_ACTION', `Image attached: ${file.name}`, 'info');
      };
      reader.readAsDataURL(file);
    }
  };

  // Helper to parse JSON from text (only at end of stream)
  const extractItems = (text: string): AssetResult[] | undefined => {
    const jsonBlockRegex = /```json\s*(\[[\s\S]*?\])\s*```/i;
    const match = text.match(jsonBlockRegex);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch (e) {
        return undefined;
      }
    }
    return undefined;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !image) || loading || !chatSessionRef.current) return;

    const userText = input;
    const userImage = image;
    
    setInput("");
    setImage(null);
    setLoading(true);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: userText,
      image: userImage || undefined,
      timestamp: Date.now()
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      addLog('REQ_START', `Sending message...`, 'request');

      const parts: any[] = [{ text: userText }];
      if (userImage) {
        const match = userImage.match(/^data:(.*?);base64,/);
        const mimeType = match ? match[1] : "image/png";
        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: userImage.split(',')[1]
          }
        });
      }

      // Initial Placeholder for Streaming
      const modelMsgId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: modelMsgId,
        role: 'model',
        text: '',
        timestamp: Date.now(),
        isStreaming: true
      }]);

      let accumulatedText = "";
      
      // 1. Send Message Stream
      const stream = await chatSessionRef.current.sendMessageStream({ message: parts });
      
      let functionCalls: any[] = [];

      for await (const chunk of stream) {
        // Safe text extraction avoiding "non-text parts" warning
        const chunkText = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
        
        accumulatedText += chunkText;
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: accumulatedText } : m));
        
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            functionCalls.push(...chunk.functionCalls);
        }
      }

      // 2. Handle Function Calls Loop
      if (functionCalls.length > 0) {
        setProcessingTool(true);
        const toolResponses: any[] = [];
        let toolName = "";

        for (const call of functionCalls) {
          addLog('FUNC_CALL', call, 'tool');
          toolName = call.name;
          
          if (call.name === "search_booth") {
            const keyword = (call.args as any).keyword;
            
            let items: AssetResult[] = [];
            let attempts = 0;
            const maxAttempts = 3;

            // Retry logic
            while (attempts < maxAttempts) {
                // Determine proxy strategy inside executeSearchBooth based on attempt index
                const currentAttempt = attempts; 
                attempts++;
                const isRetry = attempts > 1;

                // Update UI status for retry
                setMessages(prev => prev.map(m => m.id === modelMsgId ? { 
                    ...m, 
                    toolCall: isRetry ? `搜索 "${keyword}" (重试 ${attempts-1}/${maxAttempts-1})...` : `搜索 "${keyword}"`, 
                    isStreaming: false 
                } : m));

                if (isRetry) {
                   addLog('RETRY', `Attempt ${attempts} for ${keyword}`, 'error');
                }

                // Pass attempts to rotate proxies
                items = await executeSearchBooth(keyword, currentAttempt);

                if (items.length > 0) {
                    break;
                }
                
                // Wait before next retry if failed
                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            
            toolResponses.push({
              functionResponse: {
                name: call.name,
                id: call.id,
                response: { result: items } 
              }
            });
          }
        }

        // 3. Send Tool Results & Stream Final Response
        addLog('TOOL_RESP', `Sending ${toolResponses.length} results back`, 'request');
        
        // Append a new part to the conversation or continue? 
        // We just stream the text into the SAME message bubble for seamless UX.
        // Or create a new bubble if the previous one was just "Thinking..."?
        // Let's reuse the bubble but clear text if it was empty, or append.
        
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, isStreaming: true, text: m.text + "\n\n" } : m));
        
        const toolResult = await chatSessionRef.current.sendMessageStream({ message: toolResponses });
        
        for await (const chunk of toolResult) {
          // Safe text extraction
          const chunkText = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
          
          accumulatedText += chunkText;
          setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: accumulatedText } : m));
        }
        
        setProcessingTool(false);
      }

      // 4. Final Processing (JSON Extraction)
      const items = extractItems(accumulatedText);
      let finalText = accumulatedText;
      
      // Remove JSON block from display text if items found
      if (items) {
        const jsonBlockRegex = /```json\s*(\[[\s\S]*?\])\s*```/i;
        finalText = accumulatedText.replace(jsonBlockRegex, "").trim();
      }

      setMessages(prev => prev.map(m => m.id === modelMsgId ? { 
        ...m, 
        text: finalText, 
        items: items, 
        isStreaming: false 
      } : m));

      addLog('DONE', 'Stream complete', 'success');

    } catch (err: any) {
      addLog('ERROR', err.message, 'error');
      setProcessingTool(false);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'model',
        text: "抱歉，连接或解析过程中出现错误，请稍后再试。",
        timestamp: Date.now()
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-[#fc4d50] selection:text-white">
      
      <header className="flex-none px-6 py-4 border-b border-zinc-800 bg-[#09090b]/80 backdrop-blur-md z-10 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-[#fc4d50] w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-[0_0_20px_rgba(252,77,80,0.4)]">
            B
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-none text-white">Booth Hunter</h1>
            <p className="text-[10px] text-zinc-400 font-mono tracking-wide mt-0.5">GEMINI 3.0 AGENT</p>
          </div>
        </div>
        <button 
          onClick={() => setShowDebug(!showDebug)}
          className={`p-2 rounded-lg transition-colors ${showDebug ? 'text-[#fc4d50] bg-zinc-900' : 'text-zinc-500 hover:text-white'}`}
        >
          <Terminal size={20} />
        </button>
      </header>

      <main className="flex-grow overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
        <div className="max-w-4xl mx-auto flex flex-col justify-end min-h-full pb-4">
          {messages.map((msg) => (
            <ChatMessageBubble key={msg.id} message={msg} />
          ))}

          {/* Loading States */}
          {(loading && !messages.find(m => m.isStreaming)) && (
             <div className="flex w-full mb-6 justify-start animate-pulse">
               <div className="flex flex-col items-start max-w-[85%]">
                 <div className="flex items-center gap-3 mb-2">
                   <div className="w-9 h-9 rounded-full bg-[#fc4d50] flex items-center justify-center shadow-lg border border-white/5">
                     <Loader2 size={18} className="animate-spin text-white" />
                   </div>
                   <span className="text-sm font-medium text-zinc-400">正在思考...</span>
                 </div>
               </div>
            </div>
          )}
          
          {processingTool && (
             <div className="flex w-full mb-6 justify-start animate-fade-in-up">
               <div className="flex flex-col items-start max-w-[85%]">
                 <div className="flex items-center gap-2 mb-2 ml-12 text-yellow-500/80 text-xs font-mono">
                    <Hammer size={12} className="animate-bounce" />
                    <span>正在抓取 Booth 数据...</span>
                 </div>
               </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="flex-none p-4 md:p-6 bg-[#09090b] border-t border-zinc-800 z-20">
        <div className="max-w-4xl mx-auto">
          {image && (
            <div className="mb-3 flex items-start animate-fade-in-up">
              <div className="relative group">
                <img src={image} alt="Ref" className="h-20 w-20 rounded-xl object-cover border border-zinc-700 shadow-xl" />
                <button 
                  onClick={() => setImage(null)}
                  className="absolute -top-2 -right-2 bg-black text-white rounded-full p-1.5 opacity-80 hover:opacity-100 transition-opacity border border-zinc-700"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="relative flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-3.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-2xl transition-all border border-transparent hover:border-zinc-700"
              title="Upload Image"
            >
              <ImageIcon size={22} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
            />
            
            <div className="flex-grow relative">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="描述你想要的素材 (例如: 桔梗的赛博风外套)..."
                className="w-full bg-zinc-900/80 border border-zinc-800 text-zinc-100 rounded-2xl px-5 py-4 pr-14 text-base focus:outline-none focus:border-[#fc4d50] focus:ring-1 focus:ring-[#fc4d50] transition-all placeholder-zinc-600 shadow-inner"
              />
              <button
                type="submit"
                disabled={loading || (!input.trim() && !image)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-[#fc4d50] text-white rounded-xl hover:bg-[#d93f42] disabled:opacity-50 disabled:bg-zinc-700 transition-all shadow-lg hover:shadow-red-900/30"
              >
                <Send size={18} />
              </button>
            </div>
          </form>
          <p className="text-center text-[10px] text-zinc-600 mt-3 font-medium">
            AI 生成内容可能不准确，请以 Booth 实际页面为准。
          </p>
        </div>
      </footer>

      <DebugConsole logs={debugLogs} isOpen={showDebug} setIsOpen={setShowDebug} />

      <style>{`
        .cursor-grabbing {
          cursor: grabbing !important;
        }
        @keyframes fade-in-up {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
            animation: fade-in-up 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);