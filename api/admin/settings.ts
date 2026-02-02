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
 * Admin API: global settings for turn limits
 * - GET   /api/admin/settings                -> current defaults
 * - PATCH /api/admin/settings                -> update defaults
 *
 * Body (PATCH):
 *   { default_session_turn_limit?: number, default_total_turn_limit?: number }
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'PATCH') return new Response('Method Not Allowed', { status: 405 });

  try {
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
    if (!token) return json(401, { error: 'Missing bearer token' });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: 'Invalid token' });

    const uid = userRes.user.id;
    const { data: profile, error: profErr } = await admin
      .from('profiles')
      .select('id, is_admin')
      .eq('id', uid)
      .maybeSingle();
    if (profErr) return json(500, { error: profErr.message });
    if (!profile?.is_admin) return json(403, { error: 'Forbidden' });

    if (req.method === 'PATCH') {
      const body = await req.json().catch(() => ({}));
      const updates: Array<{ key: string; value_bigint: number }> = [];

      if (typeof body.default_session_turn_limit === 'number') {
        updates.push({ key: 'default_session_turn_limit', value_bigint: Math.trunc(body.default_session_turn_limit) });
      }
      if (typeof body.default_total_turn_limit === 'number') {
        updates.push({ key: 'default_total_turn_limit', value_bigint: Math.trunc(body.default_total_turn_limit) });
      }

      if (updates.length === 0) return json(400, { error: 'No valid fields to update' });

      const { error: upErr } = await admin.from('app_settings').upsert(updates);
      if (upErr) return json(500, { error: upErr.message });
    }

    const { data, error } = await admin
      .from('app_settings')
      .select('key, value_bigint')
      .in('key', ['default_session_turn_limit', 'default_total_turn_limit']);
    if (error) return json(500, { error: error.message });

    const map: Record<string, number> = {};
    for (const row of data || []) map[row.key] = Number(row.value_bigint);

    return json(200, {
      data: {
        default_session_turn_limit: map.default_session_turn_limit ?? 50,
        default_total_turn_limit: map.default_total_turn_limit ?? 500,
      },
    });
  } catch (e: any) {
    return json(500, { error: e?.message || 'Unknown error' });
  }
}
