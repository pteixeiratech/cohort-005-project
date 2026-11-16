import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Transactional email ───
// Postmark delivers every email when POSTMARK_SERVER_TOKEN is set. Without a
// token (local dev, tests) each message is written to .outbox/ as a JSON file
// instead, so it can be read without sending anything.

export type Email = {
  // Defaults to the Cadence sender when not given.
  from?: string;
  to: string;
  subject: string;
  body: string;
};

export interface MailTransport {
  send(email: Email): Promise<void>;
}

const FROM_ADDRESS = "Cadence <hello@cadence.dev>";

export function postmarkTransport(serverToken: string): MailTransport {
  return {
    async send(email) {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": serverToken,
        },
        body: JSON.stringify({
          From: email.from ?? FROM_ADDRESS,
          To: email.to,
          Subject: email.subject,
          TextBody: email.body,
          MessageStream: "outbound",
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Postmark rejected the email to ${email.to}: ${response.status}`
        );
      }
    },
  };
}

export function outboxTransport(directory: string): MailTransport {
  return {
    async send(email) {
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${Date.now()}-${email.to}.json`);
      writeFileSync(
        file,
        JSON.stringify({ ...email, from: email.from ?? FROM_ADDRESS }, null, 2)
      );
    },
  };
}

function defaultTransport(): MailTransport {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  return token ? postmarkTransport(token) : outboxTransport(".outbox");
}

export async function sendEmail(
  email: Email,
  transport: MailTransport = defaultTransport()
): Promise<void> {
  await transport.send(email);
}

// ─── Notification emails ───
// Emails for Notifications (Issued and Failed Refunds) come from their own
// sender and link to the app at its own base URL. Neither is hardcoded: both
// come from configuration, and a missing value is an error rather than a guess.

export type NotificationEmailConfig = {
  /** The From address, e.g. `Name <address@domain>`. */
  from: string;
  /** The origin links in the emails are built on, e.g. `https://app.example`. */
  appUrl: string;
};

/**
 * Reads the Notification email sender and link base from `env`, which is
 * `process.env` in the running app. NOTIFICATION_EMAIL_FROM and APP_URL must
 * both be set.
 */
export function notificationEmailConfig(
  env: Record<string, string | undefined>
): NotificationEmailConfig {
  const from = env.NOTIFICATION_EMAIL_FROM;
  if (!from) {
    throw new Error(
      "NOTIFICATION_EMAIL_FROM must be set to send Notification emails."
    );
  }

  const appUrl = env.APP_URL;
  if (!appUrl) {
    throw new Error("APP_URL must be set to link from Notification emails.");
  }

  return { from, appUrl };
}
