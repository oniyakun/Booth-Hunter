import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Search, Image as ImageIcon, Upload, ExternalLink, Loader2, Sparkles, ShoppingBag, X, AlertCircle, Terminal, ChevronDown, ChevronUp, Send, Bot, User, MoveHorizontal, Hammer, LogOut, History, Plus, Menu, UserCircle, Layout, MessageSquare, Trash2, Github, Shield, Users, Pause } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { supabase } from "./supabaseClient";
import { Analytics } from "@vercel/analytics/react";
import FingerprintJS from '@fingerprintjs/fingerprintjs';

function uuidv4(): string {
  // RFC4122 v4, modern browsers
  // @ts-ignore
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- Toast / Notifications (no extra deps) ---

type ToastType = 'success' | 'error' | 'info';

type Toast = {
  id: string;
  type: ToastType;
  title?: string;
  message: string;
  timeoutMs?: number;
};

type ConfirmOptions = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

type UserLimitDraft = {
  session_turn_limit_override: number | null;
  daily_turn_limit_override: number | null;
};

const toastAccent = (t: ToastType) => {
  if (t === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
  if (t === 'error') return 'border-[#ff3d7f]/30 bg-[#ff3d7f]/10 text-[#ffd1e1]';
  return 'border-white/10 bg-white/5 text-zinc-200';
};

const ToastViewport = ({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) => {
  return (
    <div className="fixed right-4 bottom-4 z-[90] w-[calc(100vw-2rem)] max-w-sm space-y-3">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`bh-surface-strong border shadow-2xl rounded-2xl p-4 backdrop-blur-md ${toastAccent(t.type)}`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              {t.type === 'success' ? (
                <Sparkles size={16} />
              ) : t.type === 'error' ? (
                <AlertCircle size={16} />
              ) : (
                <Terminal size={16} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {t.title && <div className="text-sm font-bold text-white truncate">{t.title}</div>}
              <div className="text-sm text-zinc-200 leading-relaxed break-words">{t.message}</div>
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10"
              aria-label="关闭通知"
              title="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

const ModalShell = ({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-md bh-surface-strong rounded-3xl border border-white/10 shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center justify-between">
          <div className="text-white font-bold">{title}</div>
          <button onClick={onClose} className="bh-icon-btn p-2 text-zinc-300 hover:text-white" aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
};

const ConfirmModal = ({
  open,
  options,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  options: ConfirmOptions;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  return (
    <ModalShell open={open} title={options.title} onClose={onCancel}>
      <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{options.message}</div>
      <div className="mt-5 flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl text-sm font-medium bh-btn-secondary text-white"
        >
          {options.cancelText || '取消'}
        </button>
        <button
          onClick={onConfirm}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all ${
            options.destructive ? 'bg-[#ff3d7f] hover:bg-[#ff3d7f]/90' : 'bh-btn-primary'
          }`}
        >
          {options.confirmText || '确定'}
        </button>
      </div>
    </ModalShell>
  );
};

const UserLimitModal = ({
  open,
  emailOrId,
  initial,
  onCancel,
  onSave,
}: {
  open: boolean;
  emailOrId: string;
  initial: UserLimitDraft;
  onCancel: () => void;
  onSave: (draft: UserLimitDraft) => void;
}) => {
  const [sessionStr, setSessionStr] = useState<string>(initial.session_turn_limit_override == null ? '' : String(initial.session_turn_limit_override));
  const [dailyStr, setDailyStr] = useState<string>(initial.daily_turn_limit_override == null ? '' : String(initial.daily_turn_limit_override));

  useEffect(() => {
    if (!open) return;
    setSessionStr(initial.session_turn_limit_override == null ? '' : String(initial.session_turn_limit_override));
    setDailyStr(initial.daily_turn_limit_override == null ? '' : String(initial.daily_turn_limit_override));
  }, [open, initial.session_turn_limit_override, initial.daily_turn_limit_override]);

  const parseOptionalInt = (s: string): number | null => {
    const t = s.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error('请输入数字');
    return Math.trunc(n);
  };

  return (
    <ModalShell open={open} title="设置用户限制" onClose={onCancel}>
      <div className="text-xs text-zinc-400 mb-3">
        目标用户：<span className="text-zinc-200 font-mono">{emailOrId}</span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">单会话对话次数上限</label>
          <input
            value={sessionStr}
            onChange={(e) => setSessionStr(e.target.value)}
            placeholder="留空=默认，0=无限制"
            className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
            inputMode="numeric"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">单日对话次数上限</label>
          <input
            value={dailyStr}
            onChange={(e) => setDailyStr(e.target.value)}
            placeholder="留空=默认，0=无限制"
            className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
        留空表示使用全局默认；0 表示无限制。
      </div>

      <div className="mt-5 flex gap-3">
        <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-sm font-medium bh-btn-secondary text-white">
          取消
        </button>
        <button
          onClick={() => {
            try {
              onSave({
                session_turn_limit_override: parseOptionalInt(sessionStr),
                daily_turn_limit_override: parseOptionalInt(dailyStr),
              });
            } catch (e: any) {
              // 交给外部 toast
              throw e;
            }
          }}
          className="flex-1 py-2.5 rounded-xl text-sm font-bold bh-btn-primary text-white"
        >
          保存
        </button>
      </div>
    </ModalShell>
  );
};

// --- Image Utils ---

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/**
 * 将用户上传的图片：
 * 1) 等比缩放到 1080x1080 以内（不放大，小图保持原尺寸）
 * 2) 统一压缩为 JPG（quality=0.8）
 * 用于减少发送给后端/模型的体积。
 * 注意：PNG 的透明通道会被白底替换；动图（GIF）会只保留第一帧。
 */
async function compressImageFileToJpegDataUrl(
  file: File,
  quality: number = 0.8,
  maxSize: number = 1080
): Promise<string> {
  // Some formats (e.g. SVG) are not safe to draw to canvas across browsers
  if (!file.type.startsWith("image/")) {
    throw new Error("Not an image file");
  }

  // Prefer createImageBitmap for performance; fallback to <img>
  let bitmap: ImageBitmap | null = null;
  let imgEl: HTMLImageElement | null = null;
  let objectUrl: string | null = null;

  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(file);
    } else {
      objectUrl = URL.createObjectURL(file);
      imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Image load failed"));
        el.src = objectUrl!;
      });
    }

    const srcWidth = bitmap ? bitmap.width : (imgEl?.naturalWidth || imgEl?.width || 0);
    const srcHeight = bitmap ? bitmap.height : (imgEl?.naturalHeight || imgEl?.height || 0);
    if (!srcWidth || !srcHeight) throw new Error("Invalid image size");

    const scale = Math.min(1, maxSize / Math.max(srcWidth, srcHeight));
    const width = Math.max(1, Math.round(srcWidth * scale));
    const height = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context not available");

    // Avoid black background when converting from PNG with alpha
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    if (bitmap) ctx.drawImage(bitmap, 0, 0, width, height);
    else if (imgEl) ctx.drawImage(imgEl, 0, 0, width, height);
    else throw new Error("No image source available");

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
        "image/jpeg",
        quality
      );
    });

    return await blobToDataUrl(blob);
  } finally {
    try {
      bitmap?.close();
    } catch {
      // ignore
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function isUserEmailVerified(user: any): boolean {
  // Supabase user object typically provides one of these fields when email is confirmed.
  return Boolean(user?.email_confirmed_at || user?.confirmed_at);
}

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
  status?: string;   // Current system status/progress
  isStreaming?: boolean;
  // 当后端开始输出 ```json 时，前端用它来在卡片区先渲染骨架预览（避免用户看到一大段 JSON）
  isJsonStreaming?: boolean;
  turnMeta?: {
    session_turn_count?: number;
    daily_turn_count?: number;
    session_limit?: number;
    daily_limit?: number;
  };
}

const formatLimit = (n?: number): string => {
  if (n == null) return '—';
  if (n === 0) return '∞';
  return String(n);
};

interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  turn_count?: number;
}

interface Profile {
  id: string;
  email?: string;
  is_admin?: boolean;
  created_at?: string;
  total_turn_count?: number;
  daily_turn_count?: number;
  session_turn_limit_override?: number | null;
  daily_turn_limit_override?: number | null;
}

interface AdminChatMeta {
  id: string;
  user_id: string;
  title: string | null;
  turn_count?: number;
  created_at: string;
  updated_at: string;
}

interface AdminSettings {
  default_session_turn_limit: number;
  default_daily_turn_limit: number;
}

type AdminChatDetail = AdminChatMeta & { messages: Message[] | null };

async function getSupabaseAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function adminFetchJson<T>(path: string): Promise<T> {
  const token = await getSupabaseAccessToken();
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(path, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error || `Request failed: ${res.status}`);
  }
  return data as T;
}

const AdminPanel = ({
  onClose,
  confirm,
  notify,
  editUserLimits,
}: {
  onClose: () => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  notify: (t: Omit<Toast, 'id'>) => void;
  editUserLimits: (u: Profile) => Promise<UserLimitDraft | null>;
}) => {
  const [users, setUsers] = useState<Profile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userDeletingId, setUserDeletingId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [chats, setChats] = useState<AdminChatMeta[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatDeletingId, setChatDeletingId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chatDetail, setChatDetail] = useState<AdminChatDetail | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userQuery, setUserQuery] = useState('');

  // Turn limits
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Admin 详情里需要把历史消息中可能包含的商品卡片渲染出来。
  // - 新版本 messages 里通常会带 items 字段。
  // - 老版本可能把 items 以 ```json [...]``` 的形式嵌在 text 里。
  const extractItemsFromText = (text: string): { cleanText: string; items?: AssetResult[] } => {
    const jsonBlockRegex = /```json\s*(\[[\s\S]*?\])\s*```/i;
    const match = text.match(jsonBlockRegex);
    if (!match) return { cleanText: text };

    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? (parsed as AssetResult[]) : undefined;
      const cleanText = text.replace(jsonBlockRegex, '').trim();
      return { cleanText, items };
    } catch {
      return { cleanText: text };
    }
  };

  const AdminAssetCard = ({ asset }: { asset: AssetResult }) => {
    const [imgError, setImgError] = useState(false);
    const placeholderGradient =
      'linear-gradient(135deg, rgba(252, 77, 80, 0.18), rgba(255, 61, 127, 0.10))';

    return (
      <div className="group relative bh-card overflow-hidden transition-all duration-300 flex flex-col">
        <div className="h-44 w-full relative overflow-hidden bg-zinc-900/60 border-b border-white/5">
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
              style={{ background: placeholderGradient }}
            >
              <ShoppingBag size={34} className="mb-3 text-white/40" />
              <span className="text-xs text-zinc-300 font-medium bh-clamp-3 px-2 leading-relaxed">{asset.title}</span>
            </div>
          )}

          {asset.price && (
            <div className="absolute top-3 right-3 text-white text-xs font-bold px-2.5 py-1 bh-badge">
              {asset.price}
            </div>
          )}
        </div>

        <div className="p-4 flex flex-col flex-grow">
          <h3 className="font-bold text-sm text-white leading-snug bh-clamp-2 group-hover:text-[#fc4d50] transition-colors">
            {asset.title}
          </h3>

          <p className="text-xs text-zinc-400 mt-2 bh-clamp-2 flex-grow leading-relaxed">
            {asset.description || asset.shopName}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {(asset.tags || []).slice(0, 4).map((tag, i) => (
              <span key={i} className="text-[10px] px-2 py-0.5 bh-chip">
                {tag}
              </span>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-[#27272a] flex justify-between items-center">
            <span className="text-[11px] text-zinc-500 truncate max-w-[60%]">{asset.shopName}</span>
            <a
              href={asset.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-bold text-white px-3 py-2 rounded-xl bh-btn-primary"
            >
              详情
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>
    );
  };

  const AdminMessageCard = ({ m, idx }: { m: Message; idx: number }) => {
    const isUser = m.role === 'user';

    // items 优先使用消息对象自带的；否则尝试从 text 的 ```json``` 里解析。
    const { cleanText, items: itemsFromText } = extractItemsFromText(m.text || '');
    const items = (m.items && m.items.length ? m.items : itemsFromText) || [];

    return (
      <div key={m.id || idx} className="bh-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className={`text-xs font-mono ${isUser ? 'text-[#ff3d7f]' : 'text-[#fc4d50]'}`}>
            {m.role}
          </div>
          <div className="text-[10px] text-zinc-500">{m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</div>
        </div>

        {m.image && (
          <img src={m.image} alt="Upload" className="max-h-64 rounded-xl mb-3 border border-zinc-700" />
        )}

        <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words">
          <ReactMarkdown>{cleanText || ''}</ReactMarkdown>
        </div>

        {items.length > 0 && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((asset, i) => (
              <AdminAssetCard key={(asset as any)?.id || i} asset={asset} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const loadUsers = async () => {
    setUsersLoading(true);
    setError(null);
    try {
      const res = await adminFetchJson<{ data: Profile[] }>('/api/admin/users');
      setUsers(res.data || []);
    } catch (e: any) {
      setError(e?.message || '加载用户失败');
      notify({ type: 'error', title: '加载失败', message: e?.message || '加载用户失败' });
    } finally {
      setUsersLoading(false);
    }
  };

  const loadSettings = async () => {
    setError(null);
    try {
      const res = await adminFetchJson<{ data: AdminSettings }>('/api/admin/settings');
      setSettings(res.data);
    } catch (e: any) {
      // Fail-closed: 不影响其它 admin 功能
      console.warn('[Admin] loadSettings failed:', e?.message || e);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    setError(null);
    try {
      const token = await getSupabaseAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          default_session_turn_limit: settings.default_session_turn_limit,
          default_daily_turn_limit: settings.default_daily_turn_limit,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.error || `Request failed: ${res.status}`);
      setSettings((data as any)?.data || settings);
      notify({ type: 'success', title: '已保存', message: '默认限制已更新' });
    } catch (e: any) {
      setError(e?.message || '保存默认限制失败');
      notify({ type: 'error', title: '保存失败', message: e?.message || '保存默认限制失败' });
    } finally {
      setSettingsSaving(false);
    }
  };

  const onClickEditUserLimits = async (u: Profile) => {
    if (!u?.id) return;
    setError(null);
    try {
      const draft = await editUserLimits(u);
      if (!draft) return;

      const token = await getSupabaseAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`/api/admin/users?id=${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(draft),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.error || `Request failed: ${res.status}`);

      const updated = (data as any)?.data as Profile | undefined;
      if (updated?.id) {
        setUsers((prev) => prev.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)));
      } else {
        await loadUsers();
      }

      notify({ type: 'success', title: '已保存', message: '用户限制已更新' });
    } catch (e: any) {
      notify({ type: 'error', title: '设置失败', message: e?.message || '设置用户限制失败' });
      setError(e?.message || '设置用户限制失败');
    }
  };

  const deleteUser = async (userId: string) => {
    if (!userId) return;
    const ok = await confirm({
      title: '删除用户',
      message: '确定要删除该用户吗？\n\n这会同时删除：\n- auth.users\n- profiles\n- 该用户所有 chats\n\n此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      destructive: true,
    });
    if (!ok) return;

    setUserDeletingId(userId);
    setError(null);
    try {
      const token = await getSupabaseAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`/api/admin/users?id=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.error || `Request failed: ${res.status}`);

      // 如果当前正在查看该用户，清空右侧选中状态
      if (selectedUserId === userId) {
        setSelectedUserId(null);
        setSelectedChatId(null);
        setChatDetail(null);
        setChats([]);
      }
      await loadUsers();
      notify({ type: 'success', title: '已删除', message: '用户已删除' });
    } catch (e: any) {
      setError(e?.message || '删除用户失败');
      notify({ type: 'error', title: '删除失败', message: e?.message || '删除用户失败' });
    } finally {
      setUserDeletingId(null);
    }
  };

  const loadChats = async (userId?: string | null) => {
    setChatsLoading(true);
    setError(null);
    setSelectedChatId(null);
    setChatDetail(null);
    try {
      const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
      const res = await adminFetchJson<{ data: AdminChatMeta[] }>(`/api/admin/chats${qs}`);
      setChats(res.data || []);
    } catch (e: any) {
      setError(e?.message || '加载对话列表失败');
      notify({ type: 'error', title: '加载失败', message: e?.message || '加载对话列表失败' });
    } finally {
      setChatsLoading(false);
    }
  };

  const deleteChat = async (chatId: string) => {
    if (!chatId) return;
    const ok = await confirm({
      title: '删除对话',
      message: '确定要删除这条对话吗？\n\n此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      destructive: true,
    });
    if (!ok) return;

    setChatDeletingId(chatId);
    setError(null);
    try {
      const token = await getSupabaseAccessToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`/api/admin/chats?id=${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.error || `Request failed: ${res.status}`);

      // 如果正在查看该对话，清空右侧详情
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
        setChatDetail(null);
      }

      // 从列表里移除（避免一次全量刷新），并保持 UI 响应快
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      notify({ type: 'success', title: '已删除', message: '对话已删除' });
    } catch (e: any) {
      setError(e?.message || '删除对话失败');
      notify({ type: 'error', title: '删除失败', message: e?.message || '删除对话失败' });
    } finally {
      setChatDeletingId(null);
    }
  };

  const loadChatDetail = async (chatId: string) => {
    setChatLoading(true);
    setError(null);
    try {
      const res = await adminFetchJson<{ data: AdminChatDetail | null }>(
        `/api/admin/chats?id=${encodeURIComponent(chatId)}`
      );
      setChatDetail(res.data);
    } catch (e: any) {
      setError(e?.message || '加载对话详情失败');
      notify({ type: 'error', title: '加载失败', message: e?.message || '加载对话详情失败' });
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    // 默认只加载用户列表；避免管理员打开面板时立刻拉取“全站所有对话”。
    // 需要查看对话时，让管理员主动点击“全部对话”或选择某个用户。
    loadUsers();
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredUsers = users.filter((u) => {
    if (!userQuery.trim()) return true;
    const q = userQuery.trim().toLowerCase();
    return (u.email || '').toLowerCase().includes(q) || u.id.toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-md">
      <div className="absolute inset-3 md:inset-6 bh-surface-strong rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
        <div className="h-[72px] px-4 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl flex items-center justify-center bh-btn-primary">
              <Shield size={18} />
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-white font-bold">管理员面板</span>
              <span className="text-[10px] text-zinc-400 font-mono tracking-wide mt-0.5">Admin Console</span>
            </div>
          </div>

          <button onClick={onClose} className="bh-icon-btn p-2 text-zinc-300 hover:text-white" aria-label="关闭管理员面板">
            <X size={20} />
          </button>
        </div>

        <div className="h-[calc(100%-72px)] grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          {/* Left: Users */}
          <aside className="border-b lg:border-b-0 lg:border-r border-white/5 overflow-hidden flex flex-col">
            <div className="p-4 border-b border-white/5">
              <div className="flex items-center gap-2 text-white font-bold mb-3">
                <Users size={16} className="text-[#ff3d7f]" />
                <span>用户列表</span>
              </div>
              <input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="搜索 email / user_id"
                className="w-full rounded-xl px-4 py-2.5 text-white focus:outline-none bh-input"
              />

              {/* Default limits */}
              <div className="mt-3 p-3 rounded-2xl border border-white/5 bg-white/5">
                <div className="text-[11px] text-zinc-400 font-mono mb-2">默认限制</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={settings?.default_session_turn_limit ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSettings((s) => ({
                        default_session_turn_limit: v === '' ? 0 : Number(v),
                        default_daily_turn_limit: s?.default_daily_turn_limit ?? 0,
                      }));
                    }}
                    placeholder="单会话"
                    className="w-full rounded-xl px-3 py-2 text-white focus:outline-none bh-input text-sm"
                    inputMode="numeric"
                  />
                  <input
                    value={settings?.default_daily_turn_limit ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSettings((s) => ({
                        default_session_turn_limit: s?.default_session_turn_limit ?? 0,
                        default_daily_turn_limit: v === '' ? 0 : Number(v),
                      }));
                    }}
                    placeholder="今日次数"
                    className="w-full rounded-xl px-3 py-2 text-white focus:outline-none bh-input text-sm"
                    inputMode="numeric"
                  />
                </div>
                <button
                  onClick={saveSettings}
                  disabled={settingsSaving || !settings}
                  className="mt-2 w-full py-2 rounded-xl text-sm font-medium bh-btn-secondary text-white disabled:opacity-50"
                >
                  {settingsSaving ? '保存中...' : '保存默认限制'}
                </button>
                <div className="mt-2 text-[10px] text-zinc-500 leading-relaxed">
                  0 表示无限制；留空将被视为 0。
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => loadChats(null)}
                  className="flex-1 py-2 rounded-xl text-sm font-medium bh-btn-secondary text-white"
                >
                  全部对话
                </button>
                <button
                  onClick={loadUsers}
                  className="py-2 px-3 rounded-xl text-sm font-medium bh-btn-secondary text-white"
                  title="刷新用户"
                >
                  刷新
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {usersLoading ? (
                Array.from({ length: 8 }).map((_, i) => <div key={i} className="bh-skeleton" style={{ height: 54 }} />)
              ) : filteredUsers.length === 0 ? (
                <div className="text-sm text-zinc-500 text-center py-10">暂无用户</div>
              ) : (
                filteredUsers.map((u) => (
                  <div
                    key={u.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedUserId(u.id);
                      loadChats(u.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedUserId(u.id);
                        loadChats(u.id);
                      }
                    }}
                    className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer outline-none focus:ring-2 focus:ring-[#fc4d50]/30 ${
                      selectedUserId === u.id
                        ? 'border-[#fc4d50]/25 bg-[#fc4d50]/10'
                        : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white font-medium truncate">{u.email || u.id}</div>
                        <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">{u.id}</div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          今日对话次数：<span className="text-zinc-300">{u.daily_turn_count ?? 0}</span>
                          <span className="mx-2 text-zinc-600">|</span>
                          历史总数：<span className="text-zinc-300">{u.total_turn_count ?? 0}</span>
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          覆盖限制：
                          <span className="text-zinc-300">
                            会话 {u.session_turn_limit_override ?? '默认'} / 今日 {u.daily_turn_limit_override ?? '默认'}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onClickEditUserLimits(u);
                          }}
                          className="p-2 rounded-xl bh-btn-secondary text-zinc-200 hover:text-white"
                          title="设置该用户限制"
                          aria-label="设置该用户限制"
                        >
                          <Terminal size={16} />
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteUser(u.id);
                          }}
                          disabled={!!userDeletingId}
                          className="p-2 rounded-xl bh-btn-secondary text-zinc-200 hover:text-white disabled:opacity-50"
                          title="删除用户"
                          aria-label="删除用户"
                        >
                          {userDeletingId === u.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </div>
                    {u.is_admin && (
                      <div className="mt-2 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg bg-[#ff3d7f]/10 border border-[#ff3d7f]/20 text-[#ff3d7f]">
                        <Shield size={12} />
                        管理员
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </aside>

          {/* Right: Chats + Detail */}
          <section className="overflow-hidden flex flex-col">
            <div className="p-4 border-b border-white/5 flex items-center justify-between">
              <div className="text-white font-bold">对话列表</div>
              <button
                onClick={() => loadChats(selectedUserId)}
                className="py-2 px-3 rounded-xl text-sm font-medium bh-btn-secondary text-white"
              >
                刷新
              </button>
            </div>

            {error && (
              <div className="p-4">
                <div className="p-3 bg-[#ff3d7f]/10 border border-[#ff3d7f]/25 rounded-xl text-[#ffd1e1] text-sm">
                  {error}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-hidden grid grid-cols-1 xl:grid-cols-[420px_1fr]">
              {/* Chat list */}
              <div className="border-b xl:border-b-0 xl:border-r border-white/5 overflow-y-auto p-3 space-y-2">
                {chatsLoading ? (
                  Array.from({ length: 10 }).map((_, i) => <div key={i} className="bh-skeleton" style={{ height: 64 }} />)
                ) : chats.length === 0 ? (
                  <div className="text-sm text-zinc-500 text-center py-10">暂无对话</div>
                ) : (
                  chats.map((c) => (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedChatId(c.id);
                        loadChatDetail(c.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedChatId(c.id);
                          loadChatDetail(c.id);
                        }
                      }}
                      className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer outline-none focus:ring-2 focus:ring-[#fc4d50]/30 ${
                        selectedChatId === c.id
                          ? 'border-[#fc4d50]/25 bg-[#fc4d50]/10'
                          : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm text-white font-medium truncate min-w-0 flex-1">
                          {c.title || '未命名对话'}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteChat(c.id);
                          }}
                          disabled={!!chatDeletingId}
                          className="p-2 rounded-xl bh-btn-secondary text-zinc-200 hover:text-white disabled:opacity-50"
                          title="删除对话"
                          aria-label="删除对话"
                        >
                          {chatDeletingId === c.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">chat: {c.id}</div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">user: {c.user_id}</div>
                      <div className="text-[10px] text-zinc-500 mt-1">对话次数：{c.turn_count ?? 0}</div>
                      <div className="text-[10px] text-zinc-600 mt-1">{new Date(c.created_at).toLocaleString()}</div>
                    </div>
                  ))
                )}
              </div>

              {/* Chat detail */}
              <div className="overflow-y-auto p-4">
                {!selectedChatId ? (
                  <div className="text-zinc-500 text-sm text-center py-16">选择一条对话查看内容</div>
                ) : chatLoading ? (
                  <div className="space-y-3">
                    <div className="bh-skeleton" style={{ height: 18, width: '60%' }} />
                    <div className="bh-skeleton" style={{ height: 120 }} />
                    <div className="bh-skeleton" style={{ height: 120 }} />
                  </div>
                ) : !chatDetail ? (
                  <div className="text-zinc-500 text-sm text-center py-16">未找到对话</div>
                ) : (
                  <div>
                    <div className="mb-4">
                      <div className="text-white font-bold text-lg truncate">{chatDetail.title || '未命名对话'}</div>
                      <div className="text-[11px] text-zinc-500 font-mono mt-1">chat: {chatDetail.id}</div>
                      <div className="text-[11px] text-zinc-500 font-mono mt-1">user: {chatDetail.user_id}</div>
                      <div className="text-[11px] text-zinc-500 font-mono mt-1">turn_count: {chatDetail.turn_count ?? 0}</div>
                    </div>

                    <div className="space-y-4">
                      {(chatDetail.messages || []).map((m, idx) => (
                        <AdminMessageCard key={m.id || idx} m={m} idx={idx} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

// --- Animation helpers ---
const usePrefersReducedMotion = () => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;

    const onChange = () => setReduced(!!mq.matches);
    onChange();

    // Safari / older browsers fallback
    if (typeof (mq as any).addEventListener === 'function') {
      (mq as any).addEventListener('change', onChange);
      return () => (mq as any).removeEventListener('change', onChange);
    }

    (mq as any).addListener?.(onChange);
    return () => (mq as any).removeListener?.(onChange);
  }, []);

  return reduced;
};

const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;

    const onChange = () => setMatches(!!mq.matches);
    onChange();

    // Safari / older browsers fallback
    if (typeof (mq as any).addEventListener === 'function') {
      (mq as any).addEventListener('change', onChange);
      return () => (mq as any).removeEventListener('change', onChange);
    }

    (mq as any).addListener?.(onChange);
    return () => (mq as any).removeListener?.(onChange);
  }, [query]);

  return matches;
};

const getStaggerStyle = (index: number, enabled: boolean, baseMs: number = 40, maxMs: number = 320) => {
  if (!enabled) return undefined;
  const delay = Math.min(index * baseMs, maxMs);
  return { animationDelay: `${delay}ms` } as React.CSSProperties;
};

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'booth_hunter_sidebar_collapsed';

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
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // 需要在 Supabase Auth 配置里把该 URL 加到 Redirect URLs 白名单
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) throw error;

        // 注意：为了防止“枚举邮箱”，Supabase 在邮箱已存在时也可能返回成功。
        // 经验规则：当该邮箱已存在时，data.user.identities 往往为空数组。
        const identities = (data as any)?.user?.identities;
        const isExistingAccount = Array.isArray(identities) && identities.length === 0;
        if (isExistingAccount) {
          setError("该邮箱已注册，请直接登录。如果你还没验证邮箱：登录后会看到验证提示，可重新发送验证邮件。");
        } else {
          setError("注册成功！请前往邮箱点击验证链接完成验证，然后再回来登录。");
        }
        setIsLogin(true);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="w-full max-w-md p-6 relative bh-surface-strong rounded-3xl bh-anim-pop">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">{isLogin ? "登录" : "注册"}</h2>
          {canClose && (
            <button onClick={onClose} className="text-zinc-400 hover:text-white bh-icon-btn p-2" aria-label="关闭登录弹窗">
              <X size={20} />
            </button>
          )}
        </div>
        
        {!canClose && (
          <div className="mb-6 text-sm text-zinc-400 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/50">
            欢迎！请先登录或注册以继续使用 Booth Hunter。
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-[#fc4d50]/10 border border-[#fc4d50]/25 rounded-lg text-[#ffd1e1] text-sm flex items-start gap-2">
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
              className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full text-white font-bold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed bh-btn-primary"
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
  sessionsLoading,
  collapsed,
  currentSessionId, 
  onSelectSession, 
  onNewChat,
  onOpenAuth,
  onDeleteSession,
  totalTurnCount,
  totalTurnLimit,
  reducedMotion
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  user: any; 
  sessions: ChatSession[]; 
  sessionsLoading: boolean;
  collapsed: boolean;
  currentSessionId: string | null; 
  onSelectSession: (id: string) => void | Promise<void>; 
  onNewChat: () => void;
  onOpenAuth: () => void;
  onDeleteSession: (id: string) => void;
  totalTurnCount?: number;
  totalTurnLimit?: number;
  reducedMotion: boolean;
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
      
      <div
        className={`fixed inset-y-0 left-0 z-40 transform ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } transition-transform duration-300 ease-in-out md:translate-x-0 md:static ${
          collapsed ? 'md:w-20' : 'md:w-80'
        } md:transition-[width] md:duration-300 md:ease-in-out overflow-hidden`}
      >
        <div className="h-full bh-surface-strong border-r border-white/5">
        <div className="flex flex-col h-full">
          <div className={`px-4 h-[72px] border-b border-white/5 flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
            <div className={`flex items-center text-white font-bold ${collapsed ? 'justify-center' : 'gap-3'}`}>
              <div className="w-9 h-9 rounded-2xl flex items-center justify-center text-white text-sm bh-btn-primary">B</div>
              {!collapsed && (
                <div className="flex flex-col leading-none">
                  <span>Booth Hunter</span>
                </div>
              )}
            </div>
            <button onClick={onClose} className="md:hidden text-zinc-400">
              <X size={20} />
            </button>
          </div>

          <div className="p-4">
            <button
              onClick={() => { onNewChat(); if(window.innerWidth < 768) onClose(); }}
              className={`w-full text-white flex items-center ${collapsed ? 'justify-center h-11 px-0' : 'gap-2 px-4 py-3'} rounded-2xl transition-all font-medium bh-btn-secondary`}
              aria-label="新对话"
              title="新对话"
            >
              <Plus size={18} />
              {!collapsed && <span>新对话</span>}
            </button>
          </div>

          <div className={`flex-grow overflow-y-auto ${collapsed ? 'px-2' : 'px-4'} space-y-1`}>
            {!collapsed && (
              <h3 className="px-4 text-[10px] font-bold text-zinc-500 uppercase tracking-[0.2em] mb-4 mt-6">历史记录</h3>
            )}
            {!user ? (
               <div className="px-4 text-sm text-zinc-500 py-4 text-center italic">
                 登录后可保存和查看历史记录
               </div>
            ) : sessionsLoading ? (
               <div className={`${collapsed ? 'px-0' : 'px-4'} space-y-2 pb-4`}>
                 {Array.from({ length: 6 }).map((_, i) => (
                   <div key={i} className="bh-skeleton" style={{ height: 44 }} />
                 ))}
               </div>
            ) : sessions.length === 0 ? (
               <div className="px-4 text-sm text-zinc-500 py-4 text-center italic">
                 暂无历史记录
               </div>
            ) : (
              sessions.map((session, i) => (
                <div
                  key={session.id}
                  className={`group flex items-center gap-1 w-full ${reducedMotion ? '' : 'bh-anim-fade-left'}`}
                  style={getStaggerStyle(i, !reducedMotion, 28, 220)}
                >
                  <button
                    onClick={() => { onSelectSession(session.id); if(window.innerWidth < 768) onClose(); }}
                    title={session.title || "未命名对话"}
                    className={`flex-grow ${collapsed ? 'h-11 px-0 justify-center text-center' : 'px-4 py-3 text-left'} rounded-2xl text-sm flex items-center ${collapsed ? '' : 'gap-3'} transition-all ${
                      currentSessionId === session.id 
                        ? "bg-[#fc4d50]/10 text-[#fc4d50] border border-[#fc4d50]/20" 
                        : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                    }`}
                  >
                    <MessageSquare size={16} className="flex-shrink-0" />
                    {!collapsed && (
                      <span className="truncate text-left">
                        {session.title?.slice(0, 15) || "未命名对话"}
                        {(session.title?.length || 0) > 10 ? "..." : ""}
                      </span>
                    )}
                  </button>
                  {!collapsed && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                      className="p-2 text-zinc-600 hover:text-[#ff3d7f] hover:bg-zinc-800 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                      title="删除对话"
                      aria-label="删除对话"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="p-4 border-t border-zinc-800">
            {user ? (
              collapsed ? (
                <div className="flex items-center justify-center">
                  <div className="w-11 h-11 rounded-2xl bg-white/10 flex items-center justify-center text-zinc-300">
                    <UserCircle size={20} />
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-2 overflow-hidden">
                      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-400">
                        <UserCircle size={20} />
                      </div>
                      <div className="flex flex-col truncate">
                        <span className="text-sm text-white truncate font-medium">{user.email?.split('@')[0]}</span>
                        <span className="text-[10px] text-zinc-500 truncate">{user.email}</span>
                        <span className="text-[10px] text-zinc-600 truncate mt-0.5">
                          今日对话次数 {totalTurnCount ?? '—'} / {formatLimit(totalTurnLimit)}
                        </span>
                      </div>
                   </div>
                   <button 
                    onClick={async () => { await supabase.auth.signOut(); }}
                    className="text-zinc-500 hover:text-white p-2"
                    title="退出登录"
                    aria-label="退出登录"
                   >
                     <LogOut size={18} />
                   </button>
                </div>
              )
            ) : (
              <div className="flex flex-col gap-3">
                <button
                  onClick={onOpenAuth}
                  className={`w-full flex items-center justify-center ${collapsed ? '' : 'gap-2'} text-zinc-300 hover:text-white py-2 rounded-lg hover:bg-zinc-800 transition-colors text-sm font-medium`}
                  aria-label="登录 / 注册"
                >
                  <UserCircle size={18} />
                  {!collapsed && <span>登录 / 注册</span>}
                </button>
              </div>
            )}
          </div>
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
      className="mt-6 w-full overflow-x-auto pb-6 flex gap-5 cursor-grab"
      onMouseDown={onMouseDown}
      onMouseLeave={onMouseLeave}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
    >
      {children}
    </div>
  );
});

const AssetCard = React.memo(({
  asset,
  className,
  maxTags = 3,
  imageHeightClassName,
}: {
  asset: AssetResult;
  className?: string;
  maxTags?: number;
  imageHeightClassName?: string;
}) => {
  const [imgError, setImgError] = useState(false);

  // Strict black + pink theme: avoid dynamic multi-color gradients.
  const placeholderGradient =
    "linear-gradient(135deg, rgba(252, 77, 80, 0.18), rgba(255, 61, 127, 0.10))";

  return (
    <div className={`group relative bh-card overflow-hidden transition-all duration-300 flex flex-col ${className ?? 'w-[300px] flex-shrink-0'}`}>
      <div className={`${imageHeightClassName ?? 'h-56'} w-full relative overflow-hidden bg-zinc-900/60 border-b border-white/5`}>
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
            style={{ background: placeholderGradient }}
          >
            <ShoppingBag size={40} className="mb-4 text-white/40" />
            <span className="text-sm text-zinc-300 font-medium bh-clamp-3 px-4 leading-relaxed">{asset.title}</span>
          </div>
        )}
        <div className="absolute top-3 right-3 text-white text-sm font-bold px-2.5 py-1 bh-badge">
          {asset.price}
        </div>
      </div>

      <div className="p-5 flex flex-col flex-grow">
        <div className="flex justify-between items-start mb-3 min-h-[3rem]">
          <h3 className="font-bold text-base text-white leading-snug bh-clamp-2 group-hover:text-[#fc4d50] transition-colors">
            {asset.title}
          </h3>
        </div>
        
        <p className="text-sm text-zinc-400 mb-4 bh-clamp-2 flex-grow leading-relaxed">
          {asset.description || asset.shopName}
        </p>

        <div className="flex flex-wrap gap-2 mb-4 h-6 overflow-hidden">
          {asset.tags && asset.tags.slice(0, maxTags).map((tag, i) => (
            <span key={i} className="text-[10px] px-2 py-0.5 bh-chip">
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
              className="flex items-center gap-1.5 text-xs font-bold text-white px-4 py-2 rounded-xl bh-btn-primary"
            >
              详情
              <ExternalLink size={12} />
            </a>
        </div>
      </div>
    </div>
  );
});

const AssetCardSkeleton = React.memo(({
  className,
  imageHeightClassName,
}: {
  className?: string;
  imageHeightClassName?: string;
}) => {
  return (
    <div className={`bh-card overflow-hidden flex flex-col ${className ?? 'w-[300px] flex-shrink-0'}`}>
      <div className={`${imageHeightClassName ?? 'h-56'} w-full bh-skeleton`} />
      <div className="p-5 space-y-3">
        <div className="bh-skeleton" style={{ height: 16, width: '86%', borderRadius: 10 }} />
        <div className="bh-skeleton" style={{ height: 12, width: '70%', borderRadius: 10 }} />
        <div className="flex gap-2">
          <div className="bh-skeleton" style={{ height: 14, width: 56, borderRadius: 999 }} />
          <div className="bh-skeleton" style={{ height: 14, width: 44, borderRadius: 999 }} />
          <div className="bh-skeleton" style={{ height: 14, width: 64, borderRadius: 999 }} />
        </div>
        <div className="bh-skeleton" style={{ height: 34, width: '100%', borderRadius: 14 }} />
      </div>
    </div>
  );
});

const ChatMessageBubble = React.memo(({ message, largeLayout }: { message: Message; largeLayout: boolean }) => {
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
          <div className={`w-9 h-9 rounded-2xl flex items-center justify-center shadow-lg border border-white/5 ${isUser ? 'bg-white/10' : 'bh-avatar-accent'}`}>
            {isUser ? <User size={18} /> : <Bot size={18} />}
          </div>
          <span className="text-sm font-medium text-zinc-400">{isUser ? "你" : "璃璃"}</span>
        </div>

        {/* Bubble Content with Markdown */}
        <div className={`px-6 py-4 rounded-3xl shadow-md ${
          isUser 
            ? 'text-zinc-100 rounded-tr-sm bh-bubble-user' 
            : 'text-zinc-200 rounded-tl-sm bh-bubble-model'
        }`}>
          {message.image && (
            <img src={message.image} alt="Upload" className="max-h-64 rounded-xl mb-4 border border-zinc-700" />
          )}
          
          {/* Tool Call Indicator */}
          {message.toolCall && (
            <div className={`mb-3 flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-lg border transition-all duration-300 ${
              message.toolCall.includes("重试") 
                ? "text-[#ff3d7f] bg-[#ff3d7f]/10 border-[#ff3d7f]/25 animate-pulse" 
                : "text-[#fc4d50]/90 bg-[#fc4d50]/10 border-[#fc4d50]/20"
            }`}>
              <Hammer size={12} className={message.toolCall.includes("重试") ? "animate-spin" : ""} />
              <span>调用工具: {message.toolCall}</span>
            </div>
          )}

          {/* System Status Indicator */}
          {message.status && (
            <div className="mb-4 flex items-center gap-3 py-2 px-4 rounded-xl bh-surface bh-anim-fade-left">
               <div className="relative">
                  <div className="w-2 h-2 bg-[#fc4d50] rounded-full animate-ping absolute inset-0"></div>
                  <div className="w-2 h-2 bg-[#fc4d50] rounded-full relative"></div>
               </div>
               <span className="text-xs font-medium text-zinc-400 tracking-wide uppercase italic">{message.status}</span>
               <Loader2 size={12} className="animate-spin text-zinc-600 ml-auto" />
            </div>
          )}

          {/* Markdown Rendering */}
          <div className="markdown-body text-base leading-relaxed">
            <ReactMarkdown>
                {displayText}
            </ReactMarkdown>
            {message.isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-[#fc4d50] animate-pulse align-middle rounded-sm"></span>}
          </div>

          {/* Subtle turn meta for assistant replies */}
          {!isUser && message.turnMeta && (
            <div className="mt-3 text-[11px] text-zinc-500 font-mono opacity-70 select-none">
              本会话 {message.turnMeta.session_turn_count ?? '—'}/{formatLimit(message.turnMeta.session_limit)}
            </div>
          )}
        </div>

        {/* Asset Cards Grid */}
        {message.items && message.items.length > 0 && (
          <div className="w-full mt-6 pl-2">
            {largeLayout ? (
              // 大屏：最多展示 3 行卡片，剩余内容在该区域内纵向滚动查看
              <div className="max-h-[1000px] overflow-y-auto pr-2">
                <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                  {message.items.map((item, idx) => (
                    <AssetCard
                      key={item.id || idx}
                      asset={item}
                      className="w-full h-[450px]"
                      imageHeightClassName="h-[300px]"
                      maxTags={5}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <>
                <DraggableContainer>
                  {message.items.map((item, idx) => (
                    <AssetCard key={item.id || idx} asset={item} />
                  ))}
                </DraggableContainer>
                <div className="flex items-center justify-center gap-2 text-xs text-zinc-600 mt-3 opacity-60 font-medium">
                  <MoveHorizontal size={12} />
                  <span>按住卡片左右拖动查看更多</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Skeleton preview while streaming JSON */}
        {(!message.items || message.items.length === 0) && message.isStreaming && message.isJsonStreaming && (
          <div className="w-full mt-6 pl-2">
            {largeLayout ? (
              <div className="max-h-[1300px] overflow-y-auto pr-2">
                <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <AssetCardSkeleton
                      key={i}
                      className="w-full h-[420px]"
                      imageHeightClassName="h-[280px]"
                    />
                  ))}
                </div>
              </div>
            ) : (
              <DraggableContainer>
                {Array.from({ length: 6 }).map((_, i) => (
                  <AssetCardSkeleton key={i} />
                ))}
              </DraggableContainer>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

const MessageSkeletonList = ({ count = 6 }: { count?: number }) => {
  return (
    <div className="w-full space-y-6">
      {Array.from({ length: count }).map((_, i) => {
        const isUser = i % 2 === 0;
        return (
          <div key={i} className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[95%] md:max-w-[85%] w-full">
              <div className={`flex items-center gap-3 mb-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className="bh-skeleton" style={{ width: 36, height: 36, borderRadius: 16 }} />
                <div className="bh-skeleton" style={{ width: 120, height: 12, borderRadius: 999 }} />
              </div>
              <div
                className="bh-skeleton bh-skeleton-bubble"
                style={{ height: 74, width: isUser ? '88%' : '92%', marginLeft: isUser ? 'auto' : undefined }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

const App = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [canStop, setCanStop] = useState(false);
  const [processingTool, setProcessingTool] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const largeLayout = useMediaQuery('(min-width: 1024px)');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionMessagesLoading, setSessionMessagesLoading] = useState(false);
  const [messageAnimationNonce, setMessageAnimationNonce] = useState(0);
  const [visitorId, setVisitorId] = useState<string | null>(null);

  useEffect(() => {
    const setFp = async () => {
      try {
        const fp = await FingerprintJS.load();
        const { visitorId } = await fp.get();
        setVisitorId(visitorId);
      } catch (e) {
        console.error('Fingerprint failed:', e);
      }
    };
    setFp();
  }, []);

  // Desktop sidebar collapse state (persisted)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  
  // Auth & Session State
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);

  // Latest turn meta (for sidebar display)
  const [dailyTurnCount, setDailyTurnCount] = useState<number | undefined>(undefined);
  const [dailyTurnLimit, setDailyTurnLimit] = useState<number | undefined>(undefined);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pushToast = (t: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toast: Toast = { id, timeoutMs: 4200, ...t };
    setToasts((prev) => [toast, ...prev].slice(0, 4));
    const ms = toast.timeoutMs ?? 4200;
    if (ms > 0) {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, ms);
    }
  };
  const dismissToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  // Confirm modal (async)
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions>({
    title: '确认',
    message: '',
    confirmText: '确定',
    cancelText: '取消',
  });
  const confirmResolverRef = useRef<((v: boolean) => void) | null>(null);
  const confirmAsync = (opts: ConfirmOptions): Promise<boolean> => {
    setConfirmOptions(opts);
    setConfirmOpen(true);
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
    });
  };
  const closeConfirm = (v: boolean) => {
    setConfirmOpen(false);
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    r?.(v);
  };

  // User limit modal (async)
  const [limitModalOpen, setLimitModalOpen] = useState(false);
  const [limitModalUser, setLimitModalUser] = useState<Profile | null>(null);
  const [limitModalDraft, setLimitModalDraft] = useState<UserLimitDraft>({
    session_turn_limit_override: null,
    daily_turn_limit_override: null,
  });
  const limitResolverRef = useRef<((v: UserLimitDraft | null) => void) | null>(null);
  const editUserLimitsAsync = (u: Profile): Promise<UserLimitDraft | null> => {
    setLimitModalUser(u);
    setLimitModalDraft({
      session_turn_limit_override: u.session_turn_limit_override ?? null,
      daily_turn_limit_override: u.daily_turn_limit_override ?? null,
    });
    setLimitModalOpen(true);
    return new Promise<UserLimitDraft | null>((resolve) => {
      limitResolverRef.current = resolve;
    });
  };
  const closeLimitModal = (v: UserLimitDraft | null) => {
    setLimitModalOpen(false);
    const r = limitResolverRef.current;
    limitResolverRef.current = null;
    r?.(v);
  };

  const emailVerified = !!(user && isUserEmailVerified(user));
  // 允许：已验证用户 OR (游客 AND 拿到了指纹)
  const canUseApp = (!!user && emailVerified) || (!user && !!visitorId);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const isAtBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionMessagesCacheRef = useRef<Record<string, Message[]>>({});
  const sessionMessagesInFlightRef = useRef<Record<string, Promise<Message[]>>>({});

  // 用于“停止生成”：Abort 当前 /api/chat 的 fetch 流式请求
  const chatAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  const parseTurnMetaFromHeaders = (headers: Headers): Message['turnMeta'] => {
    const toNum = (v: string | null): number | undefined => {
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      session_turn_count: toNum(headers.get('x-session-turn-count')),
      daily_turn_count: toNum(headers.get('x-daily-turn-count')),
      session_limit: toNum(headers.get('x-session-limit')),
      daily_limit: toNum(headers.get('x-daily-limit')),
    };
  };

  const applyTurnMetaToSidebar = (meta?: Message['turnMeta']) => {
    if (!meta) return;
    // 优先使用每日限制（已登录）
    if (typeof meta.daily_turn_count === 'number') {
      setDailyTurnCount(meta.daily_turn_count);
      if (typeof meta.daily_limit === 'number') setDailyTurnLimit(meta.daily_limit);
    } 
    // 游客模式借用了 session 字段
    else if (typeof meta.session_turn_count === 'number') {
      setDailyTurnCount(meta.session_turn_count);
      if (typeof meta.session_limit === 'number') setDailyTurnLimit(meta.session_limit);
    }
  };

  const updateIsAtBottom = () => {
    const el = scrollContainerRef.current;
    if (!el) return;

    // Treat near-bottom as bottom to avoid 1-2px rounding issues
    const thresholdPx = 48;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdPx;
    isAtBottomRef.current = atBottom;
  };

  // --- Auth & DB Effects ---

  useEffect(() => {
    // Handle possible redirect from Supabase email verification / OAuth (PKCE)
    // If URL contains ?code=..., exchange it for a session.
    const url = new URL(window.location.href);
    if (url.searchParams.get("code")) {
      supabase.auth.exchangeCodeForSession(window.location.href)
        .then(() => {
          // remove code from URL for cleanliness
          url.searchParams.delete("code");
          window.history.replaceState({}, document.title, url.toString());
        })
        .catch((e) => console.warn("[Auth] exchangeCodeForSession failed:", e));
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user && isUserEmailVerified(session.user)) {
        setIsAuthOpen(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
      if (session?.user && isUserEmailVerified(session.user)) {
        setIsAuthOpen(false);
      } else {
        setSessions([]);
        setCurrentSessionId(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Determine admin role from profiles.is_admin (if the table/policies exist).
    // Fail-closed: any error => not admin.
    let cancelled = false;

    const run = async () => {
      try {
        if (!user || !isUserEmailVerified(user)) {
          if (!cancelled) setIsAdmin(false);
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .maybeSingle();

        if (cancelled) return;
        if (error) {
          setIsAdmin(false);
          return;
        }
        setIsAdmin(!!(data as any)?.is_admin);
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.email_confirmed_at, user?.confirmed_at]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      if (raw === '1' || raw === 'true') setSidebarCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [sidebarCollapsed]);

  const fetchSessions = async (targetUser?: any) => {
    const u = targetUser ?? user;
    if (!u || !isUserEmailVerified(u)) return;

    setSessionsLoading(true);
    try {
      const { data, error } = await supabase
        .from('chats')
        // 仅加载列表元信息，避免首次进入就拉取所有对话 messages
        .select('id, title, created_at, turn_count')
        // 关键：无论是否管理员账号，常规侧边栏历史记录都只显示自己的对话
        .eq('user_id', u.id)
        .order('created_at', { ascending: false });
      
      if (error) {
        console.error('Error fetching chats:', error);
      } else {
        setSessions((data as any[]) || []);
      }
    } finally {
      setSessionsLoading(false);
    }
  };

  const saveCurrentSession = async (newMessages: Message[], forceSessionId?: string) => {
    if (!user || !isUserEmailVerified(user)) return;
    
    // Determine title from first user message
    const firstUserMsg = newMessages.find(m => m.role === 'user');
    const title = firstUserMsg ? (firstUserMsg.text.slice(0, 20) + (firstUserMsg.text.length > 20 ? '...' : '')) : 'New Chat';

    try {
      // 采用 upsert：确保新会话在第一次发送前就能稳定拥有 chat_id（便于轮数统计）
      const sessionId = forceSessionId || currentSessionId || uuidv4();

      await supabase
        .from('chats')
        .upsert({
          id: sessionId,
          user_id: user.id,
          title,
          messages: newMessages,
          updated_at: new Date().toISOString(),
        });

      if (!currentSessionId) {
        setCurrentSessionId(sessionId);
      }
        
      // Update local list (metadata only)
      setSessions(prev => {
        const exists = prev.some(s => s.id === sessionId);
        if (exists) return prev.map(s => s.id === sessionId ? { ...s, title } : s);
        return [{ id: sessionId, title, created_at: new Date().toISOString(), turn_count: 0 }, ...prev];
      });

      // Keep cache in sync for the currently-open session
      sessionMessagesCacheRef.current[sessionId] = newMessages;
    } catch (e) {
      console.error("Save error:", e);
    }
  };

  const handleSelectSession = async (id: string) => {
    if (!user || !isUserEmailVerified(user)) return;
    setCurrentSessionId(id);

    // Show a smooth loading state + skeleton while switching sessions
    setSessionMessagesLoading(true);

    // Cache hit: don't request again
    const cached = sessionMessagesCacheRef.current[id];
    if (cached) {
      setMessages(cached);
      setMessageAnimationNonce((n) => n + 1);
      setSessionMessagesLoading(false);
      return;
    }

    // In-flight de-duplication
    if (!sessionMessagesInFlightRef.current[id]) {
      sessionMessagesInFlightRef.current[id] = (async () => {
        const { data, error } = await supabase
          .from('chats')
          .select('messages')
          .eq('id', id)
          // 防御性过滤：常规读取只允许读取自己的会话
          .eq('user_id', user.id)
          .single();

        if (error) {
          throw error;
        }

        const msgs = (((data as any)?.messages as Message[]) || []);
        sessionMessagesCacheRef.current[id] = msgs;
        return msgs;
      })().finally(() => {
        delete sessionMessagesInFlightRef.current[id];
      });
    }

    try {
      const msgs = await sessionMessagesInFlightRef.current[id];
      // If user switched quickly, ensure we only apply to currently selected session
      setMessages(msgs);
      setMessageAnimationNonce((n) => n + 1);
    } catch (e: any) {
      console.error('Error fetching chat messages:', e);
      pushToast({ type: 'error', title: '加载失败', message: '加载对话失败，请稍后重试' });
    } finally {
      setSessionMessagesLoading(false);
    }
  };

  const handleNewChat = () => {
    // 新会话预先生成 chat_id，保证从第一轮开始就能计数
    setCurrentSessionId(uuidv4());
    initChat(false);
    setMessageAnimationNonce((n) => n + 1);
  };

  const handleDeleteSession = async (id: string) => {
    if (!user || !isUserEmailVerified(user)) return;
    const ok = await confirmAsync({
      title: '删除对话记录',
      message: '确定要删除这条对话记录吗？\n\n此操作不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      destructive: true,
    });
    if (!ok) return;

    try {
      const { error } = await supabase
        .from('chats')
        .delete()
        .eq('id', id)
        // 防御性过滤：只允许删除自己的会话
        .eq('user_id', user.id);

      if (error) throw error;

      setSessions(prev => prev.filter(s => s.id !== id));
      
      if (currentSessionId === id) {
        handleNewChat();
      }
    } catch (e) {
      console.error("Delete error:", e);
      pushToast({ type: 'error', title: '删除失败', message: '删除失败，请稍后重试' });
    }
  };

  // --- Chat Logic ---

  const initChat = (keepMessages: boolean = false) => {
    if (!keepMessages) {
      setMessages([{
        id: 'init',
        role: 'model',
        text: '你好喵！我是璃璃～\n\n我是由 Oniya 开发的 Booth 商品搜索助手，随时愿意为你提供帮助喔！请告诉我你想要找的 VRChat 资产吧！',
        timestamp: Date.now()
      }]);
    }
  };

  useEffect(() => {
    // Only init if no current session (first load)
    if (!currentSessionId && messages.length === 0) {
      initChat(false);
    }
  }, []);

  // When a verified user becomes available (e.g. after refresh / verification), load sessions.
  useEffect(() => {
    if (!authLoading && user && isUserEmailVerified(user)) {

      // Also load turn meta once so sidebar can show total count/limit before first chat.
      (async () => {
        try {
          const { data, error } = await supabase
            .rpc('get_turn_meta')
            .maybeSingle();
          if (error) throw error;
          const meta = data as any;
          if (meta && typeof meta.daily_turn_count === 'number') setDailyTurnCount(meta.daily_turn_count);
          if (meta && typeof meta.daily_limit === 'number') setDailyTurnLimit(meta.daily_limit);
        } catch (e: any) {
          // Fail-closed: 不阻断 app，仅不显示
          console.warn('[Turns] get_turn_meta failed:', e?.message || e);
        }
      })();
      fetchSessions(user);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id, user?.email_confirmed_at, user?.confirmed_at]);

  useEffect(() => {
    // Only auto-scroll when user is already at (or near) the bottom.
    // If user scrolls up to read history, we stop forcing scroll to bottom.
    if (!isAtBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
  }, [messages, loading, processingTool, reducedMotion]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // reset input value so selecting the same file again triggers onChange
    e.target.value = "";

    if (!file) return;

    setImageProcessing(true);
    try {
      const compressedDataUrl = await compressImageFileToJpegDataUrl(file, 0.8);
      setImage(compressedDataUrl);
    } catch (err) {
      console.warn("[Image] Compress failed, fallback to original:", err);
      // Fallback: use original file as base64
      try {
        const original = await blobToDataUrl(file);
        setImage(original);
      } catch {
        pushToast({ type: 'error', title: '图片读取失败', message: '请重试或更换图片' });
      }
    } finally {
      setImageProcessing(false);
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

  const handleStopGenerating = () => {
    stopRequestedRef.current = true;
    try {
      chatAbortRef.current?.abort();
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canUseApp) return;
    if ((!input.trim() && !image) || loading || imageProcessing) return;

    const userText = input;
    const userImage = image;
    
    setInput("");
    setImage(null);
    setLoading(true);
    setCanStop(true);

    // 若上一次还在生成，先终止（防御性）
    try {
      chatAbortRef.current?.abort();
    } catch {
      // ignore
    }

    stopRequestedRef.current = false;
    const abortController = new AbortController();
    chatAbortRef.current = abortController;

    // 确保本轮有 chat_id（首次进入页面直接发送时，currentSessionId 可能为 null）
    const sessionId = currentSessionId || uuidv4();
    if (!currentSessionId) setCurrentSessionId(sessionId);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      text: userText,
      image: userImage || undefined,
      timestamp: Date.now()
    };
    
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    // If user sends a message while reading history, jump to bottom and resume auto-scroll
    // so they can follow the conversation.
    requestAnimationFrame(() => {
      try {
        const el = scrollContainerRef.current;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      } finally {
        isAtBottomRef.current = true;
      }
    });

    const modelMsgId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      {
        id: modelMsgId,
        role: 'model',
        text: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ]);

    // 让 catch 在 AbortError 时也能拿到部分已接收的内容
    let accumulatedText = "";
    let streamBuffer = "";

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await (async () => {
            const token = await getSupabaseAccessToken();
            if (token) return { Authorization: `Bearer ${token}` };
            if (visitorId) return { 'x-visitor-id': visitorId };
            return {};
          })()),
        },
        body: JSON.stringify({ messages: updatedMessages, chat_id: sessionId }),
        signal: abortController.signal,
      });

      const turnMeta = parseTurnMetaFromHeaders(response.headers);
      applyTurnMetaToSidebar(turnMeta);

      // Attach meta to the in-progress assistant message ASAP
      setMessages((prev) => prev.map((m) => (m.id === modelMsgId ? { ...m, turnMeta } : m)));

      // 超限：后端返回 JSON
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 429 && (data as any)?.error === 'TURN_LIMIT') {
          const reason = (data as any)?.reason;

          if (reason === 'limit_reached' || reason === 'invalid_visitor_id') {
            setMessages((prev) => prev.map((m) => (m.id === modelMsgId
              ? { ...m, text: '体验次数已用完，请登录或注册以继续使用喵！', isStreaming: false, status: undefined, turnMeta }
              : m
            )));
            setIsAuthOpen(true);
            return;
          }

          const base = reason === 'session_limit'
            ? `本会话已达到对话次数上限（${(data as any)?.session_turn_count}/${formatLimit((data as any)?.session_limit)}）`
            : `你已达到今日对话次数上限（${(data as any)?.daily_turn_count}/${formatLimit((data as any)?.daily_limit)}）。`;

          const hint = reason === 'session_limit'
            ? '\n\n点击左侧「新对话」来继续对话吧！'
            : '';

          setMessages((prev) => prev.map((m) => (m.id === modelMsgId
            ? { ...m, text: base + hint, isStreaming: false, status: undefined, turnMeta }
            : m
          )));
          return;
        }

        const errMsg = (data as any)?.error || response.statusText || '请求失败';
        setMessages((prev) => prev.map((m) => (m.id === modelMsgId
          ? { ...m, text: `请求失败：${errMsg}`, isStreaming: false, status: undefined, turnMeta }
          : m
        )));
        return;
      }

      if (!response.body) throw new Error(response.statusText);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // 由于 fetch stream 的 chunk 边界不可控：
      // - 同一个 chunk 里可能包含多个 __STATUS__
      // - 或者 __STATUS__ 可能被拆分到两个 chunk
      // 因此这里使用 buffer 逐步解析，避免丢内容。
      const STATUS_MARKER = "__STATUS__:";
      // streamBuffer / accumulatedText 已在外部声明，便于 AbortError 时也能返回部分内容

      let currentStatus = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("[Stream] Done reading.");
          break;
        }
        
        const chunk = decoder.decode(value, { stream: true });
        console.log(`[Stream] Received chunk: ${chunk.substring(0, 30)}...`);

        streamBuffer += chunk;

        // 解析所有完整的 __STATUS__:xxx\n
        while (true) {
          const idx = streamBuffer.indexOf(STATUS_MARKER);
          if (idx === -1) break;

          // marker 前的都是正文
          if (idx > 0) {
            accumulatedText += streamBuffer.slice(0, idx);
            streamBuffer = streamBuffer.slice(idx);
          }

          // 现在 buffer 以 marker 开头
          const afterMarker = streamBuffer.slice(STATUS_MARKER.length);
          const nlIdx = afterMarker.indexOf("\n");
          if (nlIdx === -1) {
            // status 行还没完整到达，等待下一个 chunk
            break;
          }

          // 后端可能为了触发 flush 而在 status 行内填充空格，这里统一 trim。
          currentStatus = afterMarker.slice(0, nlIdx).trim();
          // 消费 marker + status + newline
          streamBuffer = afterMarker.slice(nlIdx + 1);

          setMessages(prev => prev.map(m => m.id === modelMsgId ? {
            ...m,
            text: accumulatedText,
            status: currentStatus
          } : m));
        }

        // 只有当 buffer 中不包含 marker 的前缀时，才安全地将部分内容刷入正文。
        // 如果 buffer 中可能包含 marker（即便是不完整的），我们应该等待下一个 chunk。
        let firstPossibleMarkerIdx = -1;
        for (let i = 0; i < streamBuffer.length; i++) {
          if (STATUS_MARKER.startsWith(streamBuffer.slice(i))) {
            firstPossibleMarkerIdx = i;
            break;
          }
        }

        if (firstPossibleMarkerIdx === -1) {
          // buffer 里完全没有 marker 的影子，全刷进去
          accumulatedText += streamBuffer;
          streamBuffer = "";
        } else if (firstPossibleMarkerIdx > 0) {
          // 刷入直到第一个可能出现 marker 的位置
          accumulatedText += streamBuffer.slice(0, firstPossibleMarkerIdx);
          streamBuffer = streamBuffer.slice(firstPossibleMarkerIdx);
        }

        const maybeJsonStreaming = (accumulatedText + streamBuffer).toLowerCase().includes("```json");
        setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, text: accumulatedText, isJsonStreaming: maybeJsonStreaming } : m));
      }

      // Flush any remaining buffered content
      if (streamBuffer) {
        accumulatedText += streamBuffer;
        streamBuffer = "";
      }

      // Final cleanup of status
      setMessages(prev => prev.map(m => m.id === modelMsgId ? { ...m, status: undefined } : m));

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
        isJsonStreaming: false,
        timestamp: Date.now(),
        turnMeta,
      };

      const finalMessages = [...updatedMessages, finalModelMsg];
      setMessages(finalMessages);
      setLoading(false); // Stop loading early to improve perceived performance
      
      // Save to DB in background
      saveCurrentSession(finalMessages, sessionId).catch(e => console.error("Auto-save failed:", e));

    } catch (err: any) {
      // 用户点击“停止生成”时：fetch 会抛 AbortError
      const isAbort = err?.name === 'AbortError' || stopRequestedRef.current;
      if (isAbort) {
        // 尽量保留已收到的内容（如果 response 已经开始流式返回的话）
        // @ts-ignore - accumulatedText/streamBuffer 在上方 try 块作用域内
        const partial = String((typeof accumulatedText !== 'undefined' ? accumulatedText : '') + (typeof streamBuffer !== 'undefined' ? streamBuffer : '')).trim();
        const finalText = partial ? (partial + "\n\n（已停止生成）") : "（已停止生成）";
        setMessages((prev) => prev.map((m) => (m.id === modelMsgId
          ? { ...m, text: finalText, isStreaming: false, isJsonStreaming: false, status: undefined }
          : m
        )));
        return;
      }

      console.error(err);
      const msg = err?.message || "出错了！你可以发送“重试”来再次尝试。";
      setMessages((prev) => prev.map((m) => (m.id === modelMsgId
        ? { ...m, text: msg, isStreaming: false, isJsonStreaming: false, status: undefined }
        : m
      )));
    } finally {
      chatAbortRef.current = null;
      setCanStop(false);
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen text-zinc-100 font-sans overflow-hidden">
      
      <Sidebar 
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        user={user}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        collapsed={sidebarCollapsed}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onOpenAuth={() => setIsAuthOpen(true)}
        onDeleteSession={handleDeleteSession}
        totalTurnCount={dailyTurnCount}
        totalTurnLimit={dailyTurnLimit}
        reducedMotion={reducedMotion}
      />

      <div className="flex-1 flex flex-col h-full min-w-0">
        <header className="flex-none px-4 h-[72px] z-10 flex justify-between items-center bh-surface border-b border-white/5">
          <div className="flex items-center gap-3">
             <button 
              onClick={() => {
                if (window.innerWidth >= 768) setSidebarCollapsed((v) => !v);
                else setIsSidebarOpen(true);
              }}
              className="text-zinc-300 hover:text-white bh-icon-btn p-2"
              aria-label={window.innerWidth >= 768 ? (sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏") : "打开侧边栏"}
              title={window.innerWidth >= 768 ? (sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏") : "打开侧边栏"}
             >
               <Menu size={24} />
             </button>
             <div className="flex items-center gap-3 md:hidden">
                <div className="w-9 h-9 rounded-2xl flex items-center justify-center text-white font-bold bh-btn-primary">B</div>
             </div>
             <div className="hidden md:block">
                <h1 className="text-xl font-bold tracking-tight leading-none text-white">Booth Hunter</h1>
                <p className="text-[10px] text-zinc-400 font-mono tracking-wide mt-0.5">Made by Oniya</p>
             </div>
          </div>

          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                onClick={() => setIsAdminPanelOpen(true)}
                className="p-2 text-zinc-300 hover:text-white bh-icon-btn"
                aria-label="打开管理员面板"
                title="管理员面板"
              >
                <Shield size={20} />
              </button>
            )}

            <a
              href="https://github.com/oniyakun/Booth-Hunter"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub 项目"
              title="GitHub"
              className="p-2 text-zinc-300 hover:text-white bh-icon-btn"
            >
              <Github size={20} />
            </a>
          </div>
        </header>

        <main
          ref={(el) => {
            // TS: main is HTMLElement
            scrollContainerRef.current = el;
          }}
          onScroll={() => updateIsAtBottom()}
          className="flex-grow overflow-y-auto px-4 py-6"
        >
          <div className="max-w-4xl lg:max-w-6xl 2xl:max-w-7xl mx-auto flex flex-col justify-end min-h-full pb-4">
            {sessionMessagesLoading ? (
              <div className={reducedMotion ? '' : 'bh-anim-fade-up'}>
                <MessageSkeletonList count={6} />
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={`${msg.id}-${messageAnimationNonce}`}
                  className={reducedMotion ? '' : 'bh-anim-fade-up'}
                  style={getStaggerStyle(i, !reducedMotion, 28, 320)}
                >
                  <ChatMessageBubble message={msg} largeLayout={largeLayout} />
                </div>
              ))
            )}

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
               <div className="flex w-full mb-6 justify-start bh-anim-fade-up">
                 <div className="flex flex-col items-start max-w-[85%]">
                   <div className="flex items-center gap-2 mb-2 ml-12 text-[#fc4d50]/80 text-xs font-mono">
                      <Hammer size={12} className="animate-bounce" />
                      <span>正在抓取 Booth 数据...</span>
                   </div>
                 </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        <footer className="flex-none p-4 md:p-6 z-20 bh-surface border-t border-white/5">
          <div className="max-w-4xl lg:max-w-6xl 2xl:max-w-7xl mx-auto">
            {image && (
              <div className="mb-3 flex items-start bh-anim-fade-up">
                <div className="relative group">
                  <img src={image} alt="Ref" className="h-20 w-20 rounded-xl object-cover border border-zinc-700 shadow-xl" />
                  <button 
                    onClick={() => setImage(null)}
                    className="absolute -top-2 -right-2 text-white rounded-full p-1.5 opacity-80 hover:opacity-100 transition-opacity bh-badge"
                    aria-label="移除图片"
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
                disabled={imageProcessing || !canUseApp}
                className="p-3.5 text-zinc-300 hover:text-white transition-all disabled:opacity-60 disabled:hover:bg-transparent disabled:cursor-not-allowed bh-icon-btn"
                title="Upload Image"
              >
                {imageProcessing ? <Loader2 size={22} className="animate-spin" /> : <ImageIcon size={22} />}
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
                  disabled={!canUseApp}
                  placeholder={canUseApp ? "描述你想要的素材 (例如: 适用于巧克力的泳衣)..." : (user ? "请先登录并完成邮箱验证后继续使用" : "正在加载...")}
                  className="w-full rounded-2xl px-5 py-4 pr-14 text-base focus:outline-none transition-all placeholder-zinc-500 bh-input"
                />
                <button
                  type={canStop ? "button" : "submit"}
                  onClick={canStop ? handleStopGenerating : undefined}
                  disabled={!canUseApp || imageProcessing || (!canStop && (loading || (!input.trim() && !image)))}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 p-2.5 text-white rounded-xl transition-all ${
                    canStop
                      ? 'bg-zinc-800 hover:bg-zinc-700'
                      : 'bh-btn-primary disabled:opacity-50 disabled:bg-zinc-700'
                  }`}
                  aria-label={canStop ? "停止生成" : "发送"}
                  title={canStop ? "停止生成" : "发送"}
                >
                  {canStop ? <Pause size={18} /> : <Send size={18} />}
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
          canClose={canUseApp}
        />
      )}

      {/* Email verification gate: logged in but not verified */}
      {!authLoading && user && !emailVerified && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
          <div className="bg-[#18181b] border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-white mb-3">请先验证邮箱</h2>
            <p className="text-sm text-zinc-400 leading-relaxed mb-5">
              你的账号 <span className="text-zinc-200 font-medium">{user.email}</span> 尚未通过邮箱验证。
              为了继续使用 Booth Hunter，请前往邮箱点击验证链接。
            </p>

            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    const { error } = await supabase.auth.resend({ type: "signup", email: user.email });
                    if (error) throw error;
                    pushToast({ type: 'success', title: '已发送', message: '已重新发送验证邮件，请检查收件箱/垃圾箱' });
                  } catch (e: any) {
                    pushToast({ type: 'error', title: '发送失败', message: e?.message || '请稍后重试' });
                  }
                }}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2.5 rounded-lg transition-colors border border-zinc-700"
              >
                重新发送验证邮件
              </button>
              <button
                onClick={async () => {
                  // Refresh user to pick up latest confirmation status
                  const { data } = await supabase.auth.getUser();
                  setUser(data.user ?? null);
                }}
                className="bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-bold py-2.5 px-4 rounded-lg transition-colors border border-zinc-700"
                title="我已完成验证，刷新状态"
              >
                刷新
              </button>
            </div>

            <button
              onClick={async () => {
                await supabase.auth.signOut();
              }}
              className="mt-4 w-full text-sm text-zinc-400 hover:text-white py-2 rounded-lg hover:bg-zinc-900 transition-colors"
            >
              退出登录
            </button>
          </div>
        </div>
      )}

      <Analytics />

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      <ConfirmModal
        open={confirmOpen}
        options={confirmOptions}
        onCancel={() => closeConfirm(false)}
        onConfirm={() => closeConfirm(true)}
      />

      <UserLimitModal
        open={limitModalOpen}
        emailOrId={limitModalUser?.email || limitModalUser?.id || ''}
        initial={limitModalDraft}
        onCancel={() => closeLimitModal(null)}
        onSave={(draft) => {
          // validate number parsing inside modal will throw; catch here for toast
          try {
            closeLimitModal(draft);
          } catch (e: any) {
            pushToast({ type: 'error', title: '输入错误', message: e?.message || '请输入数字' });
          }
        }}
      />

      {isAdmin && isAdminPanelOpen && (
        <AdminPanel
          onClose={() => setIsAdminPanelOpen(false)}
          confirm={confirmAsync}
          notify={pushToast}
          editUserLimits={editUserLimitsAsync}
        />
      )}

      {/* styles moved to index.css */}
    </div>
  );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
