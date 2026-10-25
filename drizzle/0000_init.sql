CREATE TYPE "public"."glitch_action" AS ENUM('match_typical', 'decline');--> statement-breakpoint
CREATE TYPE "public"."match_decision" AS ENUM('match', 'decline', 'review');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('created', 'approved', 'completed', 'partially_refunded', 'refunded', 'voided', 'failed');--> statement-breakpoint
CREATE TYPE "public"."price_event_source" AS ENUM('webhook', 'poll', 'replay');--> statement-breakpoint
CREATE TYPE "public"."protection_status" AS ENUM('active', 'expired', 'closed');--> statement-breakpoint
CREATE TYPE "public"."refund_approver" AS ENUM('auto', 'owner');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending_approval', 'processing', 'completed', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."unknown_condition_action" AS ENUM('allow', 'review', 'decline');--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"verified" boolean NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_paypal_event_id_unique" UNIQUE("paypal_event_id")
);
--> statement-breakpoint
CREATE TABLE "match_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"competitor_url" text NOT NULL,
	"competitor_domain" text,
	"lookup_snapshot" jsonb,
	"history_stats" jsonb,
	"model" text,
	"model_output" jsonb,
	"decision" "match_decision" NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competitor_price_cents" integer,
	"matched_price_cents" integer,
	"policy_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paypal_order_id" text NOT NULL,
	"paypal_capture_id" text,
	"product_id" uuid NOT NULL,
	"match_request_id" uuid,
	"price_paid_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"buyer_email" text,
	"status" "order_status" DEFAULT 'created' NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "orders_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "orders_price_paid_positive" CHECK ("orders"."price_paid_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"approved_domains" text[] NOT NULL,
	"channel3_collection_id" text,
	"margin_floor_bps" integer NOT NULL,
	"max_discount_bps" integer NOT NULL,
	"protection_days" integer NOT NULL,
	"auto_refund_cap_cents" integer NOT NULL,
	"min_refund_cents" integer NOT NULL,
	"glitch_action" "glitch_action" DEFAULT 'decline' NOT NULL,
	"unknown_condition_action" "unknown_condition_action" DEFAULT 'review' NOT NULL,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_version_unique" UNIQUE("version"),
	CONSTRAINT "policies_margin_floor_bps" CHECK ("policies"."margin_floor_bps" between 0 and 10000),
	CONSTRAINT "policies_max_discount_bps" CHECK ("policies"."max_discount_bps" between 0 and 10000),
	CONSTRAINT "policies_protection_days" CHECK ("policies"."protection_days" >= 0),
	CONSTRAINT "policies_auto_refund_cap" CHECK ("policies"."auto_refund_cap_cents" >= 0),
	CONSTRAINT "policies_min_refund" CHECK ("policies"."min_refund_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "price_event_source" NOT NULL,
	"external_id" text,
	"channel3_product_id" text NOT NULL,
	"product_id" uuid,
	"domain" text,
	"old_price_cents" integer,
	"new_price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"verified" boolean,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_events_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"channel3_product_id" text NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"category" text,
	"variant" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variant_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_url" text,
	"shop_price_cents" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"channel3_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_channel3_product_id_unique" UNIQUE("channel3_product_id"),
	CONSTRAINT "products_shop_price_positive" CHECK ("products"."shop_price_cents" > 0),
	CONSTRAINT "products_unit_cost_non_negative" CHECK ("products"."unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "protections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"channel3_product_id" text NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"status" "protection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protections_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protection_id" uuid NOT NULL,
	"price_event_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"paypal_request_id" text NOT NULL,
	"paypal_refund_id" text,
	"status" "refund_status" NOT NULL,
	"decision_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" "refund_approver",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_paypal_request_id_unique" UNIQUE("paypal_request_id"),
	CONSTRAINT "refunds_paypal_refund_id_unique" UNIQUE("paypal_refund_id"),
	CONSTRAINT "refunds_protection_price_event_unique" UNIQUE("protection_id","price_event_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "match_requests" ADD CONSTRAINT "match_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_requests" ADD CONSTRAINT "match_requests_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_match_request_id_match_requests_id_fk" FOREIGN KEY ("match_request_id") REFERENCES "public"."match_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_events" ADD CONSTRAINT "price_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protections" ADD CONSTRAINT "protections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_protection_id_protections_id_fk" FOREIGN KEY ("protection_id") REFERENCES "public"."protections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_price_event_id_price_events_id_fk" FOREIGN KEY ("price_event_id") REFERENCES "public"."price_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_events_resource_idx" ON "ledger_events" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "match_requests_product_idx" ON "match_requests" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "price_events_product_idx" ON "price_events" USING btree ("channel3_product_id");--> statement-breakpoint
CREATE INDEX "protections_product_status_idx" ON "protections" USING btree ("channel3_product_id","status");