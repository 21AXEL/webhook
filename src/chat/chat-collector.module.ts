import { Global, Module } from "@nestjs/common";
import { ChatResponseCollector } from "./chat-response-collector.service";

/**
 * Módulo global que provee ChatResponseCollector.
 * Al ser @Global(), cualquier módulo puede inyectarlo sin importarlo explícitamente.
 * Esto evita la dependencia circular: ChatModule → WebhookModule ← ChatCollectorModule.
 */
@Global()
@Module({
  providers: [ChatResponseCollector],
  exports: [ChatResponseCollector],
})
export class ChatCollectorModule {}
