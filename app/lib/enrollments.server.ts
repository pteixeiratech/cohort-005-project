import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { and, eq } from "drizzle-orm";
import { courses, enrollments } from "~/db/schema";

// ─── Enrollments ───
// Giving a Student an Enrollment on a course, whether it came from an
// Individual Purchase or a Claimed Seat. See GLOSSARY.md for the language and
// docs/adr/0004 for why an Enrollment is not tied to a Purchase.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

type Enrollment = typeof enrollments.$inferSelect;

/** Whether the Student has an Enrollment on the course right now. */
export function isEnrolled(
  db: Queryable,
  studentId: number,
  courseId: number
): boolean {
  return !!db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, studentId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export type EnrollResult =
  { ok: true; enrollment: Enrollment } | { ok: false; error: string };

/** Gives the Student an Enrollment on a course. No Notification is sent. */
export function enrollStudent(
  db: Db,
  studentId: number,
  courseId: number,
  now: Date
): EnrollResult {
  return enrollStudentInTransaction(db, studentId, courseId, now);
}

/**
 * The write half of `enrollStudent`, for callers that enrol inside their own
 * transaction.
 */
export function enrollStudentInTransaction(
  db: Queryable,
  studentId: number,
  courseId: number,
  now: Date
): EnrollResult {
  if (isEnrolled(db, studentId, courseId)) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  const course = db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    return { ok: false, error: "Course not found" };
  }

  const enrollment = db
    .insert(enrollments)
    .values({ userId: studentId, courseId, enrolledAt: now.toISOString() })
    .returning()
    .get();

  return { ok: true, enrollment };
}
