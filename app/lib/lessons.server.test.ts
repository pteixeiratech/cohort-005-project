import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createLesson } from "./lessons.server";
import {
  fakeNotifications,
  type FakeNotifications,
} from "./notifications.fake.server";
import { parseFeedNotification } from "./notification-feed";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;
let notifications: FakeNotifications;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  notifications = fakeNotifications();
  db = createTestDb();
  base = seedBaseData(db);

  moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;
});

function enrol(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id, enrolledAt: "2026-01-01" })
    .run();
}

function addStudent(email: string) {
  return db
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

describe("creating a lesson: lesson-created Notifications", () => {
  it("sends one lesson-created Notification to each active enrolled Student", async () => {
    const ada = addStudent("ada@example.com");
    const grace = addStudent("grace@example.com");
    enrol(ada.id);
    enrol(grace.id);

    const lesson = await createLesson(
      db,
      moduleId,
      "Closures",
      notifications
    );

    expect(notifications.sent).toHaveLength(2);
    expect(notifications.feedOf(ada.id)).toEqual([
      expect.objectContaining({
        kind: "lesson-created",
        recipient: expect.objectContaining({ id: ada.id }),
        idempotencyKey: `lesson-created:${lesson.id}`,
        data: {
          courseId: base.course.id,
          courseTitle: "Test Course",
          lessonId: lesson.id,
          lessonTitle: "Closures",
          url: `/courses/test-course/lessons/${lesson.id}`,
        },
      }),
    ]);
    expect(notifications.feedOf(grace.id)).toHaveLength(1);
  });

  it("sends nothing to a Student whose Enrollment has lapsed", async () => {
    const lapsed = addStudent("lapsed@example.com");
    // Lapsed: progress on the course, but no Enrollment.
    const earlier = db
      .insert(schema.lessons)
      .values({ moduleId, title: "Earlier", position: 1 })
      .returning()
      .get();
    db.insert(schema.lessonProgress)
      .values({
        userId: lapsed.id,
        lessonId: earlier.id,
        status: schema.LessonProgressStatus.Completed,
      })
      .run();

    await createLesson(db, moduleId, "Closures", notifications);

    expect(notifications.feedOf(lapsed.id)).toEqual([]);
  });

  it("sends nothing to someone with no Enrollment on the course", async () => {
    const stranger = addStudent("stranger@example.com");

    await createLesson(db, moduleId, "Closures", notifications);

    expect(notifications.feedOf(stranger.id)).toEqual([]);
    expect(notifications.sent).toEqual([]);
  });

  it("sends one Notification per lesson, not per module", async () => {
    const ada = addStudent("ada@example.com");
    enrol(ada.id);

    await createLesson(db, moduleId, "First", notifications);
    await createLesson(db, moduleId, "Second", notifications);

    expect(notifications.feedOf(ada.id)).toHaveLength(2);
    expect(
      notifications.feedOf(ada.id).map((n) => n.idempotencyKey)
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^lesson-created:\d+$/),
      ])
    );
  });

  it("still creates the lesson when the vendor call fails", async () => {
    const ada = addStudent("ada@example.com");
    enrol(ada.id);
    notifications.failWith(new Error("Knock is down"));

    const lesson = await createLesson(
      db,
      moduleId,
      "Closures",
      notifications
    );

    expect(
      db.select().from(schema.lessons).all().map((l) => l.id)
    ).toContain(lesson.id);
    expect(notifications.feedOf(ada.id)).toEqual([]);
  });

  it("writes a feed entry the browser parses", async () => {
    const ada = addStudent("ada@example.com");
    enrol(ada.id);

    await createLesson(db, moduleId, "Closures", notifications);

    const [sent] = notifications.feedOf(ada.id);
    const parsed = parseFeedNotification({
      id: "n1",
      kind: sent.kind,
      data: sent.data,
      actor: null,
      insertedAt: "2026-02-01T00:00:00.000Z",
      readAt: null,
      seenAt: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("lesson-created");
  });
});
