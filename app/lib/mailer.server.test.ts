import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  notificationEmailConfig,
  outboxTransport,
  sendEmail,
} from "./mailer.server";

describe("sendEmail", () => {
  it("writes the message to the outbox when there is no Postmark token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await sendEmail(
      { to: "liam@example.com", subject: "Hello", body: "Hi Liam" },
      outboxTransport(directory)
    );

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    expect(written).toMatchObject({
      to: "liam@example.com",
      subject: "Hello",
      body: "Hi Liam",
    });
  });
});

describe("sending from a chosen sender", () => {
  it("writes the From address the email was given", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-"));

    await sendEmail(
      {
        from: "Notifications <sender@example.test>",
        to: "liam@example.com",
        subject: "Hello",
        body: "Hi Liam",
      },
      outboxTransport(directory)
    );

    const [file] = readdirSync(directory);
    const written = JSON.parse(readFileSync(join(directory, file), "utf8"));
    expect(written.from).toBe("Notifications <sender@example.test>");
  });
});

describe("notificationEmailConfig", () => {
  it("reads the sender address and the link base from configuration", () => {
    expect(
      notificationEmailConfig({
        NOTIFICATION_EMAIL_FROM: "Notifications <sender@example.test>",
        APP_URL: "https://cadence.test",
      })
    ).toEqual({
      from: "Notifications <sender@example.test>",
      appUrl: "https://cadence.test",
    });
  });

  it("refuses to guess a sender when NOTIFICATION_EMAIL_FROM is not set", () => {
    expect(() =>
      notificationEmailConfig({ APP_URL: "https://cadence.test" })
    ).toThrow("NOTIFICATION_EMAIL_FROM");
  });

  it("refuses to guess the link base when APP_URL is not set", () => {
    expect(() =>
      notificationEmailConfig({
        NOTIFICATION_EMAIL_FROM: "Notifications <sender@example.test>",
      })
    ).toThrow("APP_URL");
  });
});
