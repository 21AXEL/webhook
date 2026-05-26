// Schema y documento del ticket de helpdesk
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import {
  SupportLine,
  TicketCategory,
  TicketStatus,
  RatingValue,
  BLOCKING_STATUSES,
} from "./ticket.constants";

// ─────────────────────────────────────────────
// Sub-documento de calificación
// ─────────────────────────────────────────────

@Schema({ _id: false })
class Rating {
  @Prop({
    type: String,
    enum: [...Object.values(RatingValue), null],
    default: null,
  })
  value!: RatingValue | null;

  @Prop({ type: String, trim: true, default: null })
  comment!: string | null;

  @Prop({ type: Date, default: null })
  ratedAt!: Date | null;
}

// ─────────────────────────────────────────────
// Sub-documento de evidencia (embebido en el ticket)
// ─────────────────────────────────────────────

@Schema({ _id: true, timestamps: { createdAt: true, updatedAt: false } })
export class Evidence {
  _id!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  uploadedBy!: string;

  @Prop({ type: String, required: true, trim: true })
  uploadedByName!: string;

  @Prop({ type: String, required: true })
  filename!: string;

  @Prop({ type: String, required: true, trim: true })
  originalName!: string;

  @Prop({ type: String, required: true })
  mimetype!: string;

  @Prop({ type: Number, required: true })
  size!: number;

  @Prop({ type: String, required: true })
  storagePath!: string;

  @Prop({ type: String, trim: true, default: null })
  description!: string | null;

  createdAt!: Date;
}

export type EvidenceSubdoc = Evidence & { _id: Types.ObjectId };

// ─────────────────────────────────────────────
// Schema principal
// ─────────────────────────────────────────────

@Schema({ timestamps: true, collection: "tickets" })
export class Ticket {
  // Número legible por humanos (ej: TKT-2024-00042)
  @Prop({ type: String, unique: true, index: true })
  ticketNumber!: string;

  // ── Solicitante ──
  @Prop({ type: String, required: true, trim: true, index: true })
  reportedBy!: string;

  @Prop({ type: String, trim: true })
  reportedByName!: string;

  @Prop({ type: String, trim: true, default: null })
  reportedByPhone!: string | null;

  // ── Registro por agente TIS en nombre de otro funcionario ──
  @Prop({ type: String, trim: true, default: null })
  createdByAgent!: string | null;

  @Prop({ type: String, trim: true, default: null })
  createdByAgentName!: string | null;

  // ── Agente TIS asignado (acepta y atiende el ticket) ──────────────────────────
  // Se rellena cuando el ticket pasa de OPEN → IN_PROGRESS mediante assignTicket().
  // Permanece nulo si el ticket lo creó el propio agente ya en estado IN_PROGRESS.
  @Prop({ type: String, trim: true, default: null, index: true })
  assignedTo!: string | null; // cédula del agente TIS

  @Prop({ type: String, trim: true, default: null })
  assignedToName!: string | null;

  @Prop({ type: Date, default: null })
  assignedAt!: Date | null;
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Clasificación ──
  @Prop({ type: String, enum: SupportLine, required: true, index: true })
  line!: SupportLine;

  @Prop({ type: String, enum: TicketCategory, required: true })
  category!: TicketCategory;

  @Prop({ type: String, trim: true, default: null })
  otherDescription!: string | null;

  // ── Detalles del incidente ──
  @Prop({ type: String, required: true, trim: true })
  location!: string;

  @Prop({ type: String, required: true, trim: true })
  description!: string;

  // ── Estado ──
  @Prop({
    type: String,
    enum: TicketStatus,
    default: TicketStatus.Open,
    index: true,
  })
  status!: TicketStatus;

  @Prop({ type: Date, default: null })
  closedAt!: Date | null;

  // ── Token de calificación por correo ──
  @Prop({ type: String, default: null })
  ratingToken!: string | null;

  @Prop({ type: Date, default: null })
  ratingTokenExpiresAt!: Date | null;

  @Prop({
    type: Rating,
    default: () => ({ value: null, comment: null, ratedAt: null }),
  })
  rating!: Rating;

  // ── Evidencias adjuntas ──
  @Prop({ type: [Object], default: [] })
  evidences!: EvidenceSubdoc[];

  createdAt!: Date;
  updatedAt!: Date;
}

export type TicketDocument = HydratedDocument<Ticket> & {
  isBlocking(): boolean;
  isRatable(): boolean;
};

export const TicketSchema = SchemaFactory.createForClass(Ticket);

// ─────────────────────────────────────────────
// Generación automática del número de ticket
// ─────────────────────────────────────────────

TicketSchema.pre("save", async function (next) {
  if (this.isNew && !this.ticketNumber) {
    const year = new Date().getFullYear();
    const count = await this.model().countDocuments({
      createdAt: {
        $gte: new Date(`${year}-01-01`),
        $lt: new Date(`${year + 1}-01-01`),
      },
    });
    this.ticketNumber = `TKT-${year}-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

// ─────────────────────────────────────────────
// Índices compuestos
// ─────────────────────────────────────────────

TicketSchema.index({ reportedBy: 1, status: 1 });
TicketSchema.index({ line: 1, status: 1, createdAt: -1 });
// Índice para panel TIS: buscar tickets asignados a un agente
TicketSchema.index({ assignedTo: 1, status: 1, createdAt: -1 });
// ── Índice único parcial: solo indexa ratingToken cuando es un string real ──
TicketSchema.index(
  { ratingToken: 1 },
  {
    unique: true,
    partialFilterExpression: { ratingToken: { $type: "string" } },
    name: "ratingToken_unique_notnull",
  },
);

// ─────────────────────────────────────────────
// Métodos de instancia
// ─────────────────────────────────────────────

TicketSchema.methods.isBlocking = function (this: TicketDocument): boolean {
  return BLOCKING_STATUSES.has(this.status);
};

TicketSchema.methods.isRatable = function (this: TicketDocument): boolean {
  return this.status === TicketStatus.Resolved && this.rating.value === null;
};

/** Usar con @InjectModel(TICKET_MODEL) */
export const TICKET_MODEL = "ticket";
