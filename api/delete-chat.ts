import { createClient } from "@supabase/supabase-js";
import { deleteSessionFolder, deleteStoragePaths, extractStoragePathsFromMessages } from "./_lib/storageCleanup";

export const config = {
  runtime: "edge",
};

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function json(status: number, body: any): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "DELETE") return new Response("Method Not Allowed", { status: 405 });

  try {
    const supabaseUrl = getEnv("SUPABASE_URL");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = process.env.SUPABASE_IMAGE_BUCKET || "chat-images";

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
    if (!token) return json(401, { error: "Missing bearer token" });

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user?.id) return json(401, { error: "Invalid token" });

    const url = new URL(req.url);
    const chatId = url.searchParams.get("id");
    if (!chatId) return json(400, { error: "Missing query param: id" });

    const { data: chat, error: chatErr } = await admin
      .from("chats")
      .select("id, user_id, messages")
      .eq("id", chatId)
      .eq("user_id", userRes.user.id)
      .maybeSingle();

    if (chatErr) return json(500, { error: chatErr.message });
    if (!chat) return json(404, { error: "Chat not found" });

    const messagePaths = extractStoragePathsFromMessages((chat as any).messages, bucket);
    await deleteStoragePaths(admin, bucket, messagePaths);
    await deleteSessionFolder(admin, bucket, `users/${userRes.user.id}/${chatId}`);

    const { error: deleteErr } = await admin.from("chats").delete().eq("id", chatId).eq("user_id", userRes.user.id);
    if (deleteErr) return json(500, { error: deleteErr.message });

    return json(200, { ok: true, deleted_paths: messagePaths.length });
  } catch (e: any) {
    return json(500, { error: e?.message || "Unknown error" });
  }
}
