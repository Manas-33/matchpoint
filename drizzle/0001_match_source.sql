CREATE TYPE "public"."match_source" AS ENUM('web', 'agent');--> statement-breakpoint
ALTER TABLE "match_requests" ADD COLUMN "source" "match_source" DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "match_requests" ADD COLUMN "agent_name" text;