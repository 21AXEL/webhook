// src/shared/modules/agent-consent/agent-consent.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  AGENT_CONSENT_MODEL,
  AgentConsentDocument,
  ConsentStatus,
} from "./agent-consent.schema";

@Injectable()
export class AgentConsentService {
  constructor(
    @InjectModel(AGENT_CONSENT_MODEL)
    private readonly model: Model<AgentConsentDocument>,
  ) {}

  async findAll(): Promise<AgentConsentDocument[]> {
    return this.model.find().exec();
  }

  async findByCitizenId(
    citizenId: string,
  ): Promise<AgentConsentDocument | null> {
    return this.model.findOne({ citizenId }).exec();
  }

  async upsertPending(input: {
    citizenId: string;
    waPhone: string;
    name: string;
  }): Promise<AgentConsentDocument> {
    return this.model.findOneAndUpdate(
      { citizenId: input.citizenId },
      {
        $setOnInsert: {
          citizenId: input.citizenId,
          waPhone: input.waPhone,
          name: input.name,
          status: ConsentStatus.Pending,
          consentedAt: null,
          declinedAt: null,
        },
      },
      { upsert: true, new: true },
    ) as Promise<AgentConsentDocument>;
  }

  async markAccepted(citizenId: string): Promise<void> {
    await this.model.updateOne(
      { citizenId },
      {
        status: ConsentStatus.Accepted,
        consentedAt: new Date(),
        declinedAt: null,
      },
    );
  }

  async markDeclined(citizenId: string): Promise<void> {
    await this.model.updateOne(
      { citizenId },
      {
        status: ConsentStatus.Declined,
        declinedAt: new Date(),
        consentedAt: null,
      },
    );
  }

  async markAsked(citizenId: string): Promise<void> {
    await this.model.updateOne({ citizenId }, { lastAskedAt: new Date() });
  }

  /** Solo los agentes que aceptaron reciben el template */
  async findAllAccepted(): Promise<AgentConsentDocument[]> {
    return this.model.find({ status: ConsentStatus.Accepted }).exec();
  }

  /** True si se debe preguntar de nuevo (nunca se preguntó o hace +7 días) */
  shouldAskAgain(consent: AgentConsentDocument | null): boolean {
    if (!consent || consent.status === ConsentStatus.Pending) return true;
    if (
      consent.status === ConsentStatus.Accepted ||
      consent.status === ConsentStatus.Declined
    )
      return false;
    return false;
  }
}
