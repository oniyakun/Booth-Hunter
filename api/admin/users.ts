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
  if (req.method !== 'GET' && req.method !== 'DELETE') return new Response('Method Not Allowed', { status: 405 });

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

    const { data, error } = await admin
      .from('profiles')
      .select('id, email, is_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) return json(500, { error: error.message });
    return json(200, { data });
  } catch (e: any) {
    return json(500, { error: e?.message || 'Unknown error' });
  }
}
