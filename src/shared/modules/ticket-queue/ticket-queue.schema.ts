// ticket-queue.schema.ts
// Cola de tickets pendientes de notificación.
// Cada entrada representa un ticket OPEN que el sistema debe notificar
// a los agentes disponibles de la línea correspondiente.

import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import { SupportLine } from "@shared/modules/tickets/ticket.constants";

// ─── Tokens de inyección ──────────────────────────────────────────────────────
export const TICKET_QUEUE_MODEL = "TicketQueue";

// ─── Estado de la entrada en cola ─────────────────────────────────────────────
export enum QueueStatus {
  Pending = "PENDING", // Esperando ser procesado por el job
  Notified = "NOTIFIED", // Ya se notificó — esperando que un agente acepte
  Assigned = "ASSIGNED", // El ticket fue aceptado y asignado
  Expired = "EXPIRED", // Se descartó (fuera de horario sin agentes, etc.)
}

// ─── Tipo de documento ────────────────────────────────────────────────────────
export type TicketQueueDocument = HydratedDocument<TicketQueue>;

// ─── Schema ───────────────────────────────────────────────────────────────────
@Schema({ timestamps: true, collection: "ticket_queue" })
export class TicketQueue {
  /** Referencia al ticket original */
  @Prop({ type: Types.ObjectId, ref: "Ticket", required: true, index: true })
  ticketId!: Types.ObjectId;

  /** Número legible (ej: TKT-2025-00042) */
  @Prop({ type: String, required: true, trim: true })
  ticketNumber!: string;

  /** Línea de soporte — determina qué agentes reciben la notificación */
  @Prop({ type: String, enum: SupportLine, required: true, index: true })
  line!: SupportLine;

  /** Nombre de quien reportó el ticket */
  @Prop({ type: String, required: true, trim: true })
  reportedByName!: string;

  /** Ubicación declarada en el ticket */
  @Prop({ type: String, required: true, trim: true })
  location!: string;

  /** Momento en que se creó el ticket (para calcular tiempo de espera) */
  @Prop({ type: Date, required: true })
  ticketCreatedAt!: Date;

  /** Estado actual de la entrada en la cola */
  @Prop({
    type: String,
    enum: QueueStatus,
    default: QueueStatus.Pending,
    index: true,
  })
  status!: QueueStatus;

  /**
   * Cédulas de agentes que ya recibieron la notificación de este ticket.
   * El job no repite notificaciones al mismo agente.
   */
  @Prop({ type: [String], default: [] })
  notifiedAgents!: string[];

  /** Última vez que se enviaron notificaciones para este ticket */
  @Prop({ type: Date, default: null })
  lastNotifiedAt!: Date | null;

  /**
   * Próxima vez que el job debe procesar esta entrada.
   * null = procesar inmediatamente en el próximo ciclo.
   * Fecha futura = reintentar a partir de esa fecha (ej: 8am del día siguiente).
   */
  @Prop({ type: Date, default: null, index: true })
  nextRetryAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const TicketQueueSchema = SchemaFactory.createForClass(TicketQueue);

// Índice parcial: solo uno por ticket en estado activo
TicketQueueSchema.index(
  { ticketId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: [QueueStatus.Pending, QueueStatus.Notified] },
    },
  },
);
