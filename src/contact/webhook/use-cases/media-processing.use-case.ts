import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../conversation.service";
import { MediaProcessorService } from "../services/media-processor.service";
import { IncidentCreationUseCase } from "./incident/incident-creation.use-case";
import { EmergencyCreationUseCase } from "./emergency/emergency-creation.use-case";
import { KnowledgeCreationUseCase } from "./knowledge/knowledge-creation.use-case";
import { WhatsAppService } from "../services/whatsapp.service";
import { TicketManagementUseCase } from "./tickets/ticket-management.use-case";

@Injectable()
export class MediaProcessingUseCase {
  private readonly logger = new Logger(MediaProcessingUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly mediaProcessor: MediaProcessorService,
    private readonly whatsAppService: WhatsAppService,
    private readonly incidentCreationUseCase: IncidentCreationUseCase,
    private readonly emergencyCreationUseCase: EmergencyCreationUseCase,
    private readonly knowledgeCreationUseCase: KnowledgeCreationUseCase,
    private readonly ticketManagementUseCase: TicketManagementUseCase,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      if (!conversation || !message) {
        throw new Error("Conversación o mensaje no válidos");
      }

      const conversationId = conversation._id;
      const senderId = conversation.senderId;

      const mediaResult = await this.mediaProcessor.processMedia(
        message,
        conversation,
      );

      if (!mediaResult.success) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un problema al procesar tu archivo. Por favor, intenta nuevamente.",
        );
        return {
          success: false,
          error:
            mediaResult.error ||
            "Error desconocido en procesamiento multimedia",
        };
      }

      await this.conversationService.addMessageToHistory(
        conversationId,
        message.caption || `[${message.type}]`,
        true,
        { mediaProcessed: true, mediaResult },
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        `✅ Archivo ${message.type} recibido correctamente.`,
      );

      return await this._routeMediaToUseCase(
        conversation,
        message,
        mediaResult,
      );
    } catch (error) {
      this.logger.error("Error en MediaProcessingUseCase:", error);

      try {
        const senderId = conversation.senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, ocurrió un error al procesar tu archivo. Por favor, intenta nuevamente.",
        );
      } catch (e) {
        this.logger.error("Error enviando mensaje de error:", e);
      }

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _routeMediaToUseCase(
    conversation: any,
    message: any,
    mediaResult: any,
  ): Promise<any> {
    const conversationId = conversation._id;
    const mediaType = mediaResult.mediaType;
    const state = conversation.state;

    // ── Prioridad: recolección de evidencias de ticket ───────────────────────
    if (state === "ticket_mgmt_resolve_evidence_collect") {
      return this.ticketManagementUseCase.handleEvidenceMedia(conversation, {
        filePath: mediaResult.filePath,
        fileName: mediaResult.fileName,
        fileType: mediaResult.fileType,
      });
    }

    // ── Resto del enrutamiento normal ────────────────────────────────────────
    if (mediaType === "image" || mediaType === "video") {
      if (state === "incident_waiting_photo") {
        return await this.incidentCreationUseCase.processPhoto(
          conversationId,
          mediaResult,
        );
      } else if (
        state === "emergency_description" ||
        state === "emergency_confirmation"
      ) {
        await this.conversationService.updateTempIncidentData(conversationId, {
          photos: [mediaResult.filePath],
        });
        return {
          success: true,
          message: "Imagen agregada a reporte de emergencia",
          nextAction: "continueEmergencyFlow",
        };
      } else {
        await this.conversationService.updateTempIncidentData(conversationId, {
          photos: [mediaResult.filePath],
        });
        return await this.incidentCreationUseCase.startIncidentCreation(
          conversationId,
        );
      }
    }

    if (mediaType === "location") {
      const locationData = {
        latitude: message.location?.latitude,
        longitude: message.location?.longitude,
        address: message.location?.address || "",
      };

      if (
        state === "emergency_location" ||
        state === "waiting_emergency_location"
      ) {
        return await this.emergencyCreationUseCase.processLocation(
          conversationId,
          locationData,
        );
      } else if (state === "incident_location") {
        return await this.incidentCreationUseCase.processLocation(
          conversationId,
          locationData,
        );
      } else {
        await this.conversationService.updateTempIncidentData(conversationId, {
          location: {
            latitude: locationData.latitude,
            longitude: locationData.longitude,
            address: locationData.address,
            coordinates: {
              type: "Point",
              coordinates: [locationData.longitude, locationData.latitude],
            },
          },
        });
        return await this.incidentCreationUseCase.startIncidentCreation(
          conversationId,
        );
      }
    }

    if (mediaType === "document") {
      return await this.knowledgeCreationUseCase.processIncomingDocument(
        conversation,
        message,
      );
    }

    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      `He recibido tu archivo ${mediaType}. ¿Qué te gustaría hacer con él? Puedes crear un reporte de incidente o consultar información.`,
    );

    return {
      success: true,
      message: "Archivo procesado sin flujo específico",
      mediaType: mediaType,
      filePath: mediaResult.filePath,
    };
  }
}
