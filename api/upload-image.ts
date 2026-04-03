import { createClient } from "@supabase/supabase-js";

export const config = {
  runtime: "nodejs",
};

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anonymous";
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const mime = match[1].trim().toLowerCase();
  const base64 = match[2].trim();
  const buffer = Buffer.from(base64, "base64");
  return { mime, buffer };
}

function sendJson(res: any, status: number, body: any) {
  res.status(status);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).end("Method Not Allowed");
    return;
  }

  try {
    console.log("[upload-image] request received");

    const supabaseUrl = getEnv("SUPABASE_URL");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const bucket = process.env.SUPABASE_IMAGE_BUCKET || "chat-images";

    const authHeader = String(req.headers?.authorization || "");
    const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
    if (!token) {
      sendJson(res, 401, { error: "Login required for image upload" });
      return;
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error } = await supabase.auth.getUser(token);
    if (error || !authData?.user?.id) {
      sendJson(res, 401, { error: "Invalid token" });
      return;
    }
    const ownerPath = `users/${sanitizePathPart(authData.user.id)}`;

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
    const sessionId = typeof body?.sessionId === "string" ? sanitizePathPart(body.sessionId) : "";
    if (!dataUrl) {
      sendJson(res, 400, { error: "Missing image payload" });
      return;
    }
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing session id" });
      return;
    }

    const { mime, buffer } = parseDataUrl(dataUrl);
    if (!mime.startsWith("image/")) {
      sendJson(res, 400, { error: "Only image files are supported" });
      return;
    }
    if (buffer.byteLength > 8 * 1024 * 1024) {
      sendJson(res, 400, { error: "Image too large" });
      return;
    }

    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    const objectPath = `${ownerPath}/${sessionId}/${crypto.randomUUID()}.${ext}`;

    console.log("[upload-image] uploading", { bucket, objectPath, mime, bytes: buffer.byteLength });

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, buffer, {
        contentType: mime,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("[upload-image] storage upload failed:", uploadError.message);
      sendJson(res, 500, { error: uploadError.message });
      return;
    }

    const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    if (!publicUrlData?.publicUrl) {
      sendJson(res, 500, { error: "Failed to create public URL" });
      return;
    }

    console.log("[upload-image] success", { publicUrl: publicUrlData.publicUrl });
    sendJson(res, 200, { publicUrl: publicUrlData.publicUrl, path: objectPath, bucket });
  } catch (e: any) {
    console.error("[upload-image] fatal:", e?.message || e);
    sendJson(res, 500, { error: e?.message || "Unknown error" });
  }
}
