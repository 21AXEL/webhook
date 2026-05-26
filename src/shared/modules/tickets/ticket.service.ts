import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnprocessableEntityException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { randomUUID } from "crypto";
import {
  Ticket,
  TicketDocument,
  EvidenceSubdoc,
  TICKET_MODEL,
} from "./ticket.schema";
import {
  SupportLine,
  TicketCategory,
  TicketStatus,
  RatingValue,
  CATEGORIES_BY_LINE,
  BLOCKING_STATUSES,
} from "./ticket.constants";

// ─────────────────────────────────────────────
// Tipos de entrada
// ─────────────────────────────────────────────

export interface CreateTicketInput {
  reportedBy: string;
  reportedByName: string;
  reportedByPhone?: string | null;
  createdByAgent?: string | null;
  createdByAgentName?: string | null;
  line: SupportLine;
  category: TicketCategory;
  otherDescription?: string | null;
  location: string;
  description: string;
}

export interface AddEvidenceInput {
  uploadedBy: string;
  uploadedByName: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  storagePath: string;
  description?: string | null;
}

export interface RateTicketInput {
  value: RatingValue;
  comment?: string | null;
}

export interface FindAllFilters {
  line?: SupportLine;
  status?: TicketStatus;
  reportedBy?: string;
  assignedTo?: string;
  skip?: number;
  limit?: number;
}

// ─────────────────────────────────────────────
// Transiciones de estado permitidas
// ─────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Partial<Record<TicketStatus, TicketStatus[]>> = {
  [TicketStatus.Open]: [TicketStatus.InProgress, TicketStatus.FalseTicket],
  [TicketStatus.InProgress]: [TicketStatus.Resolved, TicketStatus.Open],
  [TicketStatus.Resolved]: [TicketStatus.Closed, TicketStatus.InProgress],
};

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

@Injectable()
export class TicketService {
  constructor(
    @InjectModel(TICKET_MODEL)
    private readonly ticketModel: Model<TicketDocument>,
  ) {}

  // ── Creación ────────────────────────────────

  async create(input: CreateTicketInput): Promise<TicketDocument> {
    const validCategories = CATEGORIES_BY_LINE[input.line];
    if (!validCategories.includes(input.category)) {
      throw new BadRequestException(
        `La categoría "${input.category}" no es válida para la línea "${input.line}".`,
      );
    }

    if (
      input.category === TicketCategory.Other &&
      !input.otherDescription?.trim()
    ) {
      throw new BadRequestException(
        "Se requiere `otherDescription` cuando la categoría es OTHER.",
      );
    }

    const blocking = await this.findActiveByFuncionario(input.reportedBy);
    if (blocking) {
      throw new ConflictException(
        `El funcionario ya tiene un ticket activo (${blocking.ticketNumber}, estado: ${blocking.status}).`,
      );
    }

    const ticket = new this.ticketModel({
      ...input,
      otherDescription: input.otherDescription ?? null,
      createdByAgent: input.createdByAgent ?? null,
      createdByAgentName: input.createdByAgentName ?? null,
      reportedByPhone: input.reportedByPhone ?? null,
    });

    return ticket.save();
  }

  // ── Consultas ───────────────────────────────

  async findAll(
    filters: FindAllFilters = {},
  ): Promise<{ data: TicketDocument[]; total: number }> {
    const {
      line,
      status,
      reportedBy,
      assignedTo,
      skip = 0,
      limit = 20,
    } = filters;

    const query: Record<string, unknown> = {};
    if (line) query.line = line;
    if (status) query.status = status;
    if (reportedBy) query.reportedBy = reportedBy;
    if (assignedTo) query.assignedTo = assignedTo;

    const [data, total] = await Promise.all([
      this.ticketModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.ticketModel.countDocuments(query).exec(),
    ]);

    return { data, total };
  }

  async findById(id: string): Promise<TicketDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("ID de ticket inválido.");
    }
    const ticket = await this.ticketModel.findById(id).exec();
    if (!ticket) throw new NotFoundException(`Ticket ${id} no encontrado.`);
    return ticket;
  }

  async findByTicketNumber(ticketNumber: string): Promise<TicketDocument> {
    const ticket = await this.ticketModel.findOne({ ticketNumber }).exec();
    if (!ticket) {
      throw new NotFoundException(`Ticket "${ticketNumber}" no encontrado.`);
    }
    return ticket;
  }

  async findActiveByFuncionario(
    cedula: string,
  ): Promise<TicketDocument | null> {
    return this.ticketModel
      .findOne({
        reportedBy: cedula,
        status: { $in: [...BLOCKING_STATUSES] },
      })
      .exec();
  }

  /**
   * Retorna hasta `limit` tickets OPEN de una línea, ordenados por antigüedad.
   * Usado por el panel TIS para mostrar los pendientes de atención.
   */
  async findOpenByLine(
    line: SupportLine,
    limit = 10,
  ): Promise<TicketDocument[]> {
    return this.ticketModel
      .find({ line, status: TicketStatus.Open })
      .sort({ createdAt: 1 }) // más antiguo primero → más urgente
      .limit(limit)
      .exec();
  }

  /**
   * Retorna el primer ticket RESOLVED sin calificación de un funcionario.
   * Usado en el welcome para mostrar el recordatorio de calificación pendiente.
   */
  async findPendingRatingTicket(
    cedula: string,
  ): Promise<TicketDocument | null> {
    return this.ticketModel
      .findOne({
        reportedBy: cedula,
        status: TicketStatus.Resolved,
        "rating.value": null,
      })
      .sort({ updatedAt: -1 })
      .exec();
  }

  // ── Transiciones de estado ──────────────────

  async updateStatus(
    id: string,
    newStatus: TicketStatus,
  ): Promise<TicketDocument> {
    const ticket = await this.findById(id);
    const allowed = ALLOWED_TRANSITIONS[ticket.status] ?? [];

    if (!allowed.includes(newStatus)) {
      throw new UnprocessableEntityException(
        `No se puede pasar de "${ticket.status}" a "${newStatus}".`,
      );
    }

    ticket.status = newStatus;

    if (newStatus === TicketStatus.Resolved) {
      ticket.ratingToken = randomUUID();
      ticket.ratingTokenExpiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      );
    }

    if (
      newStatus === TicketStatus.Closed ||
      newStatus === TicketStatus.FalseTicket
    ) {
      ticket.closedAt = new Date();
    }

    if (newStatus === TicketStatus.InProgress && ticket.ratingToken) {
      ticket.ratingToken = null;
      ticket.ratingTokenExpiresAt = null;
    }

    return ticket.save();
  }

  /**
   * Asigna un agente TIS al ticket y lo transiciona OPEN → IN_PROGRESS en
   * una sola operación atómica. Emite error si ya está asignado a otro agente.
   */
  async assignTicket(
    id: string,
    agentCitizenId: string,
    agentName: string,
  ): Promise<TicketDocument> {
    const ticket = await this.findById(id);

    if (ticket.status !== TicketStatus.Open) {
      throw new UnprocessableEntityException(
        `Solo se pueden aceptar tickets en estado OPEN. Estado actual: "${ticket.status}".`,
      );
    }

    if (ticket.assignedTo && ticket.assignedTo !== agentCitizenId) {
      throw new ConflictException(
        `El ticket ya fue aceptado por el agente "${ticket.assignedToName}".`,
      );
    }

    ticket.assignedTo = agentCitizenId;
    ticket.assignedToName = agentName;
    ticket.assignedAt = new Date();
    ticket.status = TicketStatus.InProgress;

    // Limpiar token de calificación residual (no debería existir en OPEN, pero por seguridad)
    ticket.ratingToken = null;
    ticket.ratingTokenExpiresAt = null;

    return ticket.save();
  }

  /**
   * Permite al funcionario calificar su ticket directamente vía WhatsApp,
   * sin necesidad del ratingToken de correo (la identidad ya está verificada
   * por el número de teléfono en la conversación).
   */
  async rateDirectly(
    ticketId: string,
    cedula: string,
    input: RateTicketInput,
  ): Promise<TicketDocument> {
    const ticket = await this.findById(ticketId);

    if (ticket.reportedBy !== cedula) {
      throw new ForbiddenException(
        "Solo el funcionario que reportó el ticket puede calificarlo.",
      );
    }

    if (!ticket.isRatable()) {
      throw new ConflictException(
        "Este ticket no puede ser calificado en su estado actual.",
      );
    }

    ticket.rating = {
      value: input.value,
      comment: input.comment ?? null,
      ratedAt: new Date(),
    };

    if (input.value === RatingValue.False) {
      ticket.status = TicketStatus.FalseTicket;
      ticket.closedAt = new Date();
    } else {
      ticket.status = TicketStatus.Closed;
      ticket.closedAt = new Date();
    }

    ticket.ratingToken = null;
    ticket.ratingTokenExpiresAt = null;

    return ticket.save();
  }

  // ── Calificación por token (correo) ─────────

  async rateByToken(
    token: string,
    input: RateTicketInput,
  ): Promise<TicketDocument> {
    const ticket = await this.ticketModel
      .findOne({ ratingToken: token })
      .exec();

    if (!ticket) {
      throw new NotFoundException("Token de calificación inválido.");
    }

    if (
      ticket.ratingTokenExpiresAt &&
      ticket.ratingTokenExpiresAt < new Date()
    ) {
      throw new UnprocessableEntityException(
        "El token de calificación ha expirado.",
      );
    }

    if (!ticket.isRatable()) {
      throw new ConflictException(
        "Este ticket no puede ser calificado en su estado actual.",
      );
    }

    ticket.rating = {
      value: input.value,
      comment: input.comment ?? null,
      ratedAt: new Date(),
    };

    if (input.value === RatingValue.False) {
      ticket.status = TicketStatus.FalseTicket;
      ticket.closedAt = new Date();
    } else {
      ticket.status = TicketStatus.Closed;
      ticket.closedAt = new Date();
    }

    ticket.ratingToken = null;
    ticket.ratingTokenExpiresAt = null;

    return ticket.save();
  }

  // ── Evidencias ──────────────────────────────

  async addEvidence(
    ticketId: string,
    input: AddEvidenceInput,
  ): Promise<TicketDocument> {
    const ticket = await this.findById(ticketId);

    if (!BLOCKING_STATUSES.has(ticket.status)) {
      throw new ConflictException(
        "Solo se puede agregar evidencia a tickets abiertos o en proceso.",
      );
    }

    ticket.evidences.push({
      _id: new Types.ObjectId(),
      ...input,
      description: input.description ?? null,
      createdAt: new Date(),
    } as any);

    return ticket.save();
  }
}
