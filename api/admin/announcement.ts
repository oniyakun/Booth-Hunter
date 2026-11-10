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

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Admin API: single announcement (singleton row id=1)
 * - GET /api/admin/announcement -> { data: Announcement | null }
 * - PUT /api/admin/announcement -> save and publish immediately
 * - DELETE /api/admin/announcement -> clear the announcement
 *
 * PUT body:
 *   { title, body, publish_at, expires_at }
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'DELETE') {
    return new Response('Method Not Allowed', { status: 405 });
  }

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

    const { data: profile, error: profErr } = await admin
      .from('profiles')
      .select('id, is_admin')
      .eq('id', userRes.user.id)
      .maybeSingle();
    if (profErr) return json(500, { error: profErr.message });
    if (!profile?.is_admin) return json(403, { error: 'Forbidden' });

    if (req.method === 'GET') {
      const { data, error } = await admin
        .from('announcement')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
      if (error) return json(500, { error: error.message });
      return json(200, { data: data ?? null });
    }

    if (req.method === 'DELETE') {
      const { data, error } = await admin
        .from('announcement')
        .update({
          title: '',
          body: '',
          is_published: false,
          publish_at: new Date().toISOString(),
          expires_at: null,
        })
        .eq('id', 1)
        .select('id')
        .maybeSingle();
      if (error) return json(500, { error: error.message });
      if (!data) return json(404, { error: 'Not found' });
      return json(200, { ok: true });
    }

    const payload = await req.json().catch(() => ({}));

    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (title.length > MAX_TITLE_LENGTH) return json(400, { error: 'Title is too long' });
    if (body.length > MAX_BODY_LENGTH) return json(400, { error: 'Body is too long' });
    if (!title) return json(400, { error: 'Title is required' });
    if (!body) return json(400, { error: 'Body is required' });

    let publishAt = new Date().toISOString();
    if (payload.publish_at != null && payload.publish_at !== '') {
      const parsed = parseDate(payload.publish_at);
      if (!parsed) return json(400, { error: 'Invalid publish_at' });
      publishAt = parsed;
    }

    let expiresAt: string | null = null;
    if (payload.expires_at != null && payload.expires_at !== '') {
      const parsed = parseDate(payload.expires_at);
      if (!parsed) return json(400, { error: 'Invalid expires_at' });
      expiresAt = parsed;
    }

    if (expiresAt && new Date(expiresAt).getTime() <= new Date(publishAt).getTime()) {
      return json(400, { error: 'expires_at must be after publish_at' });
    }

    const { data, error } = await admin
      .from('announcement')
      .upsert(
        {
          id: 1,
          title,
          body,
          is_published: true,
          publish_at: publishAt,
          expires_at: expiresAt,
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();

    if (error) return json(500, { error: error.message });
    return json(200, { data });
  } catch (e: any) {
    return json(500, { error: e?.message || 'Unknown error' });
  }
}
