import nodemailer from 'nodemailer';

export function isSmtpConfigured() {
  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  return Boolean(host && from);
}

function createTransport() {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: pass || '' } : undefined,
  });
}

/**
 * @param {{ to: string; subject: string; text: string; html?: string; replyTo?: string }} opts
 */
export async function sendSmtpMail(opts) {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP_HOST en SMTP_FROM ontbreken in .env');
  }
  const transporter = createTransport();
  await transporter.sendMail({
    from: process.env.SMTP_FROM?.trim(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo || undefined,
  });
}
