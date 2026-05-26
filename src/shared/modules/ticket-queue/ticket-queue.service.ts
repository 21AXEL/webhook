// ticket-queue.service.ts
// Operaciones sobre la cola de notificaciones de tickets.

import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  TicketQueue,
  TicketQueueDocument,
  TICKET_QUEUE_MODEL,
  QueueStatus,
} from "./ticket-queue.schema";
import { SupportLine } from "@shared/modules/tickets/ticket.constants";

export interface EnqueueInput {
  ticketId: string | Types.ObjectId;
  ticketNumber: string;
  line: SupportLine;
  reportedByName: string;
  location: string;
  ticketCreatedAt: Date;
}

@Injectable()
export class TicketQueueService {
  private readonly logger = new Logger(TicketQueueService.name);

  /** Hora de inicio del turno laboral (ECT) */
  static readonly WORK_START_HOUR = 8;
  /** Hora de fin del turno laboral (ECT) */
  static readonly WORK_END_HOUR = 17;

  constructor(
    @InjectModel(TICKET_QUEUE_MODEL)
    private readonly model: Model<TicketQueueDocument>,
  ) {}

  // ─── Helpers de horario ───────────────────────────────────────────────────

  /** Retorna la hora actual en Ecuador (UTC-5) */
  static currentHourEcuador(): number {
    const now = new Date();
    const ect = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    return ect.getUTCHours();
  }

  /** Indica si ahora mismo es horario laboral en Ecuador */
  static isWorkingHour(): boolean {
    const hour = TicketQueueService.currentHourEcuador();
    return (
      hour >= TicketQueueService.WORK_START_HOUR &&
      hour < TicketQueueService.WORK_END_HOUR
    );
  }

  /**
   * Calcula la próxima fecha de inicio de turno laboral (8:00 AM ECT).
   * Si ahora es antes de las 8am devuelve hoy a las 8am;
   * si ya pasó las 5pm devuelve mañana a las 8am.
   */
  static nextWorkStart(): Date {
    const now = new Date();
    // Convertir a ECT
    const ect = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const hour = ect.getUTCHours();

    const next = new Date(ect);
    next.setUTCHours(TicketQueueService.WORK_START_HOUR, 0, 0, 0);

    // Si ya pasó las 8am de hoy, pasar al día siguiente
    if (hour >= TicketQueueService.WORK_START_HOUR) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    // Convertir de vuelta a UTC
    return new Date(next.getTime() + 5 * 60 * 60 * 1000);
  }

  // ─── Escritura ────────────────────────────────────────────────────────────

  /**
   * Agrega un ticket a la cola.
   * Si es horario laboral se notifica en el próximo ciclo del job (nextRetryAt=null).
   * Si es fuera de horario se programa para las 8am del siguiente día.
   * Si ya existe una entrada activa para ese ticket, no hace nada.
   */
  async enqueue(input: EnqueueInput): Promise<TicketQueueDocument> {
    const isWorking = TicketQueueService.isWorkingHour();
    const nextRetryAt = isWorking ? null : TicketQueueService.nextWorkStart();

    this.logger.log(
      `Encolando ticket ${input.ticketNumber} — horario laboral: ${isWorking}` +
        (nextRetryAt
          ? ` — próximo intento: ${nextRetryAt.toISOString()}`
          : " — próximo ciclo del job"),
    );

    // upsert: si ya existe no duplica (el índice parcial protege)
    const doc = await this.model.findOneAndUpdate(
      {
        ticketId: new Types.ObjectId(input.ticketId.toString()),
        status: { $in: [QueueStatus.Pending, QueueStatus.Notified] },
      },
      {
        $setOnInsert: {
          ticketId: new Types.ObjectId(input.ticketId.toString()),
          ticketNumber: input.ticketNumber,
          line: input.line,
          reportedByName: input.reportedByName,
          location: input.location,
          ticketCreatedAt: input.ticketCreatedAt,
          status: QueueStatus.Pending,
          notifiedAgents: [],
          lastNotifiedAt: null,
          nextRetryAt,
        },
      },
      { upsert: true, new: true },
    );

    return doc!;
  }

  /** Registra que un conjunto de agentes fue notificado y programa el reintento */
  async markNotified(
    queueId: string,
    agentCitizenIds: string[],
    retryMinutes = 15,
  ): Promise<void> {
    const nextRetryAt = new Date(Date.now() + retryMinutes * 60 * 1000);
    await this.model.findByIdAndUpdate(queueId, {
      $set: {
        status: QueueStatus.Notified,
        lastNotifiedAt: new Date(),
        nextRetryAt,
      },
      $addToSet: { notifiedAgents: { $each: agentCitizenIds } },
    });
  }

  /** Marca la entrada como ASSIGNED (el ticket ya fue tomado por un agente) */
  async markAssigned(ticketId: string): Promise<void> {
    await this.model.updateOne(
      {
        ticketId: new Types.ObjectId(ticketId),
        status: { $in: [QueueStatus.Pending, QueueStatus.Notified] },
      },
      { $set: { status: QueueStatus.Assigned } },
    );
  }

  /**
   * Reprograma la entrada para las 8am del día siguiente.
   * Se usa cuando no hay agentes disponibles en la línea.
   */
  async rescheduleToNextDay(queueId: string): Promise<void> {
    const nextRetryAt = TicketQueueService.nextWorkStart();
    await this.model.findByIdAndUpdate(queueId, {
      $set: { status: QueueStatus.Pending, nextRetryAt },
    });
  }

  // ─── Consultas ────────────────────────────────────────────────────────────

  /**
   * Devuelve las entradas que el job debe procesar ahora:
   * status PENDING o NOTIFIED y nextRetryAt <= ahora (o null).
   */
  async findDue(): Promise<TicketQueueDocument[]> {
    const now = new Date();
    return this.model
      .find({
        status: { $in: [QueueStatus.Pending, QueueStatus.Notified] },
        $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
      })
      .sort({ ticketCreatedAt: 1 }) // más antiguo primero
      .exec();
  }
}
