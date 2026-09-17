/**
 * Explicit local demo seed. Never runs automatically and refuses production.
 *   npm run seed            # insert synthetic demo data (fails if already present)
 *   npm run seed -- --reset # remove previous demo data first
 */
import { config } from "../config.js";
import { createDb, createPool } from "../db/index.js";
import { bossQueue, createBoss } from "../queue/boss.js";
import { DEMO_PASSWORD, DEMO_USERS, hasDemoData, removeDemoData, seedDemo } from "../seed/demo.js";
import { flag } from "./args.js";

if (config.NODE_ENV === "production" && !flag("i-understand-this-creates-demo-logins")) {
  console.error("Refusing to create demo accounts with known passwords while NODE_ENV=production.");
  process.exit(2);
}
const db = createDb(createPool());
const boss = createBoss("api");
try {
  await boss.start();
  if (await hasDemoData(db)) {
    if (!flag("reset")) {
      console.error("Demo data already exists. Re-run with --reset to replace it.");
      process.exitCode = 1;
    } else {
      await removeDemoData(db);
      console.log("Removed previous demo data.");
    }
  }
  if (process.exitCode !== 1) {
    await seedDemo(db, bossQueue(boss));
    console.log("\nSynthetic demo data created. Development-only logins (password for all):", DEMO_PASSWORD);
    for (const u of Object.values(DEMO_USERS)) console.log(`  ${u.role.padEnd(9)} ${u.email}`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: false }).catch(() => {});
  await db.destroy();
}
