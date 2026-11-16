import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { enrollStudent, isEnrolled } from "./enrollments.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

describe("enrolling a Student", () => {
  it("gives the Student an Enrollment on the course", () => {
    expect(enrollStudent(db, base.user.id, base.course.id, NOW)).toMatchObject({
      ok: true,
      enrollment: {
        userId: base.user.id,
        courseId: base.course.id,
        enrolledAt: NOW.toISOString(),
      },
    });
  });

  it("refuses a Student who is already enrolled", () => {
    enrollStudent(db, base.user.id, base.course.id, NOW);

    expect(enrollStudent(db, base.user.id, base.course.id, NOW)).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
  });

  it("refuses a course that does not exist", () => {
    expect(enrollStudent(db, base.user.id, 9999, NOW)).toEqual({
      ok: false,
      error: "Course not found",
    });
  });

  it("re-enrols a Lapsed Student whose Individual Purchase was refunded", async () => {
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    enrollStudent(db, base.user.id, base.course.id, NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "No.",
      NOW,
      fakeNotifications()
    );
    if (!raised.ok) throw new Error(raised.error);
    const platformAdmin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    await approveRefundRequest(
      db,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      NOW,
      fakeNotifications()
    );
    expect(isEnrolled(db, base.user.id, base.course.id)).toBe(false);

    const later = new Date(2026, 9, 20, 12, 0, 0);
    expect(enrollStudent(db, base.user.id, base.course.id, later)).toMatchObject(
      {
        ok: true,
        enrollment: { enrolledAt: later.toISOString() },
      }
    );
    expect(isEnrolled(db, base.user.id, base.course.id)).toBe(true);
  });
});
