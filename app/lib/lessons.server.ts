import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  courses,
  enrollments,
  lessons,
  modules,
  users,
  UserRole,
} from "~/db/schema";
import {
  NOTIFICATION_PERSON_COLUMNS,
  sendSafely,
  type Notifications,
} from "~/lib/notifications.server";

// ─── Lessons ───
// Creating a lesson on a module. When a lesson is created, every Student with
// an active (non-Lapsed) Enrollment on the course gets one lesson-created
// Notification. Nothing is sent per module or per edit.
//
// Every function takes the database first, so tests can hand in an in-memory
// one, and the Notifications port last, so tests can hand in a fake. Uses
// positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Appends a lesson to a module and tells the course's active Students. A
 * failure to send is logged and never fails the create.
 */
export async function createLesson(
  db: Db,
  moduleId: number,
  title: string,
  notifications: Notifications
) {
  const position =
    db
      .select({ max: sql<number>`coalesce(max(${lessons.position}), 0)` })
      .from(lessons)
      .where(eq(lessons.moduleId, moduleId))
      .get()!.max + 1;

  const lesson = db
    .insert(lessons)
    .values({ moduleId, title, position })
    .returning()
    .get();

  const course = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
    })
    .from(modules)
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(modules.id, moduleId))
    .get();
  if (!course) return lesson;

  const recipients = db
    .select(NOTIFICATION_PERSON_COLUMNS)
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(
      and(
        eq(enrollments.courseId, course.id),
        eq(users.role, UserRole.Student)
      )
    )
    .all();

  for (const recipient of recipients) {
    await sendSafely(
      notifications,
      {
        kind: "lesson-created",
        recipient,
        data: {
          courseId: course.id,
          courseTitle: course.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          url: `/courses/${course.slug}/lessons/${lesson.id}`,
        },
      },
      `lesson-created:${lesson.id}`
    );
  }

  return lesson;
}
