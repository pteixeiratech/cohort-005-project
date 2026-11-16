import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { RefundOutcome, RefundStatus, UserRole } from "~/db/schema";
import { fakeNotifications, type FakeNotifications } from "~/lib/notifications.fake.server";
import { sendEmail } from "~/lib/mailer.server";
import { action, loader } from "./admin.refunds";

// The route reads the database, the session and the Notifications adapter from
// module singletons. Each test swaps in its own in-memory database, signed-in
// user and fake Notifications through this shared state.
const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as number | null,
  notifications: null as unknown,
}));

vi.mock("~/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("~/lib/session", () => ({
  getCurrentUserId: async () => state.userId,
}));

vi.mock("~/lib/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/notifications.server")>()),
  defaultNotifications: async () => state.notifications,
}));

vi.mock("~/lib/mailer.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/mailer.server")>()),
  sendEmail: vi.fn(async () => {}),
}));

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let platformAdmin: typeof schema.users.$inferSelect;
let notifications: FakeNotifications;

beforeEach(() => {
  vi.stubEnv("NOTIFICATION_EMAIL_FROM", "Notifications <sender@example.test>");
  vi.stubEnv("APP_URL", "https://cadence.test");
  vi.mocked(sendEmail).mockClear();

  db = createTestDb();
  state.db = db;
  notifications = fakeNotifications();
  state.notifications = notifications;
  base = seedBaseData(db);

  platformAdmin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();
  state.userId = platformAdmin.id;
});

function addUser(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase().replace(" ", "-")}@example.com`, role })
    .returning()
    .get();
}

/** An Individual Purchase with its Enrollment, and a Refund Request in `status`. */
function refundRequestIn(status: RefundStatus) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date(2026, 9, 3).toISOString(),
    })
    .returning()
    .get();

  return db
    .insert(schema.refunds)
    .values({
      purchaseId: purchase.id,
      status,
      reason: "It was not what I expected.",
      requestedAt: new Date(2026, 9, 6).toISOString(),
    })
    .returning()
    .get().id;
}

function outcomeOf(id: number) {
  return db
    .select()
    .from(schema.refunds)
    .where(eq(schema.refunds.id, id))
    .get()?.refundOutcome;
}

function postAction(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const request = new Request("https://cadence.test/admin/refunds", {
    method: "POST",
    body,
  });
  return { request, params: {}, context: {} } as unknown as Parameters<
    typeof action
  >[0];
}

function getLoader(search: string) {
  const url = new URL(`https://cadence.test/admin/refunds${search}`);
  const request = new Request(url);
  return { request, url, params: {}, context: {} } as unknown as Parameters<
    typeof loader
  >[0];
}

/** The status of a thrown or returned `data()` response, or undefined. */
function statusOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && "init" in value) {
    const init = value.init;
    if (init && typeof init === "object" && "status" in init) {
      return typeof init.status === "number" ? init.status : undefined;
    }
  }
  return undefined;
}

async function statusOfRejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (thrown) {
    return statusOf(thrown);
  }
  throw new Error("Expected the action to throw");
}

describe("recording the outcome of an approved Refund", () => {
  it("marks an approved Refund Issued and emails the buyer", async () => {
    const id = refundRequestIn(RefundStatus.Approved);

    const result = await action(postAction({ intent: "issued", refundRequestId: String(id) }));

    expect(result).toMatchObject({ success: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@example.com",
        subject: "Your refund for Test Course has been issued",
      })
    );
  });

  it("marks an approved Refund Failed and emails every other Platform Admin, not the one who recorded it", async () => {
    const sam = addUser("Sam Admin", UserRole.Admin);
    const id = refundRequestIn(RefundStatus.Approved);

    const result = await action(postAction({ intent: "failed", refundRequestId: String(id) }));

    expect(result).toMatchObject({ success: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Failed);
    const sentTo = vi.mocked(sendEmail).mock.calls.map(([email]) => email.to);
    expect(sentTo).toEqual([sam.email]);
    expect(notifications.sent.map((n) => n.recipient.id)).toEqual([sam.id]);
  });

  it("refuses to mark an Open Refund, and sends nothing", async () => {
    const id = refundRequestIn(RefundStatus.Open);

    const result = await action(postAction({ intent: "issued", refundRequestId: String(id) }));

    expect(statusOf(result)).toBe(409);
    expect(outcomeOf(id)).toBeNull();
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("refuses to mark a Declined Refund Failed, and sends nothing", async () => {
    const id = refundRequestIn(RefundStatus.Declined);

    const result = await action(postAction({ intent: "failed", refundRequestId: String(id) }));

    expect(statusOf(result)).toBe(409);
    expect(outcomeOf(id)).toBeNull();
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("refuses a student, before reading the form", async () => {
    const id = refundRequestIn(RefundStatus.Approved);
    state.userId = base.user.id;

    const status = await statusOfRejection(
      Promise.resolve(action(postAction({ intent: "issued", refundRequestId: String(id) })))
    );

    expect(status).toBe(403);
    expect(outcomeOf(id)).toBeNull();
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("refuses a visitor with no user selected", async () => {
    const id = refundRequestIn(RefundStatus.Approved);
    state.userId = null;

    const status = await statusOfRejection(
      Promise.resolve(action(postAction({ intent: "failed", refundRequestId: String(id) })))
    );

    expect(status).toBe(401);
    expect(outcomeOf(id)).toBeNull();
  });
});

describe("the Refund Requests page reads the link from a Failed email", () => {
  it("shows the Approved filter and highlights the Refund Request named in the link", async () => {
    const id = refundRequestIn(RefundStatus.Approved);

    const result = await loader(getLoader(`?status=approved&refund=${id}`));

    expect(result.status).toBe(RefundStatus.Approved);
    expect(result.highlightedRefundId).toBe(id);
    expect(result.refundRequests.map((r) => r.id)).toEqual([id]);
  });

  it("ignores a refund parameter that is not a Refund Request id", async () => {
    refundRequestIn(RefundStatus.Open);

    const result = await loader(getLoader("?refund=not-a-number"));

    expect(result.highlightedRefundId).toBeUndefined();
    expect(result.status).toBe(RefundStatus.Open);
  });
});
