-- CreateEnum
CREATE TYPE "segment" AS ENUM ('barbershop', 'salon', 'aesthetics', 'tattoo', 'pet_shop', 'clinic', 'other');

-- CreateEnum
CREATE TYPE "scheduling_provider_kind" AS ENUM ('internal', 'appbarber');

-- CreateEnum
CREATE TYPE "business_status" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('owner', 'manager', 'staff');

-- CreateEnum
CREATE TYPE "channel_type" AS ENUM ('whatsapp_cloud', 'simulator');

-- CreateEnum
CREATE TYPE "channel_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('agent', 'panel');

-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('agent', 'human');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "message_author" AS ENUM ('customer', 'agent', 'staff', 'system');

-- CreateEnum
CREATE TYPE "message_kind" AS ENUM ('text', 'template', 'button', 'interactive', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'reaction', 'other');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'sent', 'delivered', 'read', 'failed');

-- CreateEnum
CREATE TYPE "agent_session_status" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('reminder_24h', 'reminder_2h');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'agent', 'system', 'customer');

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "segment" "segment" NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "status" "business_status" NOT NULL DEFAULT 'active',
    "scheduling_provider" "scheduling_provider_kind" NOT NULL DEFAULT 'internal',
    "provider_config" TEXT,
    "min_lead_minutes" INTEGER NOT NULL DEFAULT 60,
    "max_advance_days" INTEGER NOT NULL DEFAULT 30,
    "slot_interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "agent_name" TEXT,
    "agent_instructions" TEXT,
    "address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "membership_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "type" "channel_type" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_phone" TEXT,
    "waba_id" TEXT,
    "credentials" TEXT,
    "coexistence" BOOLEAN NOT NULL DEFAULT false,
    "status" "channel_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professionals" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "professionals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    "price_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_services" (
    "business_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "duration_minutes" INTEGER,
    "price_cents" INTEGER,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("professional_id","service_id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "professional_id" UUID,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_blocks" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "professional_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "wa_user_id" TEXT,
    "wa_id" TEXT,
    "phone_e164" TEXT,
    "name" TEXT,
    "reminders_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "last_interaction_at" TIMESTAMPTZ(3),
    "anonymized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'scheduled',
    "source" "appointment_source" NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "notes" TEXT,
    "external_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "mode" "conversation_mode" NOT NULL DEFAULT 'agent',
    "handoff_reason" TEXT,
    "human_until" TIMESTAMPTZ(3),
    "assigned_user_id" UUID,
    "agent_state" JSONB,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "author" "message_author" NOT NULL,
    "kind" "message_kind" NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "external_id" TEXT,
    "delivery_status" "delivery_status",
    "error" TEXT,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "transcript" JSON NOT NULL,
    "status" "agent_session_status" NOT NULL DEFAULT 'active',
    "close_reason" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "requests" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL,
    "cache_write_tokens" INTEGER NOT NULL,
    "tool_calls" JSONB NOT NULL,
    "stop_reason" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "appointment_ref" TEXT NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "message_id" UUID,
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_business_id_user_id_key" ON "memberships"("business_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_type_external_id_key" ON "channels"("type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "channels_business_id_id_key" ON "channels"("business_id", "id");

-- CreateIndex
CREATE INDEX "professionals_business_id_active_idx" ON "professionals"("business_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "professionals_business_id_id_key" ON "professionals"("business_id", "id");

-- CreateIndex
CREATE INDEX "services_business_id_active_idx" ON "services"("business_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "services_business_id_id_key" ON "services"("business_id", "id");

-- CreateIndex
CREATE INDEX "professional_services_business_id_service_id_idx" ON "professional_services"("business_id", "service_id");

-- CreateIndex
CREATE INDEX "working_hours_business_id_professional_id_weekday_idx" ON "working_hours"("business_id", "professional_id", "weekday");

-- CreateIndex
CREATE INDEX "schedule_blocks_business_id_starts_at_idx" ON "schedule_blocks"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "customers_business_id_phone_e164_idx" ON "customers"("business_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_id_key" ON "customers"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_wa_user_id_key" ON "customers"("business_id", "wa_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_business_id_wa_id_key" ON "customers"("business_id", "wa_id");

-- CreateIndex
CREATE INDEX "appointments_business_id_starts_at_idx" ON "appointments"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_business_id_professional_id_starts_at_idx" ON "appointments"("business_id", "professional_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_business_id_customer_id_starts_at_idx" ON "appointments"("business_id", "customer_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_business_id_id_key" ON "appointments"("business_id", "id");

-- CreateIndex
CREATE INDEX "conversations_business_id_last_message_at_idx" ON "conversations"("business_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_business_id_id_key" ON "conversations"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_business_id_customer_id_channel_id_key" ON "conversations"("business_id", "customer_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_external_id_key" ON "messages"("external_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_created_at_idx" ON "messages"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_sessions_conversation_id_status_idx" ON "agent_sessions"("conversation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_business_id_id_key" ON "agent_sessions"("business_id", "id");

-- CreateIndex
CREATE INDEX "agent_runs_business_id_created_at_idx" ON "agent_runs"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_business_id_appointment_ref_kind_key" ON "notifications"("business_id", "appointment_ref", "kind");

-- CreateIndex
CREATE INDEX "audit_logs_business_id_created_at_idx" ON "audit_logs"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_business_id_professional_id_fkey" FOREIGN KEY ("business_id", "professional_id") REFERENCES "professionals"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_business_id_service_id_fkey" FOREIGN KEY ("business_id", "service_id") REFERENCES "services"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_professional_id_fkey" FOREIGN KEY ("business_id", "professional_id") REFERENCES "professionals"("business_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_service_id_fkey" FOREIGN KEY ("business_id", "service_id") REFERENCES "services"("business_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_channel_id_fkey" FOREIGN KEY ("business_id", "channel_id") REFERENCES "channels"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_conversation_id_fkey" FOREIGN KEY ("business_id", "conversation_id") REFERENCES "conversations"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_business_id_conversation_id_fkey" FOREIGN KEY ("business_id", "conversation_id") REFERENCES "conversations"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_business_id_session_id_fkey" FOREIGN KEY ("business_id", "session_id") REFERENCES "agent_sessions"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Regras que o Prisma não expressa no schema. Mantidas à mão nesta migration.
-- ---------------------------------------------------------------------------

-- Permite usar igualdade de uuid dentro de um índice GiST.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Impede dois agendamentos ativos sobrepostos para o mesmo profissional.
-- Vale para qualquer origem: agente, painel ou importação.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "business_id" WITH =,
    "professional_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("status" IN ('scheduled', 'confirmed'));

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_time_order" CHECK ("ends_at" > "starts_at");

ALTER TABLE "schedule_blocks"
  ADD CONSTRAINT "schedule_blocks_time_order" CHECK ("ends_at" > "starts_at");

ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_valid" CHECK (
    "weekday" BETWEEN 1 AND 7
    AND "start_minute" >= 0
    AND "end_minute" <= 1440
    AND "start_minute" < "end_minute"
  );

ALTER TABLE "services"
  ADD CONSTRAINT "services_valid" CHECK (
    "duration_minutes" > 0 AND "buffer_minutes" >= 0 AND "price_cents" >= 0
  );

ALTER TABLE "professional_services"
  ADD CONSTRAINT "professional_services_valid" CHECK (
    ("duration_minutes" IS NULL OR "duration_minutes" > 0)
    AND ("price_cents" IS NULL OR "price_cents" >= 0)
  );

ALTER TABLE "businesses"
  ADD CONSTRAINT "businesses_booking_rules" CHECK (
    "min_lead_minutes" >= 0 AND "max_advance_days" > 0 AND "slot_interval_minutes" > 0
  );

-- Todo cliente ativo precisa de alguma identidade. Cliente anonimizado pode não ter nenhuma.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_identity" CHECK (
    "wa_user_id" IS NOT NULL
    OR "wa_id" IS NOT NULL
    OR "phone_e164" IS NOT NULL
    OR "anonymized_at" IS NOT NULL
  );
