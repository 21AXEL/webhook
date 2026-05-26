// src/shared/modules/agent-consent/agent-consent.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export const AGENT_CONSENT_MODEL = "AgentConsent";

export enum ConsentStatus {
  Pending = "PENDING", // Nunca se le ha preguntado o está pendiente
  Accepted = "ACCEPTED", // Aceptó explícitamente
  Declined = "DECLINED", // Rechazó explícitamente
}

export type AgentConsentDocument = HydratedDocument<AgentConsent>;

@Schema({ timestamps: true, collection: "agent_consents" })
export class AgentConsent {
  @Prop({ type: String, required: true, unique: true, index: true })
  citizenId!: string;

  @Prop({ type: String, required: true, trim: true })
  waPhone!: string;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({
    type: String,
    enum: ConsentStatus,
    default: ConsentStatus.Pending,
    index: true,
  })
  status!: ConsentStatus;

  @Prop({ type: Date, default: null })
  consentedAt!: Date | null;

  @Prop({ type: Date, default: null })
  declinedAt!: Date | null;

  /** Última vez que se le mostró el aviso — para no repetirlo en cada saludo */
  @Prop({ type: Date, default: null })
  lastAskedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AgentConsentSchema = SchemaFactory.createForClass(AgentConsent);
