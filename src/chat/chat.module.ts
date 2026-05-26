import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { WebhookModule } from "@contact/webhook/webhook.module";

@Module({
  imports: [WebhookModule],
  controllers: [ChatController],
  // ChatResponseCollector ya lo provee ChatCollectorModule (global),
  // no hace falta re-declararlo aquí.
})
export class ChatModule {}
