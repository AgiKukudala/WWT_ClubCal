import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";

export const emailConfigured = () => Boolean(config.SMTP_HOST);

let transport: Transporter | null = null;

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export const smtpMailer: Mailer = {
  async send(msg) {
    if (!config.SMTP_HOST) throw new Error("SMTP is not configured");
    transport ??= nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE === "true",
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? "" } : undefined,
    });
    await transport.sendMail({ from: config.MAIL_FROM, ...msg });
  },
};
