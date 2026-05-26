// agent-availability.service.ts
// CRUD y consultas sobre los registros de disponibilidad diaria.

import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  AgentAvailability,
  AgentAvailabilityDocument,
  AgentAvailabilitySchema,
  AGENT_AVAILABILITY_MODEL,
  AvailabilityStatus,
} from "./agent-availability.schema";
import { SupportLine } from "@shared/modules/tickets/ticket.constants";

export interface CreateAvailabilityInput {
  citizenId: string;
  waPhone: string;
  name: string;
  line: SupportLine;
  date: string;
  templateMessageId?: string;
}

@Injectable()
export class AgentAvailabilityService {
  private readonly logger = new Logger(AgentAvailabilityService.name);

  constructor(
    @InjectModel(AGENT_AVAILABILITY_MODEL)
    private readonly model: Model<AgentAvailabilityDocument>,
  ) {}

  // ─── Helpers de fecha ─────────────────────────────────────────────────────

  /** Retorna la fecha de hoy en Ecuador (UTC-5) como string YYYY-MM-DD */
  static todayEcuador(): string {
    const now = new Date();
    // UTC-5
    const ect = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    return ect.toISOString().slice(0, 10);
  }

  // ─── Escritura ────────────────────────────────────────────────────────────

  /**
   * Crea el registro del día para un agente.
   * Si ya existe (por el índice único citizenId+date), no lanza error —
   * simplemente retorna el existente. Esto evita duplicados si el job
   * se reintenta.
   */
  async upsertForToday(
    input: CreateAvailabilityInput,
  ): Promise<AgentAvailabilityDocument> {
    const date = input.date ?? AgentAvailabilityService.todayEcuador();

    const doc = await this.model.findOneAndUpdate(
      { citizenId: input.citizenId, date },
      {
        $setOnInsert: {
          citizenId: input.citizenId,
          waPhone: input.waPhone,
          name: input.name,
          line: input.line,
          date,
          status: AvailabilityStatus.Pending,
          respondedAt: null,
          templateMessageId: input.templateMessageId ?? null,
        },
      },
      { upsert: true, new: true },
    );

    return doc!;
  }

  /** Registra la respuesta del agente (disponible o no disponible) */
  async markResponse(
    citizenId: string,
    status: AvailabilityStatus.Available | AvailabilityStatus.Unavailable,
  ): Promise<AgentAvailabilityDocument | null> {
    const date = AgentAvailabilityService.todayEcuador();

    return this.model.findOneAndUpdate(
      { citizenId, date, status: AvailabilityStatus.Pending },
      { $set: { status, respondedAt: new Date() } },
      { new: true },
    );
  }

  /** Marca como EXPIRED todos los PENDING del día anterior */
  async expirePreviousDay(): Promise<number> {
    const today = AgentAvailabilityService.todayEcuador();
    const result = await this.model.updateMany(
      { date: { $lt: today }, status: AvailabilityStatus.Pending },
      { $set: { status: AvailabilityStatus.Expired } },
    );
    return result.modifiedCount;
  }

  // ─── Consultas ────────────────────────────────────────────────────────────

  /** Devuelve todos los agentes AVAILABLE hoy, opcionalmente filtrando por línea */
  async findAvailableToday(
    line?: SupportLine,
  ): Promise<AgentAvailabilityDocument[]> {
    const date = AgentAvailabilityService.todayEcuador();
    const filter: Record<string, any> = {
      date,
      status: AvailabilityStatus.Available,
    };
    if (line) filter["line"] = line;
    return this.model.find(filter).sort({ respondedAt: 1 }).exec();
  }

  /** Devuelve todos los registros de hoy (para reporte al admin) */
  async findAllToday(): Promise<AgentAvailabilityDocument[]> {
    const date = AgentAvailabilityService.todayEcuador();
    return this.model.find({ date }).sort({ line: 1, name: 1 }).exec();
  }

  /** Busca el registro de hoy de un agente por cédula */
  async findTodayByCitizenId(
    citizenId: string,
  ): Promise<AgentAvailabilityDocument | null> {
    const date = AgentAvailabilityService.todayEcuador();
    return this.model.findOne({ citizenId, date });
  }

  /** Busca el registro de hoy de un agente por waPhone */
  async findTodayByPhone(
    waPhone: string,
  ): Promise<AgentAvailabilityDocument | null> {
    const date = AgentAvailabilityService.todayEcuador();
    return this.model.findOne({ waPhone, date });
  }
}
