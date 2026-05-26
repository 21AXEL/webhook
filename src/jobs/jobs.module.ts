// jobs.module.ts
// Módulo que registra todos los cron jobs del sistema.
// Se importa en AppModule junto con ScheduleModule.forRoot().

import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AgentAvailabilityModule } from "@shared/modules/agent-availability/agent-availability.module";
import { TicketQueueModule } from "@shared/modules/ticket-queue/ticket-queue.module";
import { ErpModule } from "@shared/modules/erp/erp.module";
import { WebhookModule } from "src/contact/webhook/webhook.module";
import { AvailabilityTemplateJob } from "./availability-template.job";
import { TicketNotificationJob } from "./ticket-notification.job";
import { AvailabilityResetJob } from "./availability-reset.job";
import { AgentConsentModule } from "@shared/modules/agent-consent/agent-consent.module";

@Module({
  imports: [
    ConfigModule,
    AgentAvailabilityModule,
    TicketQueueModule,
    ErpModule,
    WebhookModule, // Re-exporta WhatsAppService
    AgentConsentModule,
  ],
  providers: [
    AvailabilityTemplateJob,
    TicketNotificationJob,
    AvailabilityResetJob,
  ],
})
export class JobsModule {}
