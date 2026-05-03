import { createClient } from '@supabase/supabase-js';

export const config = {
  runtime: 'edge',
};

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function json(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Admin API:
 * - GET /api/admin/users -> list users (from profiles)
 *
 * Auth:
 * - Requires Authorization: Bearer <access_token>
 * - Checks profiles.is_admin for the caller
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'PATCH') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const supabaseUrl = getEnv('SUPABASE_URL');
    // Admin API 需要 service_role；否则会导致你“未配置也能看全量”的错误期待。
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return json(500, { error: 'Missing env: SUPABASE_SERVICE_ROLE_KEY' });
    }

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
    if (!token) return json(401, { error: 'Missing bearer token' });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return json(401, { error: 'Invalid token' });
    }

    const uid = userRes.user.id;
    const { data: profile, error: profErr } = await admin
      .from('profiles')
      .select('id, email, is_admin')
      .eq('id', uid)
      .maybeSingle();

    if (profErr) return json(500, { error: profErr.message });
    if (!profile?.is_admin) return json(403, { error: 'Forbidden' });

    // PATCH /api/admin/users?id=<uuid>
    // body: { session_turn_limit_override?: number|null, daily_turn_limit_override?: number|null }
    if (req.method === 'PATCH') {
      const url = new URL(req.url);
      const targetId = url.searchParams.get('id');
      if (!targetId) return json(400, { error: 'Missing query param: id' });

      const body = await req.json().catch(() => ({}));
      const patch: any = {};
      if ('session_turn_limit_override' in body) patch.session_turn_limit_override = body.session_turn_limit_override;
      if ('daily_turn_limit_override' in body) patch.daily_turn_limit_override = body.daily_turn_limit_override;

      const { data, error } = await admin
        .from('profiles')
        .update(patch)
        .eq('id', targetId)
        .select('id, email, is_admin, created_at, total_turn_count, daily_turn_count, session_turn_limit_override, daily_turn_limit_override')
        .maybeSingle();

      if (error) return json(500, { error: error.message });
      return json(200, { data });
    }

    // DELETE /api/admin/users?id=<uuid>
    // 行为：删除目标用户的 chats（避免孤儿数据）+ 删除 auth.users（触发 profiles 外键级联删除）
    if (req.method === 'DELETE') {
      const url = new URL(req.url);
      const targetId = url.searchParams.get('id');
      if (!targetId) return json(400, { error: 'Missing query param: id' });

      // 1) 删除该用户 chats（如果 chats.user_id 没有 FK，这一步能保证不会残留）
      const { error: chatsErr } = await admin.from('chats').delete().eq('user_id', targetId);
      if (chatsErr) return json(500, { error: chatsErr.message });

      // 2) 删除 auth 用户（profiles.id references auth.users(id) on delete cascade）
      const { error: delUserErr } = await admin.auth.admin.deleteUser(targetId);
      if (delUserErr) return json(500, { error: delUserErr.message });

      return json(200, { ok: true });
    }

    // 获取排序参数
    const url = new URL(req.url);
    const sortBy = url.searchParams.get('sort_by') || 'created_at';
    const allowedSortFields = ['created_at', 'last_active', 'total_turn_count'];
    const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'created_at';

    let data: any[] = [];
    let error: any = null;

    if (validSortBy === 'last_active') {
      // 按最近活跃排序：需要关联 chats 表获取每个用户的最后活跃时间
      const { data: profilesData, error: profilesError } = await admin
        .from('profiles')
        .select('id, email, is_admin, created_at, total_turn_count, daily_turn_count, session_turn_limit_override, daily_turn_limit_override');
      
      if (profilesError) {
        error = profilesError;
      } else {
        // 获取所有用户的最近活跃时间
        const { data: lastActiveData, error: lastActiveError } = await admin
          .from('chats')
          .select('user_id, updated_at');
        
        if (lastActiveError) {
          error = lastActiveError;
        } else {
          // 构建 user_id -> 最后活跃时间的映射
          const lastActiveMap = new Map<string, string>();
          lastActiveData?.forEach((chat: any) => {
            const current = lastActiveMap.get(chat.user_id);
            if (!current || new Date(chat.updated_at) > new Date(current)) {
              lastActiveMap.set(chat.user_id, chat.updated_at);
            }
          });

          // 合并数据并排序
          data = (profilesData || []).map((p: any) => ({
            ...p,
            last_active: lastActiveMap.get(p.id) || p.created_at
          }));
          
          // 按最近活跃时间降序排序
          data.sort((a: any, b: any) => {
            const aTime = new Date(a.last_active).getTime();
            const bTime = new Date(b.last_active).getTime();
            return bTime - aTime;
          });
        }
      }
    } else {
      // 直接按指定字段排序
      const { data: profilesData, error: profilesError } = await admin
        .from('profiles')
        .select('id, email, is_admin, created_at, total_turn_count, daily_turn_count, session_turn_limit_override, daily_turn_limit_override')
        .order(validSortBy, { ascending: false });
      
      data = profilesData || [];
      error = profilesError;
    }

    if (error) return json(500, { error: error.message });
    return json(200, { data });
  } catch (e: any) {
    return json(500, { error: e?.message || 'Unknown error' });
  }
}
