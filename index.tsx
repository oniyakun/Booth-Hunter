import React, { useState, useRef, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Chat, Type, FunctionDeclaration, Content } from "@google/genai";
import { Search, Image as ImageIcon, Upload, ExternalLink, Loader2, Sparkles, ShoppingBag, X, AlertCircle, Terminal, ChevronDown, ChevronUp, Send, Bot, User, MoveHorizontal, Hammer, LogOut, History, Plus, Menu, UserCircle, Layout, MessageSquare, Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "./supabaseClient";
import { Analytics } from "@vercel/analytics/react";

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

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  created_at: string;
}

// --- Components ---

// Auth Modal Component
const AuthModal = ({ isOpen, onClose, onLogin, canClose = true }: { isOpen: boolean; onClose: () => void; onLogin: () => void; canClose?: boolean }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onLogin();
        onClose();
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setError("注册成功！请检查邮箱完成验证。");
        // For development/testing often no email verification is needed if configured so
        if (!error) {
             onLogin();
             onClose();
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
      <div className="bg-[#18181b] border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl relative">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">{isLogin ? "登录" : "注册"}</h2>
          {canClose && (
            <button onClick={onClose} className="text-zinc-400 hover:text-white">
              <X size={20} />
            </button>
          )}
        </div>
        
        {!canClose && (
          <div className="mb-6 text-sm text-zinc-400 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/50">
            👋 欢迎！请先登录或注册以继续使用 Booth Hunter。
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-200 text-sm flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#fc4d50]"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#fc4d50]"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#fc4d50] hover:bg-[#d93f42] text-white font-bold py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={18} className="animate-spin mx-auto" /> : (isLogin ? "登录" : "注册")}
          </button>
        </form>

        <div className="mt-4 text-center text-sm text-zinc-400">
          {isLogin ? "没有账号？" : "已有账号？"}
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="ml-1 text-[#fc4d50] hover:underline font-medium"
          >
            {isLogin ? "立即注册" : "去登录"}
          </button>
        </div>
      </div>
    </div>
  );
};

// Sidebar Component
const Sidebar = ({ 
  isOpen, 
  onClose, 
  user, 
  sessions, 
  currentSessionId, 
  onSelectSession, 
  onNewChat,
  onOpenAuth,
  onDeleteSession
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  user: any; 
  sessions: ChatSession[]; 
  currentSessionId: string | null; 
  onSelectSession: (id: string) => void; 
  onNewChat: () => void;
  onOpenAuth: () => void;
  onDeleteSession: (id: string) => void;
}) => {
  return (
    <>
      {/* Overlay for mobile */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden"
          onClick={onClose}
        />
      )}
      
      <div className={`fixed inset-y-0 left-0 z-40 w-80 bg-[#0c0c0e] border-r border-zinc-800 transform transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 md:static`}>
        <div className="flex flex-col h-full">
          <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2 text-white font-bold">
              <div className="bg-[#fc4d50] w-7 h-7 rounded-lg flex items-center justify-center text-white text-sm">B</div>
              <span>Booth Hunter</span>
            </div>
            <button onClick={onClose} className="md:hidden text-zinc-400">
              <X size={20} />
            </button>
          </div>

          <div className="p-4">
            <button
              onClick={() => { onNewChat(); if(window.innerWidth < 768) onClose(); }}
              className="w-full bg-zinc-800 hover:bg-zinc-700 text-white flex items-center gap-2 px-4 py-3 rounded-xl transition-colors font-medium border border-zinc-700"
            >
              <Plus size={18} />
              <span>新对话</span>
            </button>
          </div>

          <div className="flex-grow overflow-y-auto px-2 space-y-1 scrollbar-thin scrollbar-thumb-zinc-800">
            <h3 className="px-3 text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2 mt-2">历史记录</h3>
            {!user ? (
               <div className="px-3 text-sm text-zinc-500 py-4 text-center">
                 登录后可保存和查看历史记录
               </div>
            ) : sessions.length === 0 ? (
               <div className="px-3 text-sm text-zinc-500 py-4 text-center">
                 暂无历史记录
               </div>
            ) : (
              sessions.map((session) => (
                <div key={session.id} className="group flex items-center gap-1 w-full">
                  <button
                    onClick={() => { onSelectSession(session.id); if(window.innerWidth < 768) onClose(); }}
                    className={`flex-grow text-left px-3 py-3 rounded-lg text-sm flex items-center gap-3 transition-colors ${
                      currentSessionId === session.id 
                        ? "bg-[#fc4d50]/10 text-[#fc4d50] border border-[#fc4d50]/20" 
                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                    }`}
                  >
                    <MessageSquare size={16} className="flex-shrink-0" />
                    <span className="truncate text-left">
                      {session.title?.slice(0, 18) || "未命名对话"}
                      {(session.title?.length || 0) > 18 ? "..." : ""}
                    </span>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                    className="p-2 text-zinc-600 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                    title="删除对话"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="p-4 border-t border-zinc-800">
            {user ? (
              <div className="flex items-center justify-between">
                 <div className="flex items-center gap-2 overflow-hidden">
                    <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400">
                      <UserCircle size={20} />
                    </div>
                    <div className="flex flex-col truncate">
                      <span className="text-sm text-white truncate font-medium">{user.email?.split('@')[0]}</span>
                      <span className="text-[10px] text-zinc-500 truncate">{user.email}</span>
                    </div>
                 </div>
                 <button 
                  onClick={async () => { await supabase.auth.signOut(); }}
                  className="text-zinc-500 hover:text-white p-2"
                  title="退出登录"
                 >
                   <LogOut size={18} />
                 </button>
              </div>
            ) : (
              <button
                onClick={onOpenAuth}
                className="w-full flex items-center justify-center gap-2 text-zinc-300 hover:text-white py-2 rounded-lg hover:bg-zinc-800 transition-colors text-sm font-medium"
              >
                <UserCircle size={18} />
                <span>登录 / 注册</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
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
  
  // Auth & Session State
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  
  const chatSessionRef = useRef<Chat | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Auth & DB Effects ---

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user) {
        setIsAuthOpen(false);
        fetchSessions();
      } else {
        setIsAuthOpen(true);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user) {
        setIsAuthOpen(false);
        fetchSessions();
      } else {
        setSessions([]);
        setCurrentSessionId(null);
        setIsAuthOpen(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchSessions = async () => {
    const { data, error } = await supabase
      .from('chats')
      .select('id, title, messages, created_at')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching chats:', error);
    } else {
      setSessions((data as any[]) || []);
    }
  };

  const saveCurrentSession = async (newMessages: Message[]) => {
    if (!user) return;
    
    // Determine title from first user message
    const firstUserMsg = newMessages.find(m => m.role === 'user');
    const title = firstUserMsg ? (firstUserMsg.text.slice(0, 20) + (firstUserMsg.text.length > 20 ? '...' : '')) : 'New Chat';

    try {
      if (currentSessionId) {
        // Update existing
        await supabase
          .from('chats')
          .update({ messages: newMessages, updated_at: new Date().toISOString() })
          .eq('id', currentSessionId);
        
        // Update local list
        setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, messages: newMessages } : s));
      } else {
        // Create new
        const { data, error } = await supabase
          .from('chats')
          .insert({ 
            user_id: user.id, 
            title, 
            messages: newMessages 
          })
          .select()
          .single();
        
        if (data) {
          setCurrentSessionId(data.id);
          setSessions(prev => [data, ...prev]);
        }
      }
    } catch (e) {
      console.error("Save error:", e);
    }
  };

  const handleSelectSession = (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session) {
      setCurrentSessionId(id);
      setMessages(session.messages);
      
      // Convert messages to history for AI context
      const history: Content[] = session.messages
        .filter(m => m.id !== 'init' && !m.isStreaming && !m.toolCall)
        .map(m => ({
          role: m.role,
          parts: [{ text: m.text }]
        }));

      initChat(history, true); 
    }
  };

  const handleNewChat = () => {
    setCurrentSessionId(null);
    initChat(undefined, false);
  };

  const handleDeleteSession = async (id: string) => {
    if (!window.confirm("确定要删除这条对话记录吗？")) return;

    try {
      const { error } = await supabase
        .from('chats')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setSessions(prev => prev.filter(s => s.id !== id));
      
      if (currentSessionId === id) {
        handleNewChat();
      }
    } catch (e) {
      console.error("Delete error:", e);
      alert("删除失败，请稍后重试");
    }
  };

  // --- Chat Logic ---

  const initChat = (history?: Content[], keepMessages: boolean = false) => {
     const apiKey = process.env.API_KEY;
     if (apiKey) {
      const ai = new GoogleGenAI({ apiKey });
      const systemPrompt = `
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
          { "id": "商品ID", "title": "完整标题", "shopName": "店铺名", "price": "价格", "url": "...", "imageUrl": "...", "description": "...", "tags": ["Tag1"] }
        ]
        \`\`\`
      `;
      chatSessionRef.current = ai.chats.create({
        model: "gemini-3-pro-preview",
        config: { systemInstruction: systemPrompt, tools: [{ functionDeclarations: [SEARCH_TOOL] }] },
        history: history
      });
      
      if (!keepMessages) {
        setMessages([{
          id: 'init',
          role: 'model',
          text: '你好！我是 Booth Hunter。\n\n我是由Oniya开发的Booth商品搜索助手，请告诉我你想要找的VRChat资产吧！',
          timestamp: Date.now()
        }]);
      }
     }
  };

  // Scraper implementation
  const executeSearchBooth = async (keyword: string, attemptIndex: number = 0) => {
    const proxy = PROXIES[attemptIndex % PROXIES.length];
    try {
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
          return { id, title, shopName, price, url: fullUrl, imageUrl, description: "", tags: [] };
      });
      return items.slice(0, 10);
    } catch (e: any) {
      console.error(`Scrape error (${proxy.name}):`, e.message);
      return [];
    }
  };

  useEffect(() => {
    // Only init if no current session (first load)
    if (!currentSessionId && messages.length === 0) {
      initChat(undefined, false);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, processingTool]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

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
    
    // Optimistic update
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    // Save immediate user message if desired, but better wait for bot response to save pair
    
    try {
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

      const modelMsgId = (Date.now() + 1).toString();
      // Placeholder
      setMessages(prev => [...prev, {
        id: modelMsgId,
        role: 'model',
        text: '',
        timestamp: Date.now(),
        isStreaming: true
      }]);

      let accumulatedText = "";
      
      const stream = await chatSessionRef.current.sendMessageStream({ message: parts });
      let functionCalls: any[] = [];

      for await (const chunk of stream) {
        const chunkText = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
        accumulatedText += chunkText;
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: accumulatedText } : m));
        
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            functionCalls.push(...chunk.functionCalls);
        }
      }

      if (functionCalls.length > 0) {
        setProcessingTool(true);
        const toolResponses: any[] = [];
        let toolName = "";

        for (const call of functionCalls) {
          toolName = call.name;
          
          if (call.name === "search_booth") {
            const keyword = (call.args as any).keyword;
            let items: AssetResult[] = [];
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                const currentAttempt = attempts; 
                attempts++;
                const isRetry = attempts > 1;

                setMessages(prev => prev.map(m => m.id === modelMsgId ? { 
                    ...m, 
                    toolCall: isRetry ? `搜索 "${keyword}" (重试 ${attempts-1}/${maxAttempts-1})...` : `搜索 "${keyword}"`, 
                    isStreaming: false 
                } : m));

                if (isRetry) console.warn(`Attempt ${attempts} for ${keyword} failed`);
                items = await executeSearchBooth(keyword, currentAttempt);
                if (items.length > 0) break;
                if (attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 2000));
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

        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, isStreaming: true, text: m.text + "\n\n" } : m));
        
        const toolResult = await chatSessionRef.current.sendMessageStream({ message: toolResponses });
        for await (const chunk of toolResult) {
          const chunkText = chunk.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
          accumulatedText += chunkText;
          setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: accumulatedText } : m));
        }
        setProcessingTool(false);
      }

      const items = extractItems(accumulatedText);
      let finalText = accumulatedText;
      if (items) {
        const jsonBlockRegex = /```json\s*(\[[\s\S]*?\])\s*```/i;
        finalText = accumulatedText.replace(jsonBlockRegex, "").trim();
      }

      const finalModelMsg: Message = { 
        id: modelMsgId,
        role: 'model', 
        text: finalText, 
        items: items, 
        isStreaming: false,
        timestamp: Date.now()
      };

      const finalMessages = [...updatedMessages, finalModelMsg];
      setMessages(finalMessages);
      
      // Save to DB
      await saveCurrentSession(finalMessages);

    } catch (err: any) {
      console.error(err);
      setProcessingTool(false);
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'model',
        text: "出错了！你可以告诉我“重试”来再次尝试。",
        timestamp: Date.now()
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#09090b] text-zinc-100 font-sans selection:bg-[#fc4d50] selection:text-white overflow-hidden">
      
      <Sidebar 
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        user={user}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onOpenAuth={() => setIsAuthOpen(true)}
        onDeleteSession={handleDeleteSession}
      />

      <div className="flex-1 flex flex-col h-full min-w-0">
        <header className="flex-none px-4 py-4 border-b border-zinc-800 bg-[#09090b]/80 backdrop-blur-md z-10 flex justify-between items-center">
          <div className="flex items-center gap-3">
             <button 
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden text-zinc-400 hover:text-white"
             >
               <Menu size={24} />
             </button>
             <div className="flex items-center gap-3 md:hidden">
                <div className="bg-[#fc4d50] w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold shadow-[0_0_20px_rgba(252,77,80,0.4)]">B</div>
             </div>
             <div className="hidden md:block">
                <h1 className="text-xl font-bold tracking-tight leading-none text-white">Booth Hunter</h1>
                <p className="text-[10px] text-zinc-400 font-mono tracking-wide mt-0.5">GEMINI 3.0 AGENT</p>
             </div>
          </div>
        </header>

        <main className="flex-grow overflow-y-auto px-4 py-6 scrollbar-thin scrollbar-thumb-zinc-800 scrollbar-track-transparent">
          <div className="max-w-4xl mx-auto flex flex-col justify-end min-h-full pb-4">
            {messages.map((msg) => (
              <ChatMessageBubble key={msg.id} message={msg} />
            ))}

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
                  placeholder="描述你想要的素材 (例如: 适用于巧克力的泳衣)..."
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
      </div>

      {!authLoading && (
        <AuthModal 
          isOpen={isAuthOpen} 
          onClose={() => setIsAuthOpen(false)}
          onLogin={() => setIsAuthOpen(false)}
          canClose={!!user}
        />
      )}

      <Analytics />

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
