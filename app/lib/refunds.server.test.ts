import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  LessonProgressStatus,
  RefundOutcome,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  approveRefundRequest,
  checkRefundRequest,
  declineRefundRequest,
  getRefundOffer,
  getSeatAvailability,
  listRefundRequestsForBuyer,
  listRefundRequestsForReview,
  listTeamLicences,
  markRefundFailed,
  markRefundIssued,
  raiseRefundRequest,
} from "./refunds.server";
import {
  fakeNotifications,
  type FakeNotifications,
} from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

// The sender and link base the Notification emails use. Set here, never read
// from the environment, so tests need no configuration.
const EMAIL_CONFIG = {
  from: "Notifications <sender@example.test>",
  appUrl: "https://cadence.test",
};

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let platformAdmin: typeof schema.users.$inferSelect;
let lessonIds: number[];
let notifications: FakeNotifications;

beforeEach(() => {
  db = createTestDb();
  notifications = fakeNotifications();
  base = seedBaseData(db);

  platformAdmin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function buyForSelf(userId: number, daysAgo = 3, amountPaid = 7900) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats(userId: number, seats: number, daysAgo = 3) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  const seatRows = Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats: seatRows };
}

function claimSeat(seatId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: daysBefore(1) })
    .where(eq(schema.coupons.id, seatId))
    .run();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

async function raise(purchaseId: number, buyerId: number) {
  const result = await raiseRefundRequest(
    db,
    purchaseId,
    buyerId,
    "It was not what I expected.",
    NOW,
    notifications
  );
  if (!result.ok) throw new Error(result.error);
  return result.refundRequestId;
}

function getSeat(seatId: number) {
  const seat = db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
  if (!seat) throw new Error("Seat not found");
  return seat;
}

describe("raising a Refund Request", () => {
  it("lets the buyer raise one on an Individual Purchase inside the window", async () => {
    const purchase = buyForSelf(base.user.id);

    const result = await raiseRefundRequest(db, purchase.id, base.user.id, "Nope.", NOW, notifications);

    expect(result).toMatchObject({ ok: true, kind: "individual_purchase" });
  });

  it("refuses anyone but the buyer", () => {
    const purchase = buyForSelf(base.user.id);
    const someoneElse = addStudent("Ben");

    expect(checkRefundRequest(db, purchase.id, someoneElse.id, NOW)).toMatchObject(
      { ok: false, status: 404 }
    );
  });

  it("allows only one Open Refund Request per Purchase", async () => {
    const purchase = buyForSelf(base.user.id);
    await raise(purchase.id, base.user.id);

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 409 }
    );
  });

  it("keeps the fourteenth day open and closes the fifteenth", () => {
    const onDay14 = buyForSelf(base.user.id, 14);
    const onDay15 = buyForSelf(addStudent("Ben").id, 15);

    expect(checkRefundRequest(db, onDay14.id, onDay14.userId, NOW).ok).toBe(true);
    expect(
      checkRefundRequest(db, onDay15.id, onDay15.userId, NOW)
    ).toMatchObject({ ok: false, error: "The 14-day window has closed." });
  });

  it("refuses a buyer who has completed half the lessons", () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 403 }
    );
  });

  it("refuses a buyer who has watched two hours", () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.videoWatchEvents)
      .values([
        { userId: base.user.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 3600 },
        { userId: base.user.id, lessonId: lessonIds[1], eventType: "progress", positionSeconds: 3600 },
      ])
      .run();

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 403 }
    );
  });

  it("refuses a Team Licence with a Claimed Seat", () => {
    const teamAdmin = addStudent("Priya");
    const { purchase, seats } = buySeats(teamAdmin.id, 3);
    claimSeat(seats[0].id, addStudent("Ben").id);

    expect(checkRefundRequest(db, purchase.id, teamAdmin.id, NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("the Refund outcome", () => {
  it("records an approved Refund as Issued or Failed, leaving the Refund Request approved", () => {
    const purchase = buyForSelf(base.user.id);

    const [issued, failed, untouched] = [
      RefundOutcome.Issued,
      RefundOutcome.Failed,
      null,
    ].map((refundOutcome) =>
      db
        .insert(schema.refunds)
        .values({
          purchaseId: purchase.id,
          status: RefundStatus.Approved,
          reason: "Test",
          refundOutcome,
        })
        .returning()
        .get()
    );

    expect(issued).toMatchObject({
      status: RefundStatus.Approved,
      refundOutcome: "issued",
    });
    expect(failed).toMatchObject({
      status: RefundStatus.Approved,
      refundOutcome: "failed",
    });
    expect(untouched).toMatchObject({
      status: RefundStatus.Approved,
      refundOutcome: null,
    });
  });
});

describe("the refund offer on the course page", () => {
  it("offers the newest Individual Purchase, not a newer Team Licence", () => {
    const individual = buyForSelf(base.user.id, 3);
    buySeats(base.user.id, 5, 1);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toMatchObject({
      purchaseId: individual.id,
      amount: 7900,
    });
  });

  it("offers nothing once the purchase has been refunded", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toBeNull();
  });
});

describe("approving a Refund Request", () => {
  it("removes the buyer's Enrollment but keeps their progress", async () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        status: LessonProgressStatus.Completed,
      })
      .run();
    const id = await raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(result.ok).toBe(true);
    expect(isEnrolled(base.user.id)).toBe(false);
    expect(
      db
        .select()
        .from(schema.lessonProgress)
        .where(eq(schema.lessonProgress.userId, base.user.id))
        .all()
    ).toHaveLength(1);

    const refundRequest = db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
    expect(refundRequest).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: platformAdmin.id,
    });
  });

  it("keeps the buyer's Enrollment if they also hold a Claimed Seat for the course", async () => {
    const priya = addStudent("Priya");
    const { seats } = buySeats(priya.id, 2);
    // Liam claims a Seat first, so his Enrollment came from it.
    claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const id = await raise(purchase.id, base.user.id);

    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("makes a Team Licence's Unclaimed Seats unclaimable", async () => {
    const priya = addStudent("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);

    const result = await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(result.ok).toBe(true);
    for (const seat of seats) {
      expect(getSeatAvailability(db, getSeat(seat.id))).toBe("refunded");
    }
  });

  it("refuses a Team Licence whose Seat was claimed after the request", async () => {
    const priya = addStudent("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);
    // Seats are on hold while Open, but older data can still hold a claim.
    claimSeat(seats[0].id, addStudent("Ben").id);

    expect(await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(getSeatAvailability(db, getSeat(seats[1].id))).toBe("on_hold");
  });

  it("lets the first decision win", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(
      await declineRefundRequest(db, id, platformAdmin.id, "Too late.", NOW, notifications)
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "This refund request was already approved.",
    });
  });

  it("emails the buyer that the refund is on its way", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    if (!result.ok) throw new Error(result.error);
    expect(result.email.to).toBe("test@example.com");
    expect(result.email.subject).toBe("Refund approved — Test Course");
    expect(result.email.body).toContain("$79.00");
  });
});

describe("declining a Refund Request", () => {
  it("needs a note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    expect(await declineRefundRequest(db, id, platformAdmin.id, "  ", NOW, notifications)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("keeps the buyer's Enrollment and lets them raise a new Refund Request", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    const result = await declineRefundRequest(
      db,
      id,
      platformAdmin.id,
      "You finished the course.",
      NOW,
      notifications
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.email.body).toContain("You finished the course.");
    expect(isEnrolled(base.user.id)).toBe(true);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW).ok).toBe(true);
  });

  it("frees a Team Licence's Seats again", async () => {
    const priya = addStudent("Priya");
    const { purchase, seats } = buySeats(priya.id, 1);
    const id = await raise(purchase.id, priya.id);
    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("on_hold");

    await declineRefundRequest(db, id, platformAdmin.id, "Seats are in use.", NOW, notifications);

    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("available");
  });
});

describe("listing Refund Requests", () => {
  it("shows a Platform Admin live figures and the rules a request breaks", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    // Since raising the request, the buyer has finished half the course.
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row).toMatchObject({
      id,
      buyerName: "Test User",
      daysSincePurchase: 3,
      figures: {
        kind: "individual_purchase",
        lessonsCompleted: 2,
        lessonCount: 4,
      },
      ruleBreaks: ["completed_too_much"],
      canApprove: true,
    });
  });

  it("shows a Team Licence's Seats instead of the buyer's progress", async () => {
    const priya = addStudent("Priya");
    const { purchase } = buySeats(priya.id, 3);
    await raise(purchase.id, priya.id);

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row.figures).toEqual({
      kind: "team_licence",
      seatCount: 3,
      claimedSeatCount: 0,
    });
  });

  it("lists only the requested status, oldest first", async () => {
    const first = buyForSelf(base.user.id);
    const ben = addStudent("Ben");
    const second = buyForSelf(ben.id);
    const firstId = await raise(first.id, base.user.id);
    const secondId = await raiseRefundRequest(
      db,
      second.id,
      ben.id,
      "Changed my mind.",
      new Date(NOW.getTime() + 60_000),
      notifications
    );
    if (!secondId.ok) throw new Error(secondId.error);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, NOW).map((r) => r.id)
    ).toEqual([firstId, secondId.refundRequestId]);

    await approveRefundRequest(db, firstId, platformAdmin.id, null, NOW, notifications);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Approved, NOW)
    ).toMatchObject([{ id: firstId, decidedByName: "Pat Admin" }]);
  });

  it("shows a buyer their decided requests with the decline note", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await declineRefundRequest(db, id, platformAdmin.id, "Past half way.", NOW, notifications);

    expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
      { id, status: RefundStatus.Declined, decisionNote: "Past half way." },
    ]);
  });

  it("lists a Team Admin's Team Licences and whether each can be refunded", () => {
    const priya = addStudent("Priya");
    buySeats(priya.id, 2);
    const { seats } = buySeats(priya.id, 2);
    claimSeat(seats[0].id, addStudent("Ben").id);

    expect(listTeamLicences(db, priya.id, NOW)).toMatchObject([
      { seatCount: 2, claimedSeatCount: 1, canRequestRefund: false },
      { seatCount: 2, claimedSeatCount: 0, canRequestRefund: true },
    ]);
  });
});

describe("the Refund Request Notifications", () => {
  const testUser = {
    name: "Test User",
    email: "test@example.com",
    avatarUrl: null,
  };

  function sentOf(kind: string) {
    return notifications.sent.filter((n) => n.kind === kind);
  }

  it("tells every Platform Admin, and nobody else, about the Open Refund Request", async () => {
    const sam = db
      .insert(schema.users)
      .values({ name: "Sam Admin", email: "sam@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const purchase = buyForSelf(base.user.id, 3, 7900);

    const id = await raise(purchase.id, base.user.id);

    const open = sentOf("refund-request-open");
    expect(open.map((n) => n.recipient.id).sort()).toEqual(
      [platformAdmin.id, sam.id].sort()
    );
    expect(open[0]).toEqual({
      kind: "refund-request-open",
      idempotencyKey: `refund-request-open:${id}`,
      recipient: {
        id: platformAdmin.id,
        name: "Pat Admin",
        email: "pat@example.com",
        avatarUrl: null,
      },
      actor: { id: base.user.id, ...testUser },
      data: {
        refundRequestId: id,
        courseTitle: "Test Course",
        amount: "$79.00",
        url: "/admin/refunds",
      },
    });
  });

  it("tells the buyer their Individual Purchase refund was approved", async () => {
    const purchase = buyForSelf(base.user.id, 3, 7900);
    const id = await raise(purchase.id, base.user.id);

    await approveRefundRequest(db, id, platformAdmin.id, "Sorry it didn't work out.", NOW, notifications);

    expect(sentOf("refund-approved")).toEqual([
      {
        kind: "refund-approved",
        idempotencyKey: `refund-approved:${id}`,
        recipient: { id: base.user.id, ...testUser },
        actor: {
          id: platformAdmin.id,
          name: "Pat Admin",
          email: "pat@example.com",
          avatarUrl: null,
        },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "individual_purchase",
          amount: "$79.00",
          decisionNote: "Sorry it didn't work out.",
          url: "/settings",
        },
      },
    ]);
  });

  it("tells a Team Admin their Team Licence refund was declined", async () => {
    const priya = addStudent("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);

    await declineRefundRequest(db, id, platformAdmin.id, "  Seats are in use.  ", NOW, notifications);

    expect(sentOf("refund-declined")).toEqual([
      {
        kind: "refund-declined",
        idempotencyKey: `refund-declined:${id}`,
        recipient: {
          id: priya.id,
          name: "Priya",
          email: "priya@example.com",
          avatarUrl: null,
        },
        actor: {
          id: platformAdmin.id,
          name: "Pat Admin",
          email: "pat@example.com",
          avatarUrl: null,
        },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "team_licence",
          amount: "$158.00",
          decisionNote: "Seats are in use.",
          url: "/team",
        },
      },
    ]);
    expect(sentOf("refund-approved")).toEqual([]);
  });

  it("tells a Team Admin their Team Licence refund was approved, with no note", async () => {
    const priya = addStudent("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = await raise(purchase.id, priya.id);

    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);

    expect(sentOf("refund-approved")).toMatchObject([
      {
        idempotencyKey: `refund-approved:${id}`,
        recipient: { id: priya.id },
        data: { purchaseKind: "team_licence", decisionNote: null, url: "/team" },
      },
    ]);
  });

  it("still raises and decides Refund Requests, with their emails, when Knock is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    notifications.failWith(new Error("Knock is down"));
    const purchase = buyForSelf(base.user.id);

    const raised = await raiseRefundRequest(db, purchase.id, base.user.id, "Nope.", NOW, notifications);
    if (!raised.ok) throw new Error(raised.error);
    const declined = await declineRefundRequest(db, raised.refundRequestId, platformAdmin.id, "No.", NOW, notifications);

    expect(raised.email.to).toBe("test@example.com");
    expect(declined).toMatchObject({ ok: true, email: { to: "test@example.com" } });
    for (const key of ["refund-request-open:", "refund-declined:"]) {
      expect(error).toHaveBeenCalledWith(expect.stringContaining(key), "Knock is down");
    }
    error.mockRestore();
  });

  it("sends nothing when a decision is refused", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;

    await declineRefundRequest(db, id, platformAdmin.id, "Too late.", NOW, notifications);

    expect(notifications.sent).toEqual([]);
  });
});

describe("marking a Refund Issued", () => {
  const REASON = "It was not what I expected.";

  function sentOf(kind: string) {
    return notifications.sent.filter((n) => n.kind === kind);
  }

  function outcomeOf(id: number) {
    return db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get()?.refundOutcome;
  }

  async function approved(purchaseId: number, buyerId: number) {
    const id = await raise(purchaseId, buyerId);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;
    return id;
  }

  it("tells the Student their Individual Purchase Refund was Issued, and nothing else", async () => {
    const purchase = buyForSelf(base.user.id, 3, 7900);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(notifications.sent).toEqual([
      {
        kind: "refund-issued",
        idempotencyKey: `refund-issued:${id}`,
        recipient: {
          id: base.user.id,
          name: "Test User",
          email: "test@example.com",
          avatarUrl: null,
        },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "individual_purchase",
          amount: "$79.00",
          url: "/settings",
        },
      },
    ]);
  });

  it("tells the Team Admin their Team Licence Refund was Issued, linking to the team page", async () => {
    const priya = addStudent("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = await approved(purchase.id, priya.id);

    await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(notifications.sent).toMatchObject([
      {
        kind: "refund-issued",
        idempotencyKey: `refund-issued:${id}`,
        recipient: { id: priya.id },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "team_licence",
          amount: "$158.00",
          url: "/team",
        },
      },
    ]);
  });

  it("stays Issued, and returns ok, when the Notification cannot be sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    notifications.failWith(new Error("Knock is down"));

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`refund-issued:${id}`),
      "Knock is down"
    );
    error.mockRestore();
  });

  it("refuses a Refund Request that is not approved, and sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    notifications.sent.length = 0;

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(outcomeOf(id)).toBeNull();
    expect(notifications.sent).toEqual([]);
  });

  it("refuses a Refund that already has an outcome, and sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    await markRefundIssued(db, id, notifications, EMAIL_CONFIG);
    notifications.sent.length = 0;

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(notifications.sent).toEqual([]);
  });

  it("issues a Refund that failed earlier and succeeds on retry, telling the buyer once", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);
    notifications.sent.length = 0;

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(notifications.sent).toHaveLength(1);
    expect(sentOf("refund-issued")).toMatchObject([
      { idempotencyKey: `refund-issued:${id}`, recipient: { id: base.user.id } },
    ]);
  });

  it("returns 404 for a Refund Request that does not exist", async () => {
    const result = await markRefundIssued(db, 9999, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(notifications.sent).toEqual([]);
  });

  it("never puts the buyer's name or the reason text in the Notification", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;

    await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    const data = JSON.stringify(notifications.sent.map((n) => n.data));
    expect(data).not.toContain("Test User");
    expect(data).not.toContain(REASON);
  });
});

describe("marking a Refund Failed", () => {
  const REASON = "It was not what I expected.";

  function sentOf(kind: string) {
    return notifications.sent.filter((n) => n.kind === kind);
  }

  function outcomeOf(id: number) {
    return db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get()?.refundOutcome;
  }

  function addAdmin(name: string) {
    return db
      .insert(schema.users)
      .values({ name, email: `${name.toLowerCase().replace(" ", "-")}@example.com`, role: UserRole.Admin })
      .returning()
      .get();
  }

  async function approved(purchaseId: number, buyerId: number) {
    const id = await raise(purchaseId, buyerId);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;
    return id;
  }

  it("tells every other Platform Admin once each, and not the one who recorded the failure", async () => {
    const sam = addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id, 3, 7900);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Failed);
    expect(notifications.sent.every((n) => n.kind === "refund-failed")).toBe(true);
    expect(sentOf("refund-failed").map((n) => n.recipient.id)).toEqual([sam.id]);
    expect(notifications.sent[0]).toEqual({
      kind: "refund-failed",
      idempotencyKey: `refund-failed:${id}:${NOW.toISOString()}:${sam.id}`,
      recipient: {
        id: sam.id,
        name: "Sam Admin",
        email: "sam-admin@example.com",
        avatarUrl: null,
      },
      actor: {
        id: platformAdmin.id,
        name: "Pat Admin",
        email: "pat@example.com",
        avatarUrl: null,
      },
      data: {
        refundRequestId: id,
        courseTitle: "Test Course",
        amount: "$79.00",
        url: `/admin/refunds?status=approved&refund=${id}`,
      },
    });
  });

  it("notifies the other Platform Admin again when the same approved Refund fails a second time", async () => {
    const sam = addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);
    const later = new Date(NOW.getTime() + 60_000);

    const result = await markRefundFailed(db, id, platformAdmin.id, later, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Failed);
    const toSam = sentOf("refund-failed").filter((n) => n.recipient.id === sam.id);
    expect(toSam.map((n) => n.idempotencyKey)).toEqual([
      `refund-failed:${id}:${NOW.toISOString()}:${sam.id}`,
      `refund-failed:${id}:${later.toISOString()}:${sam.id}`,
    ]);
  });

  it("returns ok and keeps the Failed outcome when the Notification cannot be sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    notifications.failWith(new Error("Knock is down"));

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    expect(outcomeOf(id)).toBe(RefundOutcome.Failed);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(`refund-failed:${id}`),
      "Knock is down"
    );
    error.mockRestore();
  });

  it("refuses a Refund Request that is still open, and sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    notifications.sent.length = 0;

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(outcomeOf(id)).toBeNull();
    expect(notifications.sent).toEqual([]);
  });

  it("refuses a Refund Request that was declined, and sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await declineRefundRequest(db, id, platformAdmin.id, "No.", NOW, notifications);
    notifications.sent.length = 0;

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(outcomeOf(id)).toBeNull();
    expect(notifications.sent).toEqual([]);
  });

  it("refuses a Refund that was already Issued, and sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    await markRefundIssued(db, id, notifications, EMAIL_CONFIG);
    notifications.sent.length = 0;

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(outcomeOf(id)).toBe(RefundOutcome.Issued);
    expect(notifications.sent).toEqual([]);
  });

  it("returns 404 for a Refund Request that does not exist", async () => {
    const result = await markRefundFailed(db, 9999, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(notifications.sent).toEqual([]);
  });

  it("never puts the buyer's name or the reason text in the Notification", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;

    await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    const data = JSON.stringify(notifications.sent.map((n) => n.data));
    expect(data).not.toContain("Test User");
    expect(data).not.toContain(REASON);
  });
});

describe("emailing Issued and Failed Refunds", () => {
  const REASON = "It was not what I expected.";

  function addAdmin(name: string) {
    return db
      .insert(schema.users)
      .values({ name, email: `${name.toLowerCase().replace(" ", "-")}@example.com`, role: UserRole.Admin })
      .returning()
      .get();
  }

  async function approved(purchaseId: number, buyerId: number) {
    const id = await raise(purchaseId, buyerId);
    await approveRefundRequest(db, id, platformAdmin.id, null, NOW, notifications);
    notifications.sent.length = 0;
    return id;
  }

  it("emails the Student once that their Individual Purchase Refund was Issued", async () => {
    const purchase = buyForSelf(base.user.id, 3, 7900);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.emails).toEqual([
      {
        from: EMAIL_CONFIG.from,
        to: "test@example.com",
        subject: "Your refund for Test Course has been issued",
        body: expect.stringContaining(
          "The refund for Test Course has been issued and sent back to your original payment method."
        ),
      },
    ]);
    expect(result.emails[0].body).toContain(`${EMAIL_CONFIG.appUrl}/settings`);
  });

  it("emails the Team Admin once that their Team Licence Refund was Issued, linking to the team page", async () => {
    const priya = addStudent("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = await approved(purchase.id, priya.id);

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    if (!result.ok) throw new Error(result.error);
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]).toMatchObject({
      from: EMAIL_CONFIG.from,
      to: "priya@example.com",
      subject: "Your refund for Test Course has been issued",
    });
    expect(result.emails[0].body).toContain(`${EMAIL_CONFIG.appUrl}/team`);
    expect(result.emails[0].body).not.toContain("/settings");
  });

  it("keeps the Issued Notification to the feed, and never puts the buyer's name or reason in the email", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    if (!result.ok) throw new Error(result.error);
    expect(notifications.sent.map((n) => n.kind)).toEqual(["refund-issued"]);
    const text = JSON.stringify(result.emails);
    expect(text).not.toContain("Test User");
    expect(text).not.toContain(REASON);
  });

  it("emails every other Platform Admin once each that a Refund failed to send, and not the one who recorded it", async () => {
    const sam = addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id, 3, 7900);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    if (!result.ok) throw new Error(result.error);
    expect(result.emails.map((e) => e.to)).toEqual([sam.email]);
    expect(result.emails).toEqual([
      {
        from: EMAIL_CONFIG.from,
        to: sam.email,
        subject: "A refund for Test Course failed to send",
        body: expect.stringContaining(
          "The refund for Test Course failed to send. Each failure is sent to you separately."
        ),
      },
    ]);
    for (const email of result.emails) {
      expect(email.body).not.toContain("Test User");
      expect(email.body).not.toContain(REASON);
    }
  });

  it("links the Failed email to the Approved filter and this Refund Request", async () => {
    addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);

    const result = await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    if (!result.ok) throw new Error(result.error);
    expect(result.emails).toHaveLength(1);
    expect(result.emails[0].body).toContain(
      `${EMAIL_CONFIG.appUrl}/admin/refunds?status=approved&refund=${id}`
    );
  });

  it("emails the other Platform Admin again when the same approved Refund fails a second time", async () => {
    const sam = addAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id);
    const id = await approved(purchase.id, base.user.id);
    await markRefundFailed(db, id, platformAdmin.id, NOW, notifications, EMAIL_CONFIG);

    const result = await markRefundFailed(
      db,
      id,
      platformAdmin.id,
      new Date(NOW.getTime() + 60_000),
      notifications,
      EMAIL_CONFIG
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.emails.map((e) => e.to)).toEqual([sam.email]);
  });

  it("produces no emails when a refusal sends nothing", async () => {
    const purchase = buyForSelf(base.user.id);
    const id = await raise(purchase.id, base.user.id);

    const result = await markRefundIssued(db, id, notifications, EMAIL_CONFIG);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).not.toHaveProperty("emails");
  });
});
