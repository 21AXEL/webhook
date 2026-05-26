// Caso de uso: listar evidencias de un ticket con su URL de acceso
import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { Model, Types } from "mongoose";
import {
  TicketDocument,
  EvidenceSubdoc,
  TICKET_MODEL,
} from "@shared/modules/tickets/ticket.schema";
import { buildEvidenceUrl } from "../evidence.storage";

export type EvidenceWithUrl = EvidenceSubdoc & { url: string };

@Injectable()
export class ListEvidencesUseCase {
  constructor(
    @InjectModel(TICKET_MODEL)
    private readonly ticketModel: Model<TicketDocument>,
    private readonly configService: ConfigService,
  ) {}

  async execute(ticketId: string): Promise<EvidenceWithUrl[]> {
    if (!Types.ObjectId.isValid(ticketId)) {
      throw new BadRequestException("ID de ticket inválido");
    }

    const ticket = await this.ticketModel
      .findById(ticketId, { evidences: 1 })
      .exec();

    if (!ticket)
      throw new NotFoundException(`Ticket ${ticketId} no encontrado`);

    const baseUrl = this.configService.get<string>("mail.baseUrl") ?? "";

    return ticket.evidences.map((e) => ({
      ...e,
      url: buildEvidenceUrl(baseUrl, ticketId, e.filename),
    }));
  }
}
