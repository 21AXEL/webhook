/**
 * admin.module.ts  ← VERSIÓN ACTUALIZADA
 * Agrega ConsentAdminService al módulo de admin.
 */
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AvailabilityTemplateJob } from "@jobs/availability-template.job";
import { ConsentAdminService } from "./consent-admin.service";

import { ErpModule } from "@shared/modules/erp/erp.module";
import { AgentAvailabilityModule } from "@shared/modules/agent-availability/agent-availability.module";
import { WebhookModule } from "@contact/webhook/webhook.module";
import { AgentConsentModule } from "@shared/modules/agent-consent/agent-consent.module";
import { ConversationService } from "@contact/conversation.service";

@Module({
  imports: [
    ConfigModule,
    ErpModule,
    AgentAvailabilityModule,
    WebhookModule,
    AgentConsentModule,
    WebhookModule,
  ],
  controllers: [AdminController],
  providers: [AdminGuard, AvailabilityTemplateJob, ConsentAdminService],
})
export class AdminModule {}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH REQUERIDO: agent-consent.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// ConsentAdminService usa findAll() que aún no existe en AgentConsentService.
// Agregar este método:
//
//   /** Retorna todos los registros de consentimiento (para listado admin) */
//   async findAll(): Promise<AgentConsentDocument[]> {
//     return this.model.find().exec();
//   }
// ─────────────────────────────────────────────────────────────────────────────
