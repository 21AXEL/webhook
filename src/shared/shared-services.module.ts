/**
 * shared-services.module.ts
 * Agrupa servicios de infraestructura reutilizables por múltiples dominios.
 *
 * Importar en cualquier módulo que necesite FileProcessor
 * (WebhookModule, futuro KnowledgeModule, TicketModule, etc.).
 */
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { FileProcessor } from "@shared/services/file-processor.service";

@Module({
  imports: [ConfigModule],
  providers: [FileProcessor],
  exports: [FileProcessor],
})
export class SharedServicesModule {}
