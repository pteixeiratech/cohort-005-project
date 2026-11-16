// PROTOTYPE (wayfinder ticket #20): thin server-side client for the Knock REST API.
// Uses the development secret key from .env. Not production auth: production needs
// signed user tokens (see Knock's feed auth docs) before a browser may call Knock.
import { z } from "zod";

const BASE_URL = "https://api.knock.app";

const FeedItemSchema = z.object({
  id: z.string(),
  inserted_at: z.string(),
  read_at: z.string().nullable().optional(),
  seen_at: z.string().nullable().optional(),
  source: z.object({ key: z.string() }).partial().optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});

const FeedResponseSchema = z.object({
  entries: z.array(FeedItemSchema),
});

export interface KnockFeedItem {
  id: string;
  category: string;
  title: string;
  body: string;
  href: string;
  insertedAt: string;
  readAt: string | null;
  seenAt: string | null;
}

export function getKnockConfig() {
  const secret = process.env.KNOCK_SECRET_API_KEY;
  const channelId = process.env.KNOCK_FEED_CHANNEL_ID;
  if (!secret || !channelId) return null;
  return { secret, channelId };
}

function authHeaders(secret: string) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

function str(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export async function fetchFeed(userId: number): Promise<KnockFeedItem[]> {
  const config = getKnockConfig();
  if (!config) throw new Error("Knock is not configured (KNOCK_FEED_CHANNEL_ID missing)");

  const res = await fetch(
    `${BASE_URL}/v1/users/${encodeURIComponent(String(userId))}/feeds/${encodeURIComponent(config.channelId)}?page_size=50&mode=compact`,
    { headers: authHeaders(config.secret) }
  );
  if (!res.ok) throw new Error(`Knock feed request failed: HTTP ${res.status}`);

  const parsed = FeedResponseSchema.parse(await res.json());
  return parsed.entries.map((entry) => {
    const data = entry.data ?? {};
    return {
      id: entry.id,
      category: str(entry.source?.key, "unknown"),
      title: str(data.title, "Notification"),
      body: str(data.body, ""),
      href: str(data.href, "/dashboard"),
      insertedAt: entry.inserted_at,
      readAt: entry.read_at ?? null,
      seenAt: entry.seen_at ?? null,
    };
  });
}

export async function markSeen(messageIds: string[]) {
  const config = getKnockConfig();
  if (!config || messageIds.length === 0) return;
  const res = await fetch(`${BASE_URL}/v1/messages/batch/seen`, {
    method: "POST",
    headers: authHeaders(config.secret),
    body: JSON.stringify({ message_ids: messageIds }),
  });
  if (!res.ok) throw new Error(`Knock mark-seen failed: HTTP ${res.status}`);
}

export async function setRead(messageId: string, read: boolean) {
  const config = getKnockConfig();
  if (!config) return;
  const res = await fetch(`${BASE_URL}/v1/messages/${encodeURIComponent(messageId)}/read`, {
    method: read ? "PUT" : "DELETE",
    headers: authHeaders(config.secret),
  });
  if (!res.ok) throw new Error(`Knock mark-read failed: HTTP ${res.status}`);
}
