-- Lembretes: o horário do agendamento entra na chave, para um horário remarcado ganhar lembretes novos.
-- A tabela ainda não tinha linhas em nenhum ambiente, então a coluna nasce obrigatória.


-- DropIndex
DROP INDEX "notifications_business_id_appointment_ref_kind_key";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "appointment_starts_at" TIMESTAMPTZ(3) NOT NULL;

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_business_id_appointment_ref_kind_appointment__key" ON "notifications"("business_id", "appointment_ref", "kind", "appointment_starts_at");

