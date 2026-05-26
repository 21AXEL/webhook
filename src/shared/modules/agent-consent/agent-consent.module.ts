// agent-consent.module.ts
import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  AGENT_CONSENT_MODEL,
  AgentConsentSchema,
} from "./agent-consent.schema";
import { AgentConsentService } from "./agent-consent.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AGENT_CONSENT_MODEL, schema: AgentConsentSchema },
    ]),
  ],
  providers: [AgentConsentService],
  exports: [AgentConsentService, MongooseModule],
})
export class AgentConsentModule {}
