import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Search, Image as ImageIcon, Upload, ExternalLink, Loader2, Sparkles, ShoppingBag, X, AlertCircle, Terminal, ChevronDown, ChevronUp, Send, User, Hammer, LogOut, History, Plus, PanelLeft, UserCircle, Layout, MessageSquare, Trash2, Github, Shield, Users, Pause, Globe } from "lucide-react";
import ReactMarkdown from "react-markdown";
import "./i18n";
import { useTranslation } from "react-i18next";
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
  if (t === 'error') return 'border-[#FF5C5C]/30 bg-[#FF5C5C]/10 text-[#FFD3C6]';
  return 'border-white/10 bg-white/5 text-zinc-200';
};

const ToastViewport = ({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) => {
  const { t } = useTranslation();
  return (
    <div className="fixed right-4 bottom-4 z-[90] w-[calc(100vw-2rem)] max-sm:w-[calc(100vw-1rem)] max-w-sm space-y-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`bh-surface-strong border shadow-2xl rounded-2xl p-4 backdrop-blur-md ${toastAccent(toast.type)}`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              {toast.type === 'success' ? (
                <Sparkles size={16} />
              ) : toast.type === 'error' ? (
                <AlertCircle size={16} />
              ) : (
                <Terminal size={16} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {toast.title && <div className="text-sm font-bold text-white truncate">{toast.title}</div>}
              <div className="text-sm text-zinc-200 leading-relaxed break-words">{toast.message}</div>
            </div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="p-1 rounded-lg text-zinc-300 hover:text-white hover:bg-white/10"
              aria-label={t("Close")}
              title={t("Close")}
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
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="w-full max-w-md bh-surface-strong rounded-3xl border border-white/10 shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5 flex items-center justify-between">
          <div className="text-white font-bold">{title}</div>
          <button onClick={onClose} className="bh-icon-btn p-2 text-zinc-300 hover:text-white" aria-label={t("Close")}>
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
  const { t } = useTranslation();
  return (
    <ModalShell open={open} title={options.title} onClose={onCancel}>
      <div className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{options.message}</div>
      <div className="mt-5 flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl text-sm font-medium bh-btn-secondary text-white"
        >
          {options.cancelText || t("Cancel")}
        </button>
        <button
          onClick={onConfirm}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all ${
            options.destructive ? 'bg-[#FF5C5C] hover:bg-[#FF5C5C]/90' : 'bh-btn-primary'
          }`}
        >
          {options.confirmText || t("Confirm")}
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
  const { t } = useTranslation();
  const [sessionStr, setSessionStr] = useState<string>(initial.session_turn_limit_override == null ? '' : String(initial.session_turn_limit_override));
  const [dailyStr, setDailyStr] = useState<string>(initial.daily_turn_limit_override == null ? '' : String(initial.daily_turn_limit_override));

  useEffect(() => {
    if (!open) return;
    setSessionStr(initial.session_turn_limit_override == null ? '' : String(initial.session_turn_limit_override));
    setDailyStr(initial.daily_turn_limit_override == null ? '' : String(initial.daily_turn_limit_override));
  }, [open, initial.session_turn_limit_override, initial.daily_turn_limit_override]);

  const parseOptionalInt = (s: string): number | null => {
    const tStr = s.trim();
    if (!tStr) return null;
    const n = Number(tStr);
    if (!Number.isFinite(n)) throw new Error(t("PleaseEnterNumber"));
    return Math.trunc(n);
  };

  return (
    <ModalShell open={open} title={t("SetUserLimit")} onClose={onCancel}>
      <div className="text-xs text-zinc-400 mb-3">
        {t("TargetUser")}：<span className="text-zinc-200 font-mono">{emailOrId}</span>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">{t("SessionLimitLabel")}</label>
          <input
            value={sessionStr}
            onChange={(e) => setSessionStr(e.target.value)}
            placeholder={t("LimitPlaceholder")}
            className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
            inputMode="numeric"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">{t("DailyLimitLabel")}</label>
          <input
            value={dailyStr}
            onChange={(e) => setDailyStr(e.target.value)}
            placeholder={t("LimitPlaceholder")}
            className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="mt-3 text-[11px] text-zinc-500 leading-relaxed">
        {t("LimitHint")}
      </div>

      <div className="mt-5 flex gap-3">
        <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-sm font-medium bh-btn-secondary text-white">
          {t("Cancel")}
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
          {t("Save")}
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
  const { t } = useTranslation();
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
  const [userSortBy, setUserSortBy] = useState<'created_at' | 'last_active' | 'total_turn_count'>('created_at');

  // Turn limits
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Admin 详情里需要把历史消息中可能包含的商品卡片渲染出来。
  // - 新版本 messages 里通常会带 items 字段。
  // - 老版本可能把 items 以 ```json [...]``` 的形式嵌在 text 里。
  const { t: tAdmin } = useTranslation();
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
    const { t: tCard } = useTranslation();
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
          <h3 className="font-bold text-sm text-white leading-snug bh-clamp-2 group-hover:text-[#FF6B3D] transition-colors">
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

          <div className="mt-4 pt-3 border-t border-[#2A2230] flex justify-between items-center">
            <span className="text-[11px] text-zinc-500 truncate max-w-[60%]">{asset.shopName}</span>
             <a 
              href={asset.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-bold text-white px-3 py-2 rounded-xl bh-btn-primary"
            >
              {tAdmin("AssetDetails")}
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>
    );
  };

  const AdminMessageCard = ({ m, idx }: { m: Message; idx: number }) => {
    const { t: tMsg } = useTranslation();
    const isUser = m.role === 'user';

    // items 优先使用消息对象自带的；否则尝试从 text 的 ```json``` 里解析。
    const { cleanText, items: itemsFromText } = extractItemsFromText(m.text || '');
    const items = (m.items && m.items.length ? m.items : itemsFromText) || [];

    return (
      <div key={m.id || idx} className="bh-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className={`text-xs font-mono ${isUser ? 'text-[#FF5C5C]' : 'text-[#FF6B3D]'}`}>
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

  const loadUsers = async (sortBy?: 'created_at' | 'last_active' | 'total_turn_count') => {
    setUsersLoading(true);
    setError(null);
    try {
      const sortParam = sortBy || userSortBy;
      const res = await adminFetchJson<{ data: Profile[] }>(`/api/admin/users?sort_by=${encodeURIComponent(sortParam)}`);
      setUsers(res.data || []);
    } catch (e: any) {
      setError(e?.message || t("LoadUsersFailed"));
      notify({ type: 'error', title: t("LoadFailed"), message: e?.message || t("LoadUsersFailed") });
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
      notify({ type: 'success', title: t("Saved"), message: t("DefaultLimitUpdated") });
    } catch (e: any) {
      setError(e?.message || t("SaveLimitFailed"));
      notify({ type: 'error', title: t("SaveFailed"), message: e?.message || t("SaveLimitFailed") });
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

      notify({ type: 'success', title: t("Saved"), message: t("UserLimitUpdated") });
    } catch (e: any) {
      notify({ type: 'error', title: t("SetFailed"), message: e?.message || t("SetUserLimitFailed") });
      setError(e?.message || t("SetUserLimitFailed"));
    }
  };

  const deleteUser = async (userId: string) => {
    if (!userId) return;
    const ok = await confirm({
      title: t("DeleteUser"),
      message: t("DeleteUserConfirm"),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
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
      notify({ type: 'success', title: t("Deleted"), message: t("UserDeleted") });
    } catch (e: any) {
      setError(e?.message || t("DeleteUserFailed"));
      notify({ type: 'error', title: t("DeleteFailed"), message: e?.message || t("DeleteUserFailed") });
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
      setError(e?.message || t("LoadChatsFailed"));
      notify({ type: 'error', title: t("LoadFailed"), message: e?.message || t("LoadChatsFailed") });
    } finally {
      setChatsLoading(false);
    }
  };

  const deleteChat = async (chatId: string) => {
    if (!chatId) return;
    const ok = await confirm({
      title: t("DeleteChat"),
      message: t("DeleteChatAdminConfirm"),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
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

      // 从列表里移除（避免一次全量刷新），并保持 UI响应快
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      notify({ type: 'success', title: t("Deleted"), message: t("ChatDeleted") });
    } catch (e: any) {
      setError(e?.message || t("DeleteChatFailed"));
      notify({ type: 'error', title: t("DeleteFailed"), message: e?.message || t("DeleteChatFailed") });
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
      setError(e?.message || t("LoadChatDetailFailed"));
      notify({ type: 'error', title: t("LoadFailed"), message: e?.message || t("LoadChatDetailFailed") });
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
              <span className="text-white font-bold">{t("AdminPanel")}</span>
              <span className="text-[10px] text-zinc-400 font-mono tracking-wide mt-0.5">Admin Console</span>
            </div>
          </div>

          <button onClick={onClose} className="bh-icon-btn p-2 text-zinc-300 hover:text-white" aria-label={t("Close")}>
            <X size={20} />
          </button>
        </div>

        <div className="h-[calc(100%-72px)] grid grid-cols-1 lg:grid-cols-[320px_1fr]">
          {/* Left: Users */}
          <aside className="border-b lg:border-b-0 lg:border-r border-white/5 overflow-hidden flex flex-col bg-black/20">
            {/* Header */}
            <div className="px-4 py-3 border-b border-white/5">
              <div className="flex items-center gap-2 text-white font-bold">
                <Users size={18} className="text-[#FF5C5C]" />
                <span>{t("UserManagement")}</span>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto">
              {/* Section 1: Search */}
              <div className="p-4 border-b border-white/5">
                <div className="flex items-center gap-2 text-zinc-300 text-sm font-medium mb-3">
                  <Search size={14} className="text-zinc-500" />
                  <span>{t("SearchUser")}</span>
                </div>
                <input
                  value={userQuery}
                  onChange={(e) => setUserQuery(e.target.value)}
                  placeholder={t("SearchUserPlaceholder")}
                  className="w-full rounded-xl px-4 py-2.5 text-white focus:outline-none bh-input text-sm"
                />
              </div>

              {/* Section 2: View Controls */}
              <div className="p-4 border-b border-white/5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 text-zinc-300 text-sm font-medium">
                    <Layout size={14} className="text-zinc-500" />
                    <span>{t("ViewOptions")}</span>
                  </div>
                  <button
                    onClick={() => loadUsers()}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                    title={t("Refresh")}
                  >
                    <Loader2 size={14} className={`${usersLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                {/* Sort Options */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setUserSortBy('created_at');
                      loadUsers('created_at');
                    }}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      userSortBy === 'created_at'
                        ? 'bg-[#FF5C5C]/20 text-white'
                        : 'bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.07]'
                    }`}
                    title={t("CreatedAt")}
                  >
                    {t("CreatedAt")}
                  </button>
                  <button
                    onClick={() => {
                      setUserSortBy('last_active');
                      loadUsers('last_active');
                    }}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      userSortBy === 'last_active'
                        ? 'bg-[#FF5C5C]/20 text-white'
                        : 'bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.07]'
                    }`}
                    title={t("LastActive")}
                  >
                    {t("LastActive")}
                  </button>
                  <button
                    onClick={() => {
                      setUserSortBy('total_turn_count');
                      loadUsers('total_turn_count');
                    }}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      userSortBy === 'total_turn_count'
                        ? 'bg-[#FF5C5C]/20 text-white'
                        : 'bg-white/5 text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.07]'
                    }`}
                    title={t("TotalTurns")}
                  >
                    {t("TotalTurns")}
                  </button>
                </div>

                {/* Quick Actions */}
                <div className="mt-3">
                  <button
                    onClick={() => loadChats(null)}
                    className="w-full py-2.5 rounded-xl text-sm font-medium bh-btn-secondary text-white flex items-center justify-center gap-2"
                  >
                    <MessageSquare size={16} />
                    {t("ViewAllChats")}
                  </button>
                </div>
              </div>

              {/* Section 3: Global Settings */}
              <div className="p-4">
                <div className="flex items-center gap-2 text-zinc-300 text-sm font-medium mb-3">
                  <Shield size={14} className="text-zinc-500" />
                  <span>{t("GlobalLimit")}</span>
                </div>
                
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-zinc-500 mb-1.5">{t("SessionLimitLabel")}</label>
                      <input
                        value={settings?.default_session_turn_limit ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSettings((s) => ({
                            default_session_turn_limit: v === '' ? 0 : Number(v),
                            default_daily_turn_limit: s?.default_daily_turn_limit ?? 0,
                          }));
                        }}
                        placeholder="50"
                        className="w-full rounded-xl px-3 py-2 text-white focus:outline-none bh-input text-sm"
                        inputMode="numeric"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-zinc-500 mb-1.5">{t("DailyLimitLabel")}</label>
                      <input
                        value={settings?.default_daily_turn_limit ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSettings((s) => ({
                            default_session_turn_limit: s?.default_session_turn_limit ?? 0,
                            default_daily_turn_limit: v === '' ? 0 : Number(v),
                          }));
                        }}
                        placeholder="200"
                        className="w-full rounded-xl px-3 py-2 text-white focus:outline-none bh-input text-sm"
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                  
                  <button
                    onClick={saveSettings}
                    disabled={settingsSaving || !settings}
                    className="w-full py-2 rounded-xl text-sm font-medium bh-btn-primary text-white disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {settingsSaving ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        {t("Saving")}...
                      </>
                    ) : (
                      <>
                        <Terminal size={14} />
                        {t("SaveSettings")}
                      </>
                    )}
                  </button>
                  
                  <div className="text-[10px] text-zinc-500 leading-relaxed bg-white/5 rounded-lg px-3 py-2">
                    <span className="text-[#FF5C5C]">{t("Tip")}: </span>{t("LimitHint")}
                  </div>
                </div>
              </div>
            </div>

            {/* Section 4: User List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
              {usersLoading ? (
                Array.from({ length: 8 }).map((_, i) => <div key={i} className="bh-skeleton" style={{ height: 54 }} />)
              ) : filteredUsers.length === 0 ? (
                <div className="text-sm text-zinc-500 text-center py-10">{t("NoUsers")}</div>
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
                    className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer outline-none focus:ring-2 focus:ring-[#FF6B3D]/30 ${
                      selectedUserId === u.id
                        ? 'border-[#FF6B3D]/25 bg-[#FF6B3D]/10'
                        : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white font-medium truncate">{u.email || u.id}</div>
                        <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">{u.id}</div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          {t("DailyTurns")}：<span className="text-zinc-300">{u.daily_turn_count ?? 0}</span>
                          <span className="mx-2 text-zinc-600">|</span>
                          {t("TotalTurns")}：<span className="text-zinc-300">{u.total_turn_count ?? 0}</span>
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          {t("OverrideLimit")}：
                          <span className="text-zinc-300">
                            {t("Session")} {u.session_turn_limit_override ?? t("Default")} / {t("Daily")} {u.daily_turn_limit_override ?? t("Default")}
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
                          title={t("SetUserLimit")}
                          aria-label={t("SetUserLimit")}
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
                          title={t("DeleteUser")}
                          aria-label={t("DeleteUser")}
                        >
                          {userDeletingId === u.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </div>
                    </div>
                    {u.is_admin && (
                      <div className="mt-2 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg bg-[#FF5C5C]/10 border border-[#FF5C5C]/20 text-[#FF5C5C]">
                        <Shield size={12} />
                        {t("Admin")}
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
              <div className="text-white font-bold">{t("ChatList")}</div>
              <button
                onClick={() => loadChats(selectedUserId)}
                className="py-2 px-3 rounded-xl text-sm font-medium bh-btn-secondary text-white"
              >
                {t("Refresh")}
              </button>
            </div>

            {error && (
              <div className="p-4">
                <div className="p-3 bg-[#FF5C5C]/10 border border-[#FF5C5C]/25 rounded-xl text-[#FFD3C6] text-sm">
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
                  <div className="text-sm text-zinc-500 text-center py-10">{t("NoChats")}</div>
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
                      className={`w-full text-left p-3 rounded-2xl border transition-all cursor-pointer outline-none focus:ring-2 focus:ring-[#FF6B3D]/30 ${
                        selectedChatId === c.id
                          ? 'border-[#FF6B3D]/25 bg-[#FF6B3D]/10'
                          : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm text-white font-medium truncate min-w-0 flex-1">
                          {c.title || t("UntitledChat")}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteChat(c.id);
                          }}
                          disabled={!!chatDeletingId}
                          className="p-2 rounded-xl bh-btn-secondary text-zinc-200 hover:text-white disabled:opacity-50"
                          title={t("DeleteChat")}
                          aria-label={t("DeleteChat")}
                        >
                          {chatDeletingId === c.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                        </button>
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">chat: {c.id}</div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate mt-1">user: {c.user_id}</div>
                      <div className="text-[10px] text-zinc-500 mt-1">{t("SessionTurns")}：{c.turn_count ?? 0}</div>
                      <div className="text-[10px] text-zinc-600 mt-1">{new Date(c.created_at).toLocaleString()}</div>
                    </div>
                  ))
                )}
              </div>

              {/* Chat detail */}
              <div className="overflow-y-auto p-4">
                {!selectedChatId ? (
                  <div className="text-zinc-500 text-sm text-center py-16">{t("SelectChatToView")}</div>
                ) : chatLoading ? (
                  <div className="space-y-3">
                    <div className="bh-skeleton" style={{ height: 18, width: '60%' }} />
                    <div className="bh-skeleton" style={{ height: 120 }} />
                    <div className="bh-skeleton" style={{ height: 120 }} />
                  </div>
                ) : !chatDetail ? (
                  <div className="text-zinc-500 text-sm text-center py-16">{t("ChatNotFound")}</div>
                ) : (
                  <div>
                    <div className="mb-4">
                      <div className="text-white font-bold text-lg truncate">{chatDetail.title || t("UntitledChat")}</div>
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
  const { t } = useTranslation();
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
          setError(t("EmailAlreadyRegistered"));
        } else {
          setError(t("RegisterSuccess"));
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
          <h2 className="text-xl font-bold text-white">{isLogin ? t("Login") : t("Register")}</h2>
          {canClose && (
            <button onClick={onClose} className="text-zinc-400 hover:text-white bh-icon-btn p-2" aria-label={t("Close")}>
              <X size={20} />
            </button>
          )}
        </div>
        
        {!canClose && (
          <div className="mb-6 text-sm text-zinc-400 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800/50">
            {t("LoginPrompt")}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-[#FF6B3D]/10 border border-[#FF6B3D]/25 rounded-lg text-[#FFD3C6] text-sm flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">{t("Email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl px-4 py-3 text-white focus:outline-none bh-input"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">{t("Password")}</label>
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
            {loading ? <Loader2 size={18} className="animate-spin mx-auto" /> : (isLogin ? t("Login") : t("Register"))}
          </button>
        </form>

        <div className="mt-4 text-center text-sm text-zinc-400">
          {isLogin ? t("NoAccount") : t("HasAccount")}
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="ml-1 text-[#FF6B3D] hover:underline font-medium"
          >
            {isLogin ? t("RegisterNow") : t("GoLogin")}
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
  const { t } = useTranslation();
  const name = user?.email?.split('@')[0] || '';
  const initial = (name || 'U').slice(0, 1).toUpperCase();
  const turnPct = totalTurnLimit && totalTurnLimit > 0
    ? Math.min(100, ((totalTurnCount || 0) / totalTurnLimit) * 100)
    : 0;

  return (
    <>
      {isOpen && <div className="bh-sidebar-backdrop" onClick={onClose} />}

      <aside className={`bh-sidebar ${isOpen ? 'is-open' : ''}`} aria-label={t("History")}>
        <div className="bh-brand">
          <div className="bh-brand-mark">
            <img src="/icon/icon-face-128.png" alt="" />
          </div>
          {!collapsed && (
            <div className="bh-brand-text">
              <b>Booth Hunter</b>
              <span>by Oniya</span>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="bh-brand-close"
            aria-label="Close sidebar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="bh-new-chat-wrap">
          <button
            type="button"
            onClick={() => { onNewChat(); if (window.innerWidth < 860) onClose(); }}
            className="bh-new-chat"
            aria-label={t("NewChat")}
            title={t("NewChat")}
          >
            <Plus size={16} />
            {!collapsed && <span>{t("NewChat")}</span>}
          </button>
        </div>

        <div className="bh-side-list">
          {!collapsed && <div className="bh-side-label">{t("History")}</div>}

          {!user ? (
            <div className="bh-side-empty">{t("LoginToSave")}</div>
          ) : sessionsLoading ? (
            <div style={{ display: 'grid', gap: 8, paddingBottom: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bh-skeleton" style={{ height: 42 }} />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="bh-side-empty">{t("NoHistory")}</div>
          ) : (
            sessions.map((session, i) => (
              <div
                key={session.id}
                className={`bh-session-wrap ${reducedMotion ? '' : 'bh-anim-fade-left'}`}
                style={getStaggerStyle(i, !reducedMotion, 28, 220)}
              >
                <button
                  type="button"
                  onClick={() => { onSelectSession(session.id); if (window.innerWidth < 860) onClose(); }}
                  title={session.title || t("UntitledChat")}
                  className={`bh-session ${currentSessionId === session.id ? 'is-active' : ''}`}
                >
                  <MessageSquare size={14} className="bh-session-icon" />
                  <span className="bh-session-title">{session.title || t("UntitledChat")}</span>
                </button>
                {!collapsed && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                    className="bh-session-del"
                    title={t("DeleteChat")}
                    aria-label={t("DeleteChat")}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="bh-account">
          {user ? (
            <>
              <div className="bh-account-row">
                <div className="bh-account-avatar" aria-hidden="true">{initial}</div>
                {!collapsed && (
                  <div className="bh-account-id">
                    <b>{name}</b>
                    <span>{user.email}</span>
                  </div>
                )}
                <div className="bh-account-actions">
                  <button
                    type="button"
                    onClick={async () => { await supabase.auth.signOut(); }}
                    className="bh-icon-btn"
                    title={t("Logout")}
                    aria-label={t("Logout")}
                  >
                    <LogOut size={15} />
                  </button>
                </div>
              </div>
              {!collapsed && (
                <>
                  <div className="bh-account-meta">
                    <span>{t("DailyTurns")}</span>
                    <span><em>{totalTurnCount ?? '—'}</em> / {formatLimit(totalTurnLimit)}</span>
                  </div>
                  <div className="bh-meter" aria-hidden="true"><i style={{ width: `${turnPct}%` }} /></div>
                </>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenAuth}
              className="bh-login"
              aria-label={t("LoginRegister")}
            >
              <UserCircle size={17} />
              {!collapsed && <span>{t("LoginRegister")}</span>}
            </button>
          )}
        </div>
      </aside>
    </>
  );
};

type CardAccent = 'orange' | 'blue' | 'mint';

const AssetCard = React.memo(({
  asset,
  accent = 'orange',
}: {
  asset: AssetResult;
  accent?: CardAccent;
}) => {
  const { t } = useTranslation();
  const [imgError, setImgError] = useState(false);
  const kind = (asset.tags && asset.tags[0]) || 'Booth';
  const glyph = (asset.title || '?').trim().slice(0, 1);

  return (
    <article className="bh-asset-card" data-accent={accent}>
      <a
        className="bh-asset-art"
        href={asset.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={asset.title}
      >
        <span className="bh-asset-glyph" aria-hidden="true">{glyph}</span>
        {asset.imageUrl && !imgError ? (
          <img
            src={asset.imageUrl}
            alt={asset.title}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <span className="bh-asset-fallback"><ShoppingBag size={34} /></span>
        )}
        <span className="bh-asset-kind">{kind}</span>
      </a>

      <div className="bh-asset-info">
        <h3 className="bh-asset-title">{asset.title}</h3>
        <div className="bh-asset-shop">
          <ShoppingBag size={10} />
          <span>{asset.shopName}</span>
        </div>
        <div className="bh-asset-chips">
          {(asset.tags || []).slice(0, 2).map((tag, i) => (
            <span key={i} className={`bh-chip ${i === 0 ? 'is-blue' : ''}`}>{tag}</span>
          ))}
        </div>
      </div>

      <div className="bh-asset-stub">
        <div className="bh-price"><b>{asset.price}</b></div>
        <a
          className="bh-open"
          href={asset.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>{t("AssetDetails")}</span>
          <ExternalLink size={11} />
        </a>
      </div>
    </article>
  );
});

const AssetCardSkeleton = React.memo(() => {
  return (
    <div className="bh-asset-skeleton" aria-hidden="true">
      <div className="bh-skel-art bh-shimmer" />
      <div className="bh-skel-body">
        <div className="bh-skel-line bh-shimmer" style={{ width: '82%' }} />
        <div className="bh-skel-line bh-shimmer" style={{ width: '56%' }} />
        <div className="bh-skel-line bh-shimmer" style={{ width: '40%' }} />
      </div>
    </div>
  );
});

// 从流式文本中提取“已经完整输出”的商品对象。
// 后端会在最终回复末尾输出 ```json [...] ```；这里不等整个 JSON 结束，
// 只要数组中某个对象已经闭合，就把它交给前端渲染成卡片。
function extractStreamingItems(text: string): AssetResult[] | undefined {
  const fenceIdx = text.toLowerCase().indexOf('```json');
  if (fenceIdx === -1) return undefined;

  const startIdx = text.indexOf('[', fenceIdx);
  if (startIdx === -1) return undefined;

  const items: AssetResult[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = startIdx + 1; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          const parsed = JSON.parse(text.slice(objStart, i + 1));
          if (parsed && typeof parsed === 'object' && (parsed as any).id) {
            items.push(parsed as AssetResult);
          }
        } catch {
          // 对象尚未完整/格式异常，等后续 chunk 再试
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }

  return items.length ? items : undefined;
}

const ChatMessageBubble = React.memo(({ message }: { message: Message }) => {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  const [expanded, setExpanded] = React.useState(false);

  // 流式过程中即时解析已完整的商品（message.items 要等流结束才会由后端结果写入）
  const streamedItems = React.useMemo(
    () => extractStreamingItems(message.text || ''),
    [message.text]
  );
  const items = message.items && message.items.length > 0 ? message.items : (streamedItems || []);

  // The reply starts with "当前关键词…；当前页码…" for follow-up context.
  // Show it as a compact trace instead of a raw text line.
  const searchMeta = React.useMemo(() => {
    const m = (message.text || '').match(/当前关键词[：:]\s*([^\n；;]+)[；;]\s*当前页码[：:]\s*(\d+)/);
    return m ? { keyword: m[1].trim(), page: m[2] } : null;
  }, [message.text]);

  // Filter out JSON code blocks and the keyword/page line from display text
  const displayText = React.useMemo(() => {
    let text = message.text;
    // Remove completed JSON blocks
    text = text.replace(/```json[\s\S]*?```/gi, '');
    // Remove potentially incomplete JSON block at the end if streaming
    text = text.replace(/```json[\s\S]*/gi, '');
    // Remove a partially streamed opening fence (``` / ```j / ```js ...) so no code flashes
    if (message.isStreaming) text = text.replace(/```(?:j(?:s(?:o(?:n)?)?)?)?\s*$/i, '');
    // Hide the keyword/page metadata line (rendered as a trace instead)
    text = text.replace(/^\s*当前关键词[：:][^\n]*?当前页码[：:]\s*\d+\s*[。.]?\s*\n?/m, '');
    return text.trim();
  }, [message.text, message.isStreaming]);

  const canCollapse = !isUser && items.length > 0 && displayText.length > 240;
  const accents: CardAccent[] = ['orange', 'blue', 'mint'];

  return (
    <div className="bh-chat-col">
      <div className={`bh-msg ${isUser ? 'is-user' : ''}`}>
        {!isUser && (
          <div className="bh-msg-avatar">
            <img src="/icon/icon-face-128.png" alt="" />
          </div>
        )}

        <div className="bh-msg-body">
          <div className="bh-msg-who">
            <b>{isUser ? t("You") : t("Lili")}</b>
            {message.timestamp ? (
              <time>
                {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            ) : null}
          </div>

          {message.toolCall && (
            <div className={`bh-tool-call ${message.toolCall.includes(t("Retry")) ? 'is-retry' : ''}`}>
              <Hammer size={12} className={message.toolCall.includes(t("Retry")) ? 'animate-spin' : undefined} />
              <span>{t("ToolCall")}: {message.toolCall}</span>
            </div>
          )}

          {message.status && (
            <div className="bh-status">
              <span className="bh-status-dot" aria-hidden="true" />
              <span>{message.status}</span>
              <Loader2 size={12} className="animate-spin" style={{ marginLeft: 'auto', color: 'var(--bh-muted)' }} />
            </div>
          )}

          {isUser ? (
            <div className="bh-user-bubble">
              {message.image && <img src={message.image} alt="Upload" />}
              <div className="markdown-body">
                <ReactMarkdown>{displayText}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <>
              {searchMeta && (
                <div className="bh-trace">
                  <span className="bh-trace-step"><i />「{searchMeta.keyword}」</span>
                  <span className="bh-trace-sep" aria-hidden="true" />
                  <span className="bh-trace-step is-now"><i />p.{searchMeta.page}</span>
                </div>
              )}

              <div className={`bh-prose markdown-body ${canCollapse && !expanded ? 'is-clamped' : ''}`}>
                <ReactMarkdown>{displayText}</ReactMarkdown>
                {message.isStreaming && <span className="bh-stream-cursor" />}
              </div>

              {canCollapse && (
                <button type="button" className="bh-expand" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? t("ShowLess") : t("ShowMore")}
                </button>
              )}

              {message.turnMeta && (
                <div className="bh-turn-meta">
                  {t("SessionTurns")} {message.turnMeta.session_turn_count ?? '—'}/{formatLimit(message.turnMeta.session_limit)}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {!isUser && (items.length > 0 || (message.isStreaming && message.isJsonStreaming)) && (
        <div className="bh-shelf-wrap">
          <div className="bh-shelf-head">
            <h2>{t("Results")}</h2>
            {message.isStreaming && message.isJsonStreaming ? (
              <span className="bh-shelf-live">
                <span className="bh-live-dot" aria-hidden="true" />
                {t("ConfirmingResults", { count: items.length })}
              </span>
            ) : (
              <span>Booth.pm</span>
            )}
          </div>
          <div className="bh-shelf">
            {items.map((item, idx) => (
              <AssetCard
                key={item.id || idx}
                asset={item}
                accent={accents[idx % accents.length]}
              />
            ))}
            {message.isStreaming && message.isJsonStreaming &&
              Array.from({ length: items.length === 0 ? 4 : 3 }).map((_, i) => (
                <AssetCardSkeleton key={`sk-${i}`} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
});

const MessageSkeletonList = ({ count = 6 }: { count?: number }) => {
  return (
    <div style={{ display: 'grid', gap: 26 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bh-msg">
          <div className="bh-msg-avatar">
            <div className="bh-skeleton" style={{ width: '100%', height: '100%' }} />
          </div>
          <div className="bh-msg-body">
            <div className="bh-skeleton" style={{ width: 100, height: 10, marginBottom: 12 }} />
            <div className="bh-skeleton" style={{ width: '78%', height: 14, marginBottom: 8 }} />
            <div className="bh-skeleton" style={{ width: '58%', height: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
};

const App = () => {
  const { t, i18n } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [canStop, setCanStop] = useState(false);
  const [processingTool, setProcessingTool] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const isDesktop = useMediaQuery('(min-width: 861px)');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionMessagesLoading, setSessionMessagesLoading] = useState(false);
  const [messageAnimationNonce, setMessageAnimationNonce] = useState(0);
  const [visitorId, setVisitorId] = useState<string | null>(null);

  useEffect(() => {
    const setFp = async () => {
      try {
        const fp = await FingerprintJS.load();
        const { visitorId: visitorIdVal } = await fp.get();
        setVisitorId(visitorIdVal);
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
  const pushToast = (tIn: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toast: Toast = { id, timeoutMs: 4200, ...tIn };
    setToasts((prev) => [toast, ...prev].slice(0, 4));
    const ms = toast.timeoutMs ?? 4200;
    if (ms > 0) {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== id));
      }, ms);
    }
  };
  const dismissToast = (id: string) => setToasts((prev) => prev.filter((tItem) => tItem.id !== id));

  // Confirm modal (async)
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions>({
    title: t("Confirm"),
    message: '',
    confirmText: t("Confirm"),
    cancelText: t("Cancel"),
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
      pushToast({ type: 'error', title: t("LoadFailed"), message: t("LoadChatsFailedGeneral") });
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
      title: t("DeleteChat"),
      message: t("DeleteChatConfirm"),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
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
      pushToast({ type: 'error', title: t("DeleteFailed"), message: t("DeleteChatFailedGeneral") });
    }
  };

  // --- Chat Logic ---

  const initChat = (keepMessages: boolean = false) => {
    if (!keepMessages) {
      setMessages([{
        id: 'init',
        role: 'model',
        text: `${t("Welcome")}\n\n${t("WelcomeDesc")}`,
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

  const processImageFile = async (file: File) => {
    if (!file || imageProcessing) return;

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
        pushToast({ type: 'error', title: t("ImageReadFailed"), message: t("ImageReadFailedDesc") });
      }
    } finally {
      setImageProcessing(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // reset input value so selecting the same file again triggers onChange
    e.target.value = "";

    if (file) await processImageFile(file);
  };

  // Support pasting a reference image directly into the composer.
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type.startsWith('image/')) continue;

      const file = item.getAsFile();
      if (!file) continue;

      e.preventDefault();
      void processImageFile(file);
      return;
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const token = await getSupabaseAccessToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      } else if (visitorId) {
        headers['x-visitor-id'] = visitorId;
      }

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ 
          messages: updatedMessages, 
          chat_id: sessionId,
          language: i18n.language 
        }),
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
              ? { ...m, text: t("GuestLimitReached"), isStreaming: false, status: undefined, turnMeta }
              : m
            )));
            setIsAuthOpen(true);
            return;
          }

          const base = reason === 'session_limit'
            ? `${t("SessionLimitReached")}（${(data as any)?.session_turn_count}/${formatLimit((data as any)?.session_limit)}）`
            : `${t("DailyLimitReached")}（${(data as any)?.daily_turn_count}/${formatLimit((data as any)?.daily_limit)}）。`;

          const hint = reason === 'session_limit'
            ? `\n\n${t("ClickNewChat")}`
            : '';

          setMessages((prev) => prev.map((m) => (m.id === modelMsgId
            ? { ...m, text: base + hint, isStreaming: false, status: undefined, turnMeta }
            : m
          )));
          return;
        }

        const errMsg = (data as any)?.error || response.statusText || t("LoadFailed");
        setMessages((prev) => prev.map((m) => (m.id === modelMsgId
          ? { ...m, text: errMsg, isStreaming: false, status: undefined, turnMeta }
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

        // 1. 处理所有完整的状态行
        while (true) {
          const idx = streamBuffer.indexOf(STATUS_MARKER);
          if (idx === -1) break;

          const nlIdx = streamBuffer.indexOf("\n", idx);
          if (nlIdx === -1) break; // 标记行收尾没齐，等待后续 chunk

          // 标记之前的都是真实正文
          if (idx > 0) {
            accumulatedText += streamBuffer.slice(0, idx);
          }

          // 提取状态内容
          currentStatus = streamBuffer.slice(idx + STATUS_MARKER.length, nlIdx).trim();
          // 消费掉直到换行符的所有内容
          streamBuffer = streamBuffer.slice(nlIdx + 1);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === modelMsgId ? { ...m, status: currentStatus, text: accumulatedText.trimStart() } : m
            )
          );
        }

        // 2. 检查 buffer 末尾，确定安全刷入正文的边界
        // 不安全的位置定义：出现了完整标记（但没换行）或者标记的开始前缀
        let firstUnsafeIdx = streamBuffer.indexOf(STATUS_MARKER);
        if (firstUnsafeIdx === -1) {
          // 没发现完整标记，再看末尾是否匹配标记前缀（防止标记被从中间切断）
          for (let i = 0; i < streamBuffer.length; i++) {
            if (STATUS_MARKER.startsWith(streamBuffer.slice(i))) {
              firstUnsafeIdx = i;
              break;
            }
          }
        }

        if (firstUnsafeIdx === -1) {
          // 全部安全
          accumulatedText += streamBuffer;
          streamBuffer = "";
        } else if (firstUnsafeIdx > 0) {
          // 刷入不安全位置之前的部分
          accumulatedText += streamBuffer.slice(0, firstUnsafeIdx);
          streamBuffer = streamBuffer.slice(firstUnsafeIdx);
        }

        // 3. 更新 UI (排除开头的 Padding 空格)
        const displayText = accumulatedText.trimStart();
        const maybeJsonStreaming = (displayText + streamBuffer).toLowerCase().includes("```json");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === modelMsgId ? { ...m, text: displayText, isJsonStreaming: maybeJsonStreaming } : m
          )
        );
      }

      // 4. 流结束清理：如果 buffer 里还剩下东西，必须排除掉任何形式的标记残留
      if (streamBuffer) {
        const markerIdx = streamBuffer.indexOf(STATUS_MARKER);
        if (markerIdx === -1) {
          // 没有完整标记，但可能只有标记前缀（如 "__ST"），也需要排除
          let safeToFlush = true;
          for (let i = 0; i < streamBuffer.length; i++) {
            if (STATUS_MARKER.startsWith(streamBuffer.slice(i))) {
              safeToFlush = false;
              // 如果前缀之前有内容，理论上可以刷入，但流结束时的前缀通常意味着异常，直接保守处理
              if (i > 0) accumulatedText += streamBuffer.slice(0, i);
              break;
            }
          }
          if (safeToFlush) accumulatedText += streamBuffer;
        } else {
          // 包含完整标记，只刷入标记前的正文
          if (markerIdx > 0) accumulatedText += streamBuffer.slice(0, markerIdx);
        }
      }
      streamBuffer = "";

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
          const finalTextStopped = partial ? `${partial}\n\n（${t("Stopped")}）` : `（${t("Stopped")}）`;
          setMessages((prev) => prev.map((m) => (m.id === modelMsgId
            ? { ...m, text: finalTextStopped, isStreaming: false, isJsonStreaming: false, status: undefined }
            : m
          )));
          return;
        }
  
        console.error(err);
        const errMsgText = err?.message || t("ErrorOccurred");
        setMessages((prev) => prev.map((m) => (m.id === modelMsgId
          ? { ...m, text: errMsgText, isStreaming: false, isJsonStreaming: false, status: undefined }
          : m
        )));
      } finally {
      chatAbortRef.current = null;
      setCanStop(false);
      setLoading(false);
    }
  };

  const currentTitle = currentSessionId
    ? (sessions.find((s) => s.id === currentSessionId)?.title || t("UntitledChat"))
    : t("NewChat");

  const toggleSidebar = () => {
    if (isDesktop) setSidebarCollapsed((v) => !v);
    else setIsSidebarOpen((v) => !v);
  };

  const sidebarToggleLabel = isDesktop
    ? (sidebarCollapsed ? t("ExpandSidebar") : t("CollapseSidebar"))
    : t("OpenSidebar");

  return (
    <div className={`bh-app ${sidebarCollapsed && isDesktop ? 'is-collapsed' : ''}`}>
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        user={user}
        sessions={sessions}
        sessionsLoading={sessionsLoading}
        collapsed={sidebarCollapsed && isDesktop}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onOpenAuth={() => setIsAuthOpen(true)}
        onDeleteSession={handleDeleteSession}
        totalTurnCount={dailyTurnCount}
        totalTurnLimit={dailyTurnLimit}
        reducedMotion={reducedMotion}
      />

      <div className="bh-main">
        <header className="bh-topbar">
          <div className="bh-topbar-inner">
            <button
              type="button"
              onClick={toggleSidebar}
              className="bh-icon-btn bh-rail-toggle"
              aria-label={sidebarToggleLabel}
              title={sidebarToggleLabel}
            >
              <PanelLeft size={18} />
            </button>

            <div className="bh-session-head">
              <h1>{currentTitle}</h1>
              <div className="bh-session-sub">
                <span className="bh-live-dot" aria-hidden="true" />
                <span>{t("BoothLiveStatus")}</span>
              </div>
            </div>

            <div className="bh-topbar-right">
              {/* Language Switcher */}
              <div className="bh-lang-wrap">
                <button
                  className="bh-lang-btn"
                  aria-label={t("Language")}
                  title={t("Language")}
                >
                  <Globe size={15} />
                  <span className="bh-lang-code">
                    {i18n.language.startsWith('zh') ? t('ZH') : i18n.language.startsWith('ja') ? t('JP') : t('EN')}
                  </span>
                </button>
                <div className="bh-lang-menu">
                  <button
                    type="button"
                    onClick={() => i18n.changeLanguage('zh')}
                    className={i18n.language.startsWith('zh') ? 'is-current' : ''}
                  >
                    {t("ZH")}
                  </button>
                  <button
                    type="button"
                    onClick={() => i18n.changeLanguage('en')}
                    className={i18n.language.startsWith('en') ? 'is-current' : ''}
                  >
                    {t("EN")}
                  </button>
                  <button
                    type="button"
                    onClick={() => i18n.changeLanguage('ja')}
                    className={i18n.language.startsWith('ja') ? 'is-current' : ''}
                  >
                    {t("JP")}
                  </button>
                </div>
              </div>

              {isAdmin && (
                <button
                  onClick={() => setIsAdminPanelOpen(true)}
                  className="bh-icon-btn"
                  aria-label={t("AdminPanel")}
                  title={t("AdminPanel")}
                >
                  <Shield size={17} />
                </button>
              )}

              <a
                href="https://github.com/oniyakun/Booth-Hunter"
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("GithubProject")}
                title="GitHub"
                className="bh-icon-btn bh-github"
              >
                <Github size={17} />
              </a>
            </div>
          </div>
        </header>

        <main
          ref={(el) => {
            // TS: main is HTMLElement
            scrollContainerRef.current = el;
          }}
          onScroll={() => updateIsAtBottom()}
          className="bh-scroller"
        >
          <div className="bh-thread">
            {sessionMessagesLoading ? (
              <div className="bh-chat-col">
                <div className={reducedMotion ? '' : 'bh-anim-fade-up'}>
                  <MessageSkeletonList count={6} />
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div
                  key={`${msg.id}-${messageAnimationNonce}`}
                  className={reducedMotion ? '' : 'bh-anim-fade-up'}
                  style={getStaggerStyle(i, !reducedMotion, 28, 320)}
                >
                  <ChatMessageBubble message={msg} />
                </div>
              ))
            )}

            {(loading && !messages.find(m => m.isStreaming)) && (
              <div className="bh-chat-col">
                <div className="bh-msg">
                  <div className="bh-msg-avatar">
                    <img src="/icon/icon-face-128.png" alt="" />
                  </div>
                  <div className="bh-msg-body">
                    <div className="bh-msg-who"><b>{t("Lili")}</b></div>
                    <div className="bh-status">
                      <span className="bh-status-dot" aria-hidden="true" />
                      <span>{t("Thinking")}</span>
                      <Loader2 size={12} className="animate-spin" style={{ marginLeft: 'auto', color: 'var(--bh-muted)' }} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {processingTool && (
              <div className="bh-chat-col">
                <div className={`bh-tool-call ${reducedMotion ? '' : 'bh-anim-fade-up'}`} style={{ marginLeft: 42 }}>
                  <Hammer size={12} className="animate-bounce" />
                  <span>{t("ToolCalling")}</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        <footer className="bh-composer-wrap">
          <div className="bh-composer-inner">
            {image && (
              <div className="bh-preview-row bh-anim-fade-up">
                <div className="bh-preview">
                  <img src={image} alt="Ref" />
                  <button
                    onClick={() => setImage(null)}
                    className="bh-preview-remove"
                    aria-label={t("RemoveImage")}
                  >
                    <X size={9} />
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="bh-composer">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={imageProcessing || !canUseApp}
                className="bh-attach"
                title="Upload or paste image"
              >
                {imageProcessing ? <Loader2 size={19} className="animate-spin" /> : <ImageIcon size={19} />}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />

              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handlePaste}
                disabled={!canUseApp}
                placeholder={canUseApp ? t("SearchPlaceholder") : (user ? t("VerifyEmail") : t("Loading"))}
                className="bh-composer-input"
              />

              <button
                type={canStop ? "button" : "submit"}
                onClick={canStop ? handleStopGenerating : undefined}
                disabled={!canUseApp || imageProcessing || (!canStop && (loading || (!input.trim() && !image)))}
                className={`bh-send ${canStop ? 'is-stop' : ''}`}
                aria-label={canStop ? t("Stop") : t("Send")}
                title={canStop ? t("Stop") : t("Send")}
              >
                {canStop ? <Pause size={17} /> : <Send size={17} />}
              </button>
            </form>

            <p className="bh-fineprint">{t("Disclaimer")}</p>
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
          <div className="bg-[#17121C] border border-zinc-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-white mb-3">{t("VerifyEmail")}</h2>
            <p className="text-sm text-zinc-400 leading-relaxed mb-5">
              {t("VerifyEmailDesc", { email: user.email })}
            </p>

            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    const { error } = await supabase.auth.resend({ type: "signup", email: user.email });
                    if (error) throw error;
                    pushToast({ type: 'success', title: 'Success', message: 'Resent verification email' });
                  } catch (e: any) {
                    pushToast({ type: 'error', title: 'Error', message: e?.message || 'Failed' });
                  }
                }}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2.5 rounded-lg transition-colors border border-zinc-700"
              >
                {t("ResendEmail")}
              </button>
              <button
                onClick={async () => {
                  // Refresh user to pick up latest confirmation status
                  const { data } = await supabase.auth.getUser();
                  setUser(data.user ?? null);
                }}
                className="bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-bold py-2.5 px-4 rounded-lg transition-colors border border-zinc-700"
                title={t("Refresh")}
              >
                {t("Refresh")}
              </button>
            </div>

            <button
              onClick={async () => {
                await supabase.auth.signOut();
              }}
              className="mt-4 w-full text-sm text-zinc-400 hover:text-white py-2 rounded-lg hover:bg-zinc-900 transition-colors"
            >
              {t("Logout")}
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
            pushToast({ type: 'error', title: t("InputError"), message: e?.message || t("PleaseEnterNumber") });
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
