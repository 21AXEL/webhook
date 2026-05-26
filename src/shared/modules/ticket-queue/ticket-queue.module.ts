// ticket-queue.module.ts

import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { TICKET_QUEUE_MODEL, TicketQueueSchema } from "./ticket-queue.schema";
import { TicketQueueService } from "./ticket-queue.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TICKET_QUEUE_MODEL, schema: TicketQueueSchema },
    ]),
  ],
  providers: [TicketQueueService],
  exports: [TicketQueueService, MongooseModule],
})
export class TicketQueueModule {}
