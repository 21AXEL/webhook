// Caso de uso: añadir una evidencia al array embebido del ticket
// El archivo llega ya descargado desde WhatsApp (buffer + metadata)
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  Ticket,
  TicketDocument,
  EvidenceSubdoc,
  TICKET_MODEL,
} from "@shared/modules/tickets/ticket.schema";
import { TicketStatus } from "@shared/modules/tickets/ticket.constants";
import {
  ensureTicketDir,
  generateFilename,
  buildStoragePath,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
} from "../evidence.storage";
import { extname } from "path";

export interface AddEvidenceInput {
  ticketId: string;
  // Datos del archivo descargado desde WhatsApp
  fileBuffer: Buffer;
  originalName: string;
  mimetype: string;
  // Quién sube la evidencia (agente TIS)
  agentCitizenId: string;
  agentName: string;
  // Descripción opcional del contexto de la evidencia
  description?: string;
}

@Injectable()
export class AddEvidenceUseCase {
  constructor(
    @InjectModel(TICKET_MODEL)
    private readonly ticketModel: Model<TicketDocument>,
  ) {}

  async execute(input: AddEvidenceInput): Promise<EvidenceSubdoc> {
    const {
      ticketId,
      fileBuffer,
      originalName,
      mimetype,
      agentCitizenId,
      agentName,
      description,
    } = input;

    if (!Types.ObjectId.isValid(ticketId)) {
      throw new BadRequestException("ID de ticket inválido");
    }

    // Validar extensión
    const ext = extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `Extensión no permitida: ${ext}. Permitidas: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
      );
    }

    // Validar tamaño
    if (fileBuffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `El archivo supera el límite de ${MAX_FILE_SIZE / 1024 / 1024} MB`,
      );
    }

    const ticket = await this.ticketModel.findById(ticketId).exec();
    if (!ticket)
      throw new NotFoundException(`Ticket ${ticketId} no encontrado`);

    // No se añaden evidencias a tickets cerrados o marcados como falsos
    if (
      ticket.status === TicketStatus.Closed ||
      ticket.status === TicketStatus.FalseTicket
    ) {
      throw new ForbiddenException(
        `No se pueden añadir evidencias a un ticket en estado ${ticket.status}`,
      );
    }

    // Guardar archivo en disco
    const filename = generateFilename(originalName);
    const dir = ensureTicketDir(ticketId);
    await writeFile(join(dir, filename), fileBuffer);

    const newEvidence = {
      _id: new Types.ObjectId(),
      uploadedBy: agentCitizenId,
      uploadedByName: agentName,
      filename,
      originalName,
      mimetype,
      size: fileBuffer.length,
      storagePath: buildStoragePath(ticketId, filename),
      description: description ?? null,
      createdAt: new Date(),
    };

    await this.ticketModel
      .updateOne({ _id: ticketId }, { $push: { evidences: newEvidence } })
      .exec();

    return newEvidence as EvidenceSubdoc;
  }
}
