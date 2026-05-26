// agent-availability.module.ts

import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  AGENT_AVAILABILITY_MODEL,
  AgentAvailabilitySchema,
} from "./agent-availability.schema";
import { AgentAvailabilityService } from "./agent-availability.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AGENT_AVAILABILITY_MODEL, schema: AgentAvailabilitySchema },
    ]),
  ],
  providers: [AgentAvailabilityService],
  exports: [AgentAvailabilityService, MongooseModule],
})
export class AgentAvailabilityModule {}
