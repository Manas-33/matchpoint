// savePolicyVersion against real Postgres, in a transaction that is rolled back (skipped without a
// database): each save is the next version, the newest version is the one in force, and an unchanged
// form saves nothing.
import "../scripts/load-env";
import { desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Channel3Service } from "./channel3";
import * as schema from "./db/schema";
import type { Db } from "./db";
import { DEFAULT_POLICY } from "./policy";
import { PolicySaveError, savePolicyVersion } from "./policy-admin";

const url = process.env.DATABASE_URL;
const client = url ? postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} }) : null;
const reachable = client ? await client`select 1`.then(() => true, () => false) : false;
afterAll(() => client?.end());

class Rollback extends Error {}
async function inRolledBackTransaction(fn: (db: Db) => Promise<void>) {
  const db = drizzle({ client: client!, schema });
  await expect(
    db.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

const settings = { ...DEFAULT_POLICY, approvedDomains: [...DEFAULT_POLICY.approvedDomains] };

describe.skipIf(!reachable)("savePolicyVersion (Postgres)", () => {
  it("saves the next version, syncing the stores to Channel3 in live mode", () =>
    inRolledBackTransaction(async (db) => {
      await db.insert(schema.policies).values({ ...settings, version: 900_000, channel3CollectionId: "OLD" });
      const channel3 = { mode: "live", upsertApprovedStores: vi.fn(async () => ({ collection_id: "NEW" })) } as unknown as Channel3Service;

      const tighter = await savePolicyVersion({ ...settings, maxDiscountBps: 1000 }, { db, channel3 });
      expect(tighter.policy).toMatchObject({ version: 900_001, maxDiscountBps: 1000, channel3CollectionId: "OLD", createdBy: "owner" });
      expect(channel3.upsertApprovedStores).not.toHaveBeenCalled();

      const stores = await savePolicyVersion({ ...settings, maxDiscountBps: 1000, approvedDomains: ["bestbuy.com"] }, { db, channel3 });
      expect(stores.policy).toMatchObject({ version: 900_002, channel3CollectionId: "NEW" });
      expect(channel3.upsertApprovedStores).toHaveBeenCalledWith(["bestbuy.com"]);

      const [inForce] = await db.select().from(schema.policies).orderBy(desc(schema.policies.version)).limit(1);
      expect(inForce.id).toBe(stores.policy.id);

      await expect(savePolicyVersion({ ...settings, maxDiscountBps: 1000, approvedDomains: ["bestbuy.com"] }, { db, channel3 })).rejects.toBeInstanceOf(PolicySaveError);
    }));
});
