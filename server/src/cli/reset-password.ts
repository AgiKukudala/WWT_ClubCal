/**
 * Local account recovery without an email provider.
 *   npm run admin:reset-password -w server -- --email someone@school.edu
 * Prompts for the new password (or reads it from stdin), revokes all of the
 * user's sessions, clears login throttling and records an audit entry.
 */
import { email as emailSchema } from "@clubcal/shared";
import { hashPassword } from "../auth/passwords.js";
import { createDb, createPool } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { arg, promptHidden } from "./args.js";

const email = emailSchema.safeParse(arg("email"));
if (!email.success) {
  console.error("Usage: npm run admin:reset-password -w server -- --email <address>");
  process.exit(2);
}
const password = await promptHidden("New password (min 10 characters): ");
if (password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(2);
}
const db = createDb(createPool());
try {
  const hash = await hashPassword(password);
  await db.transaction().execute(async (tx) => {
    const u = await tx
      .updateTable("users")
      .set({ password_hash: hash, updated_at: new Date() })
      .where("email", "=", email.data)
      .returning("id")
      .executeTakeFirst();
    if (!u) throw new Error(`No account with email ${email.data}`);
    await tx.deleteFrom("sessions").where("user_id", "=", u.id).execute();
    await tx.deleteFrom("login_attempts").where("email", "=", email.data).execute();
    await audit(tx, null, "user.password_reset_cli", "user", u.id, { via: "cli" });
  });
  console.log(`Password updated for ${email.data}. All of that user's sessions were signed out.`);
} catch (err) {
  console.error(String((err as Error).message));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
