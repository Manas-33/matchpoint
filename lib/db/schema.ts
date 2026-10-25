// Database schema (PLAN.md "Data model"). Money is integer cents; percentages are integer basis points
// (1500 = 15%), so no amount or rate is ever a float.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const currency = () => text("currency").notNull().default("USD");

export const matchDecision = pgEnum("match_decision", ["match", "decline", "review"]);
export const orderStatus = pgEnum("order_status", [
  "created",
  "approved",
  "completed",
  "partially_refunded",
  "refunded",
  "voided",
  "failed",
]);
export const protectionStatus = pgEnum("protection_status", ["active", "expired", "closed"]);
export const priceEventSource = pgEnum("price_event_source", ["webhook", "poll", "replay"]);
export const refundStatus = pgEnum("refund_status", [
  "pending_approval",
  "processing",
  "completed",
  "failed",
  "rejected",
]);
export const refundApprover = pgEnum("refund_approver", ["auto", "owner"]);
// What to do when the competitor price looks like a short-lived glitch in the price history.
export const glitchAction = pgEnum("glitch_action", ["match_typical", "decline"]);
// Channel3 usually reports condition as null on live links; the policy decides what unknown means.
export const unknownConditionAction = pgEnum("unknown_condition_action", ["allow", "review", "decline"]);

export type VariantSelection = { name: string; label: string }[];
export type DecisionReason = { code: string; message: string; source?: string };

export const products = pgTable(
  "products",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    channel3ProductId: text("channel3_product_id").notNull().unique(),
    title: text("title").notNull(),
    brand: text("brand"),
    category: text("category"),
    // The variant this listing is, e.g. [{ name: "Color", label: "Black" }].
    variant: jsonb("variant").$type<VariantSelection>().notNull().default([]),
    // Channel3 `variants.options`: every option and its values.
    variantOptions: jsonb("variant_options").$type<unknown[]>().notNull().default([]),
    imageUrl: text("image_url"),
    shopPriceCents: integer("shop_price_cents").notNull(),
    unitCostCents: integer("unit_cost_cents").notNull(),
    currency: currency(),
    // The full Channel3 product as seeded, for product pages and demo mode.
    channel3Snapshot: jsonb("channel3_snapshot").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("products_shop_price_positive", sql`${t.shopPriceCents} > 0`),
    check("products_unit_cost_non_negative", sql`${t.unitCostCents} >= 0`),
  ],
);

// Policies are append-only: each change inserts a new version, and decisions record the version they used.
export const policies = pgTable(
  "policies",
  {
    id: id(),
    version: integer("version").notNull().unique(),
    approvedDomains: text("approved_domains").array().notNull(),
    channel3CollectionId: text("channel3_collection_id"),
    marginFloorBps: integer("margin_floor_bps").notNull(),
    maxDiscountBps: integer("max_discount_bps").notNull(),
    protectionDays: integer("protection_days").notNull(),
    autoRefundCapCents: integer("auto_refund_cap_cents").notNull(),
    // Price drops smaller than this aren't refunded.
    minRefundCents: integer("min_refund_cents").notNull(),
    glitchAction: glitchAction("glitch_action").notNull().default("decline"),
    unknownConditionAction: unknownConditionAction("unknown_condition_action").notNull().default("review"),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: createdAt(),
  },
  (t) => [
    check("policies_margin_floor_bps", sql`${t.marginFloorBps} between 0 and 10000`),
    check("policies_max_discount_bps", sql`${t.maxDiscountBps} between 0 and 10000`),
    check("policies_protection_days", sql`${t.protectionDays} >= 0`),
    check("policies_auto_refund_cap", sql`${t.autoRefundCapCents} >= 0`),
    check("policies_min_refund", sql`${t.minRefundCents} >= 0`),
  ],
);

export const matchRequests = pgTable(
  "match_requests",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    competitorUrl: text("competitor_url").notNull(),
    competitorDomain: text("competitor_domain"),
    lookupSnapshot: jsonb("lookup_snapshot"),
    historyStats: jsonb("history_stats"),
    model: text("model"),
    modelOutput: jsonb("model_output"),
    decision: matchDecision("decision").notNull(),
    reasons: jsonb("reasons").$type<DecisionReason[]>().notNull().default([]),
    competitorPriceCents: integer("competitor_price_cents"),
    matchedPriceCents: integer("matched_price_cents"),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => policies.id),
    createdAt: createdAt(),
  },
  (t) => [index("match_requests_product_idx").on(t.productId)],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    paypalOrderId: text("paypal_order_id").notNull().unique(),
    paypalCaptureId: text("paypal_capture_id").unique(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    matchRequestId: uuid("match_request_id").references(() => matchRequests.id),
    pricePaidCents: integer("price_paid_cents").notNull(),
    currency: currency(),
    buyerEmail: text("buyer_email"),
    status: orderStatus("status").notNull().default("created"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("orders_price_paid_positive", sql`${t.pricePaidCents} > 0`)],
);

export const protections = pgTable(
  "protections",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    channel3ProductId: text("channel3_product_id").notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
    status: protectionStatus("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [index("protections_product_status_idx").on(t.channel3ProductId, t.status)],
);

export const priceEvents = pgTable(
  "price_events",
  {
    id: id(),
    source: priceEventSource("source").notNull(),
    // Delivery ID (svix-id for webhooks) so a redelivered event is stored once.
    externalId: text("external_id").unique(),
    channel3ProductId: text("channel3_product_id").notNull(),
    productId: uuid("product_id").references(() => products.id),
    domain: text("domain"),
    oldPriceCents: integer("old_price_cents"),
    newPriceCents: integer("new_price_cents").notNull(),
    currency: currency(),
    // null: the delivery carried no signature to check.
    verified: boolean("verified"),
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("price_events_product_idx").on(t.channel3ProductId)],
);

export const refunds = pgTable(
  "refunds",
  {
    id: id(),
    protectionId: uuid("protection_id")
      .notNull()
      .references(() => protections.id),
    priceEventId: uuid("price_event_id")
      .notNull()
      .references(() => priceEvents.id),
    amountCents: integer("amount_cents").notNull(),
    currency: currency(),
    // Stable PayPal-Request-Id (protection + price event) so a retry can't pay twice.
    paypalRequestId: text("paypal_request_id").notNull().unique(),
    paypalRefundId: text("paypal_refund_id").unique(),
    status: refundStatus("status").notNull(),
    decisionReasons: jsonb("decision_reasons").$type<DecisionReason[]>().notNull().default([]),
    approvedBy: refundApprover("approved_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most one refund per order per price drop.
    unique("refunds_protection_price_event_unique").on(t.protectionId, t.priceEventId),
    check("refunds_amount_positive", sql`${t.amountCents} > 0`),
  ],
);

export const ledgerEvents = pgTable(
  "ledger_events",
  {
    id: id(),
    paypalEventId: text("paypal_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id"),
    verified: boolean("verified").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_events_resource_idx").on(t.resourceId)],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
