import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import nodemailer from "nodemailer";
import { authConfig, insecureDevelopmentSmtp } from "./config";
import { authDatabase, consumeAuthRateLimit } from "./auth-database";

function createAuth() {
  const config = authConfig();
  const smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.SMTP_SECURE !== "true" && !insecureDevelopmentSmtp(),
    auth: process.env.SMTP_USER && process.env.SMTP_PASS ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  return betterAuth({
    appName: "KIMA Community 7",
    ...config,
    database: authDatabase(),
    trustedOrigins: [config.baseURL],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database", customStorage: { consume: consumeAuthRateLimit }, window: 60, max: 60 },
    advanced: { ipAddress: { ipAddressHeaders: process.env.VERCEL ? ["x-vercel-forwarded-for"] : [] } },
    logger: { disabled: true },
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 5,
      storeOTP: "hashed",
      async sendVerificationOTP({ email, otp }) {
        await smtp.sendMail({ from: process.env.SMTP_FROM, to: email, subject: "Dein Anmeldecode für KIMA Community 7", text: `Dein Anmeldecode lautet: ${otp}\n\nEr gilt fünf Minuten. Falls du keinen Code angefordert hast, kannst du diese E-Mail ignorieren.` });
      },
    })],
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  instance ??= createAuth();
  return instance;
}
