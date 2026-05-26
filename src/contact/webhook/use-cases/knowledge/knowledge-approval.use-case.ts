import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { KnowledgeService } from "../../services/knowledge.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { UserService } from "@shared/modules/user/user.service";

@Injectable()
export class KnowledgeApprovalUseCase {
  private readonly logger = new Logger(KnowledgeApprovalUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly knowledgeService: KnowledgeService,
    private readonly whatsAppService: WhatsAppService,
    private readonly userService: UserService,
  ) {}

  async execute(conversation: any, message: any = {}): Promise<any> {
    try {
      if (!conversation) {
        throw new Error("Conversación no encontrada");
      }

      const conversationId = conversation._id;
      const senderId = conversation.senderId;
      const currentState = conversation.state;

      const user = await this.userService.getById(conversation.userId);
      if (
        !user ||
        !user.role ||
        !(await this._userHasApprovalPermission(user))
      ) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No tienes permisos para aprobar documentos. Esta función está reservada para administradores del sistema.",
        );
        return {
          success: false,
          message: "Usuario sin permisos de aprobación",
          nextState: "initial",
        };
      }

      if (
        message.type === "interactive" &&
        message.interactive &&
        message.interactive.button_reply
      ) {
        const buttonId = message.interactive.button_reply.id;

        if (buttonId === "kauc_approve_yes") {
          return await this.processApprovalDecision(conversationId, "yes");
        } else if (buttonId === "kauc_approve_no") {
          return await this.processApprovalDecision(conversationId, "no");
        } else if (buttonId === "kauc_review_now") {
          this.logger.log("Usuario solicitó revisión inmediata del documento");
        } else if (buttonId === "kauc_review_later") {
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Has decidido revisar el documento más tarde. Puedes acceder a él a través del panel de administración o utilizando el comando para listar documentos pendientes.",
          );
          await this.conversationService.updateState(
            conversationId,
            "initial",
            conversation.state,
          );
          return {
            success: true,
            message: "Revisión pospuesta",
            nextState: "initial",
          };
        } else {
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Opción no reconocida. Por favor, usa las opciones proporcionadas.",
          );
          return {
            success: false,
            message: "Botón no reconocido",
            nextState: currentState,
          };
        }
      }

      if (
        currentState === "knowledge_approval_review" &&
        message.type !== "interactive"
      ) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, indica si apruebas o rechazas el documento utilizando los botones proporcionados.",
        );
        return {
          success: false,
          message: "Se requiere respuesta mediante botones",
          nextState: currentState,
        };
      }

      let documentId: string | undefined;
      if (
        conversation.knowledgeData &&
        conversation.knowledgeData.lastUploadId
      ) {
        documentId = conversation.knowledgeData.lastUploadId;
      } else {
        if (message.type === "text" && message.text) {
          const text = message.text.toLowerCase().trim();
          if (text.includes("listar") || text.includes("pendientes")) {
            return await this.listPendingDocuments(conversation);
          }
        }

        await this.whatsAppService.sendTextMessage(
          senderId,
          'No hay documentos pendientes de revisión. Puedes utilizar el comando "listar pendientes" para ver los documentos que requieren aprobación.',
        );
        return {
          success: false,
          message: "No hay documento para revisar",
          nextState: "initial",
        };
      }

      const document = await this.knowledgeService.getById(
        documentId?.toString(),
      );

      if (!document) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se encontró el documento con ID: ${documentId}.`,
        );
        return {
          success: false,
          message: "Documento no encontrado",
          nextState: "initial",
        };
      }

      if (document.approved) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `El documento "${document.topic}" ya ha sido aprobado previamente.`,
        );
        return {
          success: true,
          message: "Documento ya aprobado",
          documentId: documentId,
          nextState: "initial",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastUploadId: documentId,
        topic: document.topic,
        documentTitle: document.topic,
        status: "pending_approval",
      });

      await this.conversationService.updateState(
        conversationId,
        "knowledge_approval_review",
        conversation.state,
      );

      let reviewMessage = `📄 *Revisión de documento*\n\n`;
      reviewMessage += `*Título:* ${document.topic}\n`;
      if (document.keywords && document.keywords.length > 0) {
        reviewMessage += `*Palabras clave:* ${document.keywords.join(", ")}\n`;
      }
      reviewMessage += `*Tipo:* ${this._getDocumentTypeLabel(document.documentType)}\n`;
      reviewMessage += `*Creado por:* ${document.creator ? `ID: ${document.creator}` : "Usuario desconocido"}\n\n`;

      await this.whatsAppService.sendTextMessage(senderId, reviewMessage);

      const contentPreview =
        document.content.length > 300
          ? document.content.substring(0, 297) + "..."
          : document.content;

      await this.whatsAppService.sendTextMessage(
        senderId,
        `*Vista previa del contenido:*\n\n${contentPreview}\n\n¿Deseas aprobar este documento para su publicación en la base de conocimiento?`,
      );

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Aprobación de Documento",
        bodyText: "¿Apruebas este documento para su publicación?",
        footerText: "Una vez aprobado, estará disponible para consulta",
        buttons: [
          { id: "kauc_approve_yes", text: "Sí, aprobar" },
          { id: "kauc_approve_no", text: "No, rechazar" },
        ],
      });

      return {
        success: true,
        message: "Proceso de aprobación iniciado",
        documentId: documentId,
        nextState: "knowledge_approval_review",
      };
    } catch (error) {
      this.logger.error("Error en execute de KnowledgeApprovalUseCase:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async listPendingDocuments(conversation: any): Promise<any> {
    try {
      const senderId = conversation.senderId;
      const pendingDocuments =
        await this.knowledgeService.getPendingDocuments();

      if (!pendingDocuments || pendingDocuments.length === 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No hay documentos pendientes de aprobación en este momento.",
        );
        return {
          success: true,
          message: "No hay documentos pendientes",
          nextState: "initial",
        };
      }

      let message = "*Documentos pendientes de aprobación:*\n\n";

      for (let i = 0; i < Math.min(pendingDocuments.length, 5); i++) {
        const doc = pendingDocuments[i];
        message += `*${i + 1}.* ${doc.topic} (ID: ${doc._id})\n`;
        message += `   Tipo: ${this._getDocumentTypeLabel(doc.documentType)}\n`;
        message += `   Creado: ${new Date(doc.createdAt).toLocaleDateString()}\n\n`;
      }

      if (pendingDocuments.length > 5) {
        message += `... y ${pendingDocuments.length - 5} documentos más.\n\n`;
      }

      message +=
        "Para revisar un documento específico, por favor usa el panel administrativo.";

      await this.whatsAppService.sendTextMessage(senderId, message);

      return {
        success: true,
        message: "Lista de documentos pendientes enviada",
        pendingCount: pendingDocuments.length,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error listando documentos pendientes:", error);
      return {
        success: false,
        error: (error as Error).message,
        nextState: "initial",
      };
    }
  }

  async processApprovalDecision(
    conversationId: string,
    decision: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getByIdPopulated(conversationId);
      const senderId = conversation.senderId;

      const documentId = conversation.knowledgeData?.lastUploadId;

      if (!documentId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se encontró referencia al documento para aprobar. Por favor, inicia nuevamente el proceso.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          message: "Referencia de documento no encontrada",
          nextState: "initial",
        };
      }

      const document = await this.knowledgeService.getById(documentId);

      if (!document) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El documento ya no existe o ha sido eliminado.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          message: "Documento no encontrado",
          nextState: "initial",
        };
      }

      if (decision === "yes") {
        await this.knowledgeService.approve(
          documentId,
          conversation.userId?.toString(),
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          `✅ Documento "${document.topic}" aprobado exitosamente.\n\nEl documento ahora está disponible en la base de conocimiento y puede ser consultado por los usuarios.`,
        );
        if (document.creator) {
          this._notifyDocumentCreator(document);
        }
      } else {
        await this.knowledgeService.update(
          documentId,
          {
            approved: false,
            processingStatus: {
              status: "rejected",
              statusMessage: "Rechazado por administrador",
              updatedAt: new Date(),
            },
          },
          conversation.userId?.toString(),
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          `❌ Documento "${document.topic}" rechazado.\n\nEl documento no será publicado en la base de conocimiento.`,
        );
      }

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      return {
        success: true,
        message:
          decision === "yes" ? "Documento aprobado" : "Documento rechazado",
        approved: decision === "yes",
        documentId: documentId,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando decisión de aprobación:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _userHasApprovalPermission(user: any): Promise<boolean> {
    if (!user) return false;

    try {
      if (user.role && user.role.name === "Administrador") return true;

      if (user.role && user.role.permisos) {
        return user.role.permisos.some(
          (permiso: any) =>
            permiso.name === "approve_knowledge" && permiso.method === "put",
        );
      }
      return false;
    } catch (error) {
      this.logger.error(`Error verificando permisos de aprobación: ${error}`);
      return false;
    }
  }

  private _notifyDocumentCreator(document: any): void {
    this.logger.log(
      `Notificación de aprobación para documento: ${document._id}`,
    );
    this.logger.log(`Creador: ${document.creator}`);
  }

  private _getDocumentTypeLabel(type: string): string {
    const typeMap: Record<string, string> = {
      pdf: "Documento PDF",
      text: "Documento de texto",
      image: "Imagen",
      other: "Otro tipo de archivo",
    };
    return typeMap[type] || "Documento";
  }
}
