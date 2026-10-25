// Email (the customer evidence card). Sends through Resend when RESEND_API_KEY is set in live mode;
// otherwise, and always in demo mode, the message is logged instead of sent.
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { getEnv } from "./env";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Same key, same email: Resend drops the repeat (used so a retried refund doesn't email twice).
  idempotencyKey?: string;
};

export type SentEmail = { id: string; transport: "resend" | "log" };

export interface EmailService {
  readonly transport: "resend" | "log";
  send(message: EmailMessage): Promise<SentEmail>;
}

function resendEmail(apiKey: string, from: string): EmailService {
  const resend = new Resend(apiKey);
  return {
    transport: "resend",
    async send({ idempotencyKey, ...message }) {
      const { data, error } = await resend.emails.send({ from, ...message }, { idempotencyKey });
      if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
      return { id: data.id, transport: "resend" };
    },
  };
}

function logEmail(from: string, reason: string): EmailService {
  return {
    transport: "log",
    async send({ to, subject, text }) {
      const id = `log-${randomUUID()}`;
      console.log(`[email:${reason}] ${id}\n  from: ${from}\n  to: ${to}\n  subject: ${subject}\n\n${text}\n`);
      return { id, transport: "log" };
    },
  };
}

let service: EmailService | undefined;

export function getEmail(): EmailService {
  if (!service) {
    const env = getEnv();
    service = env.DEMO_MODE
      ? logEmail(env.EMAIL_FROM, "demo")
      : env.RESEND_API_KEY
        ? resendEmail(env.RESEND_API_KEY, env.EMAIL_FROM)
        : logEmail(env.EMAIL_FROM, "no RESEND_API_KEY");
  }
  return service;
}
