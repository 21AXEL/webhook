// Caso de uso: eliminar una evidencia del array del ticket y borrar el archivo físico
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { unlink } from "fs/promises";
import { join } from "path";
import {
  TICKET_MODEL,
  TicketDocument,
} from "@shared/modules/tickets/ticket.schema";
import { TicketStatus } from "@shared/modules/tickets/ticket.constants";

export interface RemoveEvidenceInput {
  ticketId: string;
  evidenceId: string;
  agentCitizenId: string;
}

@Injectable()
export class RemoveEvidenceUseCase {
  constructor(
    @InjectModel(TICKET_MODEL)
    private readonly ticketModel: Model<TicketDocument>,
  ) {}

  async execute(input: RemoveEvidenceInput): Promise<void> {
    const { ticketId, evidenceId, agentCitizenId } = input;

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
        `Ticket en estado ${ticket.status}, no se puede modificar`,
      );
    }

    const evidence = ticket.evidences.find(
      (e) => e._id.toString() === evidenceId,
    );
    if (!evidence)
      throw new NotFoundException(`Evidencia ${evidenceId} no encontrada`);

    if (evidence.uploadedBy !== agentCitizenId) {
      throw new ForbiddenException(
        "Solo el agente que subió la evidencia puede eliminarla",
      );
    }

    // Primero elimina el documento, luego el archivo (orden seguro)
    await this.ticketModel
      .updateOne(
        { _id: ticketId },
        { $pull: { evidences: { _id: new Types.ObjectId(evidenceId) } } },
      )
      .exec();

    try {
      await unlink(join(process.cwd(), evidence.storagePath));
    } catch {
      // El archivo puede haberse eliminado manualmente — no es crítico
    }
  }
}
