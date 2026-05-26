// Módulo raíz del dominio de contacto ciudadano.
// Actualmente encapsula el canal WhatsApp (WebhookModule).
// Al agregar nuevos canales (SMS, email inbound, etc.) se registran aquí.
import { Module } from "@nestjs/common";
import { WebhookModule } from "./webhook/webhook.module";

@Module({
  imports: [WebhookModule],
  // WebhookService y WhatsAppService ya son exportados por WebhookModule
  // — no es necesario re-exportarlos aquí salvo que otro módulo raíz los consuma directamente.
})
export class ContactModule {}
