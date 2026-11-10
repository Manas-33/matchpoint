// Price protection from the command line.
//   npm run protection:backfill          enrol every captured order that has no protection yet
//   npm run protection:check             fallback price check over active protections (cron this daily)
//   npm run protection:replay -- <id>    SIMULATED price drop for a protection or order ID (demo)
import "./load-env";
import { isNull, eq, and, inArray, or } from "drizzle-orm";
import { closeDb, getDb, schema } from "../lib/db";
import { enrolProtection, replaySimulatedDrop, runPriceCheck } from "../lib/price-protection";

const [command, arg] = process.argv.slice(2);
const db = getDb();

try {
  if (command === "backfill") {
    const orders = await db
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .leftJoin(schema.protections, eq(schema.protections.orderId, schema.orders.id))
      .where(and(inArray(schema.orders.status, ["completed", "partially_refunded"]), isNull(schema.protections.id)));
    for (const o of orders) console.log(await enrolProtection(o.id));
    console.log(`${orders.length} order(s) enrolled.`);
  } else if (command === "check") {
    console.log(JSON.stringify(await runPriceCheck(), null, 2));
  } else if (command === "replay" && arg) {
    const [p] = await db
      .select({ id: schema.protections.id })
      .from(schema.protections)
      .where(or(eq(schema.protections.id, arg), eq(schema.protections.orderId, arg)));
    if (!p) throw new Error(`No protection for ${arg}`);
    console.log(JSON.stringify(await replaySimulatedDrop(p.id), null, 2));
  } else {
    console.log("usage: tsx scripts/protection.ts backfill | check | replay <protectionId|orderId>");
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
