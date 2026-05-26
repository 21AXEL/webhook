// Caso de uso: editar la descripción de una evidencia embebida en el ticket
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  TicketDocument,
  EvidenceSubdoc,
  TICKET_MODEL,
} from "@shared/modules/tickets/ticket.schema";
import { TicketStatus } from "@shared/modules/tickets/ticket.constants";

export interface UpdateEvidenceInput {
  ticketId: string;
  evidenceId: string;
  description: string | null;
  agentCitizenId: string;
}

@Injectable()
export class UpdateEvidenceUseCase {
  constructor(
    @InjectModel(TICKET_MODEL)
    private readonly ticketModel: Model<TicketDocument>,
  ) {}

  async execute(input: UpdateEvidenceInput): Promise<EvidenceSubdoc> {
    const { ticketId, evidenceId, description, agentCitizenId } = input;

    if (
      !Types.ObjectId.isValid(ticketId) ||
      !Types.ObjectId.isValid(evidenceId)
    ) {
      throw new BadRequestException("ID inválido");
    }

    const ticket = await this.ticketModel.findById(ticketId).exec();
    if (!ticket)
      throw new NotFoundException(`Ticket ${ticketId} no encontrado`);

    if (
      ticket.status === TicketStatus.Closed ||
      ticket.status === TicketStatus.FalseTicket
    ) {
      throw new ForbiddenException(
        `Ticket en estado ${ticket.status}, no se puede editar`,
      );
    }

    const evidence = ticket.evidences.find(
      (e) => e._id.toString() === evidenceId,
    );
    if (!evidence)
      throw new NotFoundException(`Evidencia ${evidenceId} no encontrada`);

    // Solo el agente que subió la evidencia puede editarla
    if (evidence.uploadedBy !== agentCitizenId) {
      throw new ForbiddenException(
        "Solo el agente que subió la evidencia puede editarla",
      );
    }

    await this.ticketModel
      .updateOne(
        { _id: ticketId, "evidences._id": new Types.ObjectId(evidenceId) },
        { $set: { "evidences.$.description": description } },
      )
      .exec();

    return { ...evidence, description };
  }
}
