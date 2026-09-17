/**
 * Creates an account with an explicit role (the supported way to create the first administrator).
 *   npm run user:create -w server -- --email admin@school.edu --name "Ada Admin" --role admin
 */
import { email as emailSchema, ROLES, type Role } from "@clubcal/shared";
import { hashPassword } from "../auth/passwords.js";
import { createDb, createPool } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { arg, promptHidden } from "./args.js";

const email = emailSchema.safeParse(arg("email"));
const name = arg("name");
const role = (arg("role") ?? "student") as Role;
if (!email.success || !name || !ROLES.includes(role)) {
  console.error('Usage: npm run user:create -w server -- --email <address> --name "<display name>" --role admin|organizer|student');
  process.exit(2);
}
const password = await promptHidden("Password (min 10 characters): ");
if (password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(2);
}
const db = createDb(createPool());
try {
  const hash = await hashPassword(password);
  await db.transaction().execute(async (tx) => {
    const u = await tx
      .insertInto("users")
      .values({ email: email.data, display_name: name, password_hash: hash, role })
      .returning("id")
      .executeTakeFirstOrThrow();
    await audit(tx, null, "user.created_cli", "user", u.id, { role });
  });
  console.log(`Created ${role} account ${email.data}.`);
} catch (err) {
  console.error((err as { code?: string }).code === "23505" ? "An account with that email already exists." : String(err));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
