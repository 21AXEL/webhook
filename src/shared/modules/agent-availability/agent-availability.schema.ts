// agent-availability.schema.ts
// Registro diario de disponibilidad de cada agente TIS.
// Se crea uno por agente al enviar el template de las 8:00 AM y
// se actualiza cuando el agente responde.

import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { SupportLine } from "@shared/modules/tickets/ticket.constants";

// ─── Tokens de inyección ──────────────────────────────────────────────────────
export const AGENT_AVAILABILITY_MODEL = "AgentAvailability";

// ─── Estado de disponibilidad ─────────────────────────────────────────────────
export enum AvailabilityStatus {
  Pending = "PENDING", // Template enviado, sin respuesta aún
  Available = "AVAILABLE", // Agente confirmó disponibilidad
  Unavailable = "UNAVAILABLE", // Agente confirmó no disponibilidad
  Expired = "EXPIRED", // Fin del día, no respondió
}

// ─── Tipo de documento ────────────────────────────────────────────────────────
export type AgentAvailabilityDocument = HydratedDocument<AgentAvailability>;

// ─── Schema ───────────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: "agent_availabilities" })
export class AgentAvailability {
  /** Cédula del agente TIS */
  @Prop({ type: String, required: true, trim: true, index: true })
  citizenId!: string;

  /** Número en formato WhatsApp (ej: 593XXXXXXXXX) */
  @Prop({ type: String, required: true, trim: true })
  waPhone!: string;

  /** Nombre completo del agente */
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  /** Línea de soporte a la que pertenece el agente */
  @Prop({ type: String, enum: SupportLine, required: true, index: true })
  line!: SupportLine;

  /**
   * Fecha del día laboral en formato YYYY-MM-DD (sin hora).
   * Índice compuesto con citizenId para garantizar unicidad por agente/día.
   */
  @Prop({ type: String, required: true, index: true })
  date!: string; // "2025-05-13"

  /** Estado actual del registro */
  @Prop({
    type: String,
    enum: AvailabilityStatus,
    default: AvailabilityStatus.Pending,
    index: true,
  })
  status!: AvailabilityStatus;

  /** Momento en que el agente respondió */
  @Prop({ type: Date, default: null })
  respondedAt!: Date | null;

  /** ID del mensaje del template enviado (para auditoría) */
  @Prop({ type: String, default: null })
  templateMessageId!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AgentAvailabilitySchema =
  SchemaFactory.createForClass(AgentAvailability);

// Índice compuesto: un registro por agente por día
AgentAvailabilitySchema.index({ citizenId: 1, date: 1 }, { unique: true });
