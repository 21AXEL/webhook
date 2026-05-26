import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { TICKET_MODEL, TicketSchema } from "./ticket.schema";
import { TicketService } from "./ticket.service";
import { TicketRateController } from "./ticket-rate.controller";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: TICKET_MODEL, schema: TicketSchema }]),
  ],
  controllers: [TicketRateController],
  providers: [TicketService],
  exports: [TicketService, MongooseModule],
})
export class TicketModule {}
