// PROTOTYPE (throwaway) for wayfinder ticket #20: Notification Feed as a kanban board
// (mix of variant B's full page and variant C's summary strip), backed by the real Knock feed.
// Delete after the decision.
import { useEffect, useMemo } from "react";
import { Link, data, useFetcher } from "react-router";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { z } from "zod";
import { Bell } from "lucide-react";
import type { Route } from "./+types/prototype.notification-feed";
import { getCurrentUserId } from "~/lib/session";
import { fetchFeed, getKnockConfig, markSeen, setRead, type KnockFeedItem } from "~/lib/knock.server";
import { cn } from "~/lib/utils";

const CATEGORY_LABEL: Record<string, string> = {
  "refund-request": "Refund request",
  "refund-outcome": "Refund outcome",
  "team-seat-claim": "Team seat",
  "lesson-comment": "Comment",
  "lesson-reply": "Reply",
  "new-lesson": "New lesson",
};

type ColumnId = "new" | "unread" | "read";
const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "new", label: "New" },
  { id: "unread", label: "Unread" },
  { id: "read", label: "Read" },
];

function columnOf(item: KnockFeedItem): ColumnId {
  if (item.readAt) return "read";
  if (item.seenAt) return "unread";
  return "new";
}

function timeAgo(iso: string) {
  const mins = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
}

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("seen"), ids: z.array(z.string()).max(100) }),
  z.object({ intent: z.literal("read"), id: z.string() }),
  z.object({ intent: z.literal("unread"), id: z.string() }),
]);

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) return { configured: !!getKnockConfig(), signedIn: false, items: [] as KnockFeedItem[], error: null as string | null };
  if (!getKnockConfig()) return { configured: false, signedIn: true, items: [] as KnockFeedItem[], error: null };
  try {
    const items = await fetchFeed(userId);
    return { configured: true, signedIn: true, items, error: null };
  } catch (err) {
    return { configured: true, signedIn: true, items: [] as KnockFeedItem[], error: err instanceof Error ? err.message : "Knock error" };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw data("Select a user first", { status: 401 });
  const form = await request.formData();
  const raw = form.get("payload");
  const parsed = ActionSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : "null"));
  if (!parsed.success) throw data("Bad action", { status: 400 });
  const payload = parsed.data;
  if (payload.intent === "seen") await markSeen(payload.ids);
  if (payload.intent === "read") await setRead(payload.id, true);
  if (payload.intent === "unread") await setRead(payload.id, false);
  return { ok: true };
}

export default function PrototypeNotificationFeed({ loaderData }: Route.ComponentProps) {
  const { configured, signedIn, items, error } = loaderData;
  const fetcher = useFetcher();

  const byColumn = useMemo(() => {
    const map: Record<ColumnId, KnockFeedItem[]> = { new: [], unread: [], read: [] };
    for (const item of items) map[columnOf(item)].push(item);
    return map;
  }, [items]);

  // Opening the feed marks everything it shows as seen (clears the badge; reads stay unread).
  const unseenIds = useMemo(() => items.filter((i) => !i.seenAt).map((i) => i.id), [items]);
  useEffect(() => {
    if (unseenIds.length === 0 || fetcher.state !== "idle") return;
    fetcher.submit({ payload: JSON.stringify({ intent: "seen", ids: unseenIds }) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseenIds.join(",")]);

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;
    if (!destination || destination.droppableId === source.droppableId) return;
    if (destination.droppableId === "read") {
      fetcher.submit({ payload: JSON.stringify({ intent: "read", id: draggableId }) }, { method: "post" });
    } else if (destination.droppableId === "unread" && source.droppableId === "read") {
      fetcher.submit({ payload: JSON.stringify({ intent: "unread", id: draggableId }) }, { method: "post" });
    }
    // Dragging back to "new" is not allowed: a Notification can't become unseen from here.
  };

  if (!signedIn) {
    return <Notice>Select a user in the DevUI to see their Notification Feed.</Notice>;
  }
  if (!configured) {
    return (
      <Notice>
        Knock isn't configured. Set <code>KNOCK_FEED_CHANNEL_ID</code> in <code>.env</code> (the in-app channel id) and restart.
      </Notice>
    );
  }
  if (error) return <Notice>Knock request failed: {error}</Notice>;

  const newCount = byColumn.new.length;
  const unreadTotal = byColumn.new.length + byColumn.unread.length;

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* Variant C idea: a summary strip of what's new, above the board. */}
      <div className="flex items-center justify-between rounded-lg border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bell className="size-4" /> Notifications
          {unreadTotal > 0 && <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">{unreadTotal} unread</span>}
        </div>
        <span className="text-xs text-muted-foreground">
          {newCount > 0 ? `${newCount} new since you last looked` : "You're all caught up"}
        </span>
      </div>

      {/* Variant B idea: full page, here as a kanban board. Drag a card to Read to mark it read. */}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <Droppable droppableId={col.id} key={col.id}>
              {(provided, snapshot) => (
                <section
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={cn("flex min-h-64 flex-col gap-2 rounded-lg border bg-muted/30 p-3", snapshot.isDraggingOver && "ring-2 ring-blue-400")}
                >
                  <header className="flex items-center justify-between px-1 text-sm font-semibold">
                    {col.label}
                    <span className="text-xs text-muted-foreground">{byColumn[col.id].length}</span>
                  </header>
                  {byColumn[col.id].map((item, index) => (
                    <Draggable draggableId={item.id} index={index} key={item.id}>
                      {(dragProvided, dragSnapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          className={cn("rounded-md border bg-background p-3 shadow-sm", dragSnapshot.isDragging && "shadow-lg")}
                        >
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>{CATEGORY_LABEL[item.category] ?? item.category}</span>
                            <span>{timeAgo(item.insertedAt)}</span>
                          </div>
                          <Link
                            to={item.href}
                            onClick={() => {
                              if (!item.readAt) fetcher.submit({ payload: JSON.stringify({ intent: "read", id: item.id }) }, { method: "post" });
                            }}
                            className="mt-1 block text-sm font-medium hover:underline"
                          >
                            {item.title}
                          </Link>
                          <div className="mt-0.5 text-xs text-muted-foreground">{item.body}</div>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                  {byColumn[col.id].length === 0 && <p className="px-1 text-xs text-muted-foreground">Nothing here.</p>}
                </section>
              )}
            </Droppable>
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="p-6 text-sm text-muted-foreground">{children}</div>;
}
