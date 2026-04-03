type ChatMessageLike = {
  image?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractStoragePathsFromMessages(messages: ChatMessageLike[] | null | undefined, bucket: string): string[] {
  if (!Array.isArray(messages) || !bucket) return [];

  const patterns = [
    new RegExp(`/storage/v1/object/public/${escapeRegExp(bucket)}/(.+)$`),
    new RegExp(`/storage/v1/object/sign/${escapeRegExp(bucket)}/(.+?)(?:\\?|$)`),
  ];

  const out = new Set<string>();
  for (const message of messages) {
    const image = typeof message?.image === "string" ? message.image.trim() : "";
    if (!image) continue;
    for (const pattern of patterns) {
      const match = image.match(pattern);
      if (!match?.[1]) continue;
      out.add(decodeURIComponent(match[1]));
      break;
    }
  }

  return Array.from(out);
}

export async function deleteStoragePaths(
  client: any,
  bucket: string,
  paths: string[]
): Promise<void> {
  const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
  if (!uniquePaths.length) return;

  const { error } = await client.storage.from(bucket).remove(uniquePaths);
  if (error) throw error;
}

export async function deleteSessionFolder(
  client: any,
  bucket: string,
  prefix: string
): Promise<void> {
  if (!prefix) return;

  const pendingFolders: string[] = [prefix];
  const filePaths: string[] = [];

  while (pendingFolders.length > 0) {
    const current = pendingFolders.pop()!;
    const { data, error } = await client.storage.from(bucket).list(current, {
      limit: 1000,
      offset: 0,
    });
    if (error) throw error;

    for (const entry of data || []) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (!name) continue;

      const meta = (entry as any)?.metadata;
      const isFolder = !meta;
      const fullPath = `${current}/${name}`;

      if (isFolder) pendingFolders.push(fullPath);
      else filePaths.push(fullPath);
    }
  }

  if (filePaths.length > 0) {
    const { error } = await client.storage.from(bucket).remove(filePaths);
    if (error) throw error;
  }
}
