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
 * - GET /api/admin/chats                -> list chats across all users
 * - GET /api/admin/chats?user_id=uuid   -> list chats for a user
 * - GET /api/admin/chats?id=uuid        -> get one chat (including messages)
 *
 * Auth:
 * - Requires Authorization: Bearer <access_token>
 * - Checks profiles.is_admin for the caller
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'DELETE') return new Response('Method Not Allowed', { status: 405 });

  try {
    const supabaseUrl = getEnv('SUPABASE_URL');
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

    // Validate token -> user id
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

    if (profErr) {
      return json(500, { error: profErr.message });
    }
    if (!profile?.is_admin) {
      return json(403, { error: 'Forbidden' });
    }

    const url = new URL(req.url);
    const chatId = url.searchParams.get('id');
    const userId = url.searchParams.get('user_id');

    // DELETE /api/admin/chats?id=<uuid>
    if (req.method === 'DELETE') {
      if (!chatId) return json(400, { error: 'Missing query param: id' });
      const { error } = await admin.from('chats').delete().eq('id', chatId);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }

    if (chatId) {
      const { data, error } = await admin
        .from('chats')
        .select('id, user_id, title, turn_count, messages, created_at, updated_at')
        .eq('id', chatId)
        .maybeSingle();
      if (error) return json(500, { error: error.message });
      return json(200, { data });
    }

    let q = admin
      .from('chats')
      .select('id, user_id, title, turn_count, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (userId) q = q.eq('user_id', userId);

    const { data, error } = await q;
    if (error) return json(500, { error: error.message });
    return json(200, { data });
  } catch (e: any) {
    return json(500, { error: e?.message || 'Unknown error' });
  }
}
