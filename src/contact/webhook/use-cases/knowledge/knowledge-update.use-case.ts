import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { KnowledgeService } from "../../services/knowledge.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { AiService } from "../../services/ai.service";
import { MediaProcessorService } from "../../services/media-processor.service";
import { FileProcessor } from "@shared/services/file-processor.service";

@Injectable()
export class KnowledgeUpdateUseCase {
  private readonly logger = new Logger(KnowledgeUpdateUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly knowledgeService: KnowledgeService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
    private readonly mediaProcessor: MediaProcessorService,
    private readonly fileProcessor: FileProcessor,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      if (!conversation || !message) {
        throw new Error("Conversación o mensaje no válidos");
      }

      const conversationId = conversation._id;

      switch (conversation.state) {
        case "initial":
          return await this.startKnowledgeUpdateProcess(conversationId);
        case "knowledge_update_search":
          return await this.processSearchQuery(conversationId, message);
        case "knowledge_update_selection":
          return await this.processDocumentSelection(conversationId, message);
        case "knowledge_update_field_selection":
          return await this.processFieldSelection(conversationId, message);
        case "knowledge_update_content":
          return await this.processContentUpdate(conversationId, message);
        case "knowledge_update_confirmation":
          return await this.processConfirmation(conversationId, message);
        default:
          return await this.startKnowledgeUpdateProcess(conversationId);
      }
    } catch (error) {
      this.logger.error("Error en KnowledgeUpdateUseCase:", error);

      try {
        const senderId = conversation.senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, ocurrió un error al procesar tu solicitud de actualización. Por favor, intenta nuevamente.",
        );
        await this.conversationService.updateState(
          conversation._id,
          "initial",
          conversation.state,
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

  async startKnowledgeUpdateProcess(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.clearKnowledgeData(conversationId);
      await this.conversationService.updateState(
        conversationId,
        "knowledge_update_search",
        conversation.state,
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        "🔄 *Actualización de Información*\n\n" +
          "Para actualizar información en nuestra base de conocimiento, primero necesito encontrar el documento o contenido que deseas modificar.\n\n" +
          "Por favor, escribe un título o palabras clave relacionadas con el documento que buscas:",
      );

      return {
        success: true,
        message: "Proceso de actualización de conocimiento iniciado",
        nextState: "knowledge_update_search",
      };
    } catch (error) {
      this.logger.error("Error iniciando proceso de actualización:", error);
      throw error;
    }
  }

  async processSearchQuery(conversationId: string, message: any): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      let query = "";
      if (message.type === "text") {
        query = message.text.body;
      } else if (message.type === "interactive") {
        if (message.interactive.type === "button_reply") {
          query = message.interactive.button_reply.title;
        } else if (message.interactive.type === "list_reply") {
          query = message.interactive.list_reply.title;
        }
      } else {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, envía tu búsqueda como texto.",
        );
        return {
          success: false,
          error: "Tipo de mensaje no válido para búsqueda",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastSearch: query,
      });

      const searchResults = await this.knowledgeService.search(query, {
        limit: 5,
        includeDrafts: true,
      });

      if (!searchResults.data || searchResults.data.length === 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no encontré ningún documento que coincida con tu búsqueda. Por favor, intenta con otros términos:",
        );
        return {
          success: false,
          message: "No se encontraron resultados",
          nextState: "knowledge_update_search",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        searchResults: searchResults.data.map((r: any) => r._id),
        totalResults: searchResults.data.length,
      });

      await this.conversationService.updateState(
        conversationId,
        "knowledge_update_selection",
        conversation.state,
      );

      const options = searchResults.data.map((doc: any, index: number) => ({
        id: `knowledge_doc_${index}`,
        title: this._truncateTitle(
          doc.title || doc.documentTitle || `Documento ${index + 1}`,
          24,
        ),
        description: doc.summary
          ? this._truncateText(doc.summary, 60)
          : "Seleccionar este documento",
      }));

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText:
          "He encontrado los siguientes documentos. Por favor, selecciona el que deseas actualizar:",
        headerText: "Documentos encontrados",
        buttonText: "Ver documentos",
        sections: [
          {
            title: "Documentos encontrados",
            rows: options,
          },
        ],
      });

      return {
        success: true,
        message: "Búsqueda procesada, esperando selección",
        resultsCount: searchResults.data.length,
        nextState: "knowledge_update_selection",
      };
    } catch (error) {
      this.logger.error("Error procesando búsqueda:", error);
      throw error;
    }
  }

  async processDocumentSelection(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      let selectedIndex = -1;

      if (
        message.type === "interactive" &&
        message.interactive.type === "list_reply"
      ) {
        const selectionId = message.interactive.list_reply.id;
        const match = selectionId.match(/knowledge_doc_(\d+)/);
        if (match && match[1]) {
          selectedIndex = parseInt(match[1], 10);
        }
      } else if (message.type === "text") {
        const possibleIndex = parseInt(message.text.body, 10) - 1;
        if (!isNaN(possibleIndex) && possibleIndex >= 0) {
          selectedIndex = possibleIndex;
        }
      }

      if (selectedIndex < 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, selecciona una de las opciones proporcionadas o indica el número del documento.",
        );
        return {
          success: false,
          error: "Selección no válida",
          nextState: "knowledge_update_selection",
        };
      }

      const searchResultIds = conversation.knowledgeData?.searchResults || [];

      if (selectedIndex >= searchResultIds.length) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "La opción seleccionada no es válida. Por favor, elige una de las opciones disponibles.",
        );
        return {
          success: false,
          error: "Índice fuera de rango",
          nextState: "knowledge_update_selection",
        };
      }

      const selectedDocumentId = searchResultIds[selectedIndex];
      const selectedDocument =
        await this.knowledgeService.getById(selectedDocumentId);

      if (!selectedDocument) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no pude recuperar el documento seleccionado. Por favor, intenta nuevamente.",
        );
        await this.conversationService.updateState(
          conversationId,
          "knowledge_update_search",
          conversation.state,
        );
        return {
          success: false,
          error: "Documento no encontrado",
          nextState: "knowledge_update_search",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastUploadId: selectedDocumentId,
        documentTitle: selectedDocument.title || selectedDocument.documentTitle,
        fileName: selectedDocument.fileName || "",
        topic: selectedDocument.topic || "",
        content: selectedDocument.content || "",
        summary: selectedDocument.summary || "",
      });

      await this.conversationService.updateState(
        conversationId,
        "knowledge_update_field_selection",
        conversation.state,
      );

      let docSummary = `*Documento seleccionado:*\n\n`;
      docSummary += `📄 *Título:* ${selectedDocument.title || selectedDocument.documentTitle || "Sin título"}\n`;
      if (selectedDocument.topic) {
        docSummary += `🏷️ *Tema:* ${selectedDocument.topic}\n`;
      }
      if (selectedDocument.summary) {
        docSummary += `\n📝 *Resumen:*\n${this._truncateText(selectedDocument.summary, 200)}\n`;
      } else if (selectedDocument.content) {
        docSummary += `\n📝 *Contenido:*\n${this._truncateText(selectedDocument.content, 200)}\n`;
      }

      await this.whatsAppService.sendTextMessage(senderId, docSummary);

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText: "¿Qué campo deseas actualizar?",
        headerText: "Campos disponibles",
        buttonText: "Ver campos",
        sections: [
          {
            title: "Campos disponibles",
            rows: [
              {
                id: "update_field_title",
                title: "Título",
                description: "Actualizar el título del documento",
              },
              {
                id: "update_field_content",
                title: "Contenido",
                description: "Actualizar el contenido principal",
              },
              {
                id: "update_field_summary",
                title: "Resumen",
                description: "Actualizar el resumen o síntesis",
              },
              {
                id: "update_field_topics",
                title: "Tema/Categoría",
                description: "Actualizar la categorización",
              },
            ],
          },
        ],
      });

      return {
        success: true,
        message: "Documento seleccionado, esperando selección de campo",
        documentId: selectedDocumentId,
        nextState: "knowledge_update_field_selection",
      };
    } catch (error) {
      this.logger.error("Error procesando selección de documento:", error);
      throw error;
    }
  }

  async processFieldSelection(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      let selectedField = "";

      if (
        message.type === "interactive" &&
        message.interactive.type === "list_reply"
      ) {
        const selectionId = message.interactive.list_reply.id;
        switch (selectionId) {
          case "update_field_title":
            selectedField = "title";
            break;
          case "update_field_content":
            selectedField = "content";
            break;
          case "update_field_summary":
            selectedField = "summary";
            break;
          case "update_field_topics":
            selectedField = "topic";
            break;
        }
      } else if (message.type === "text") {
        const text = message.text.body.toLowerCase();
        if (text.includes("título") || text.includes("title")) {
          selectedField = "title";
        } else if (text.includes("contenido") || text.includes("content")) {
          selectedField = "content";
        } else if (text.includes("resumen") || text.includes("summary")) {
          selectedField = "summary";
        } else if (
          text.includes("tema") ||
          text.includes("categoría") ||
          text.includes("topic")
        ) {
          selectedField = "topic";
        }
      }

      if (!selectedField) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, selecciona uno de los campos disponibles para actualizar.",
        );
        return {
          success: false,
          error: "Campo no válido",
          nextState: "knowledge_update_field_selection",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        fieldToUpdate: selectedField,
      });
      await this.conversationService.updateState(
        conversationId,
        "knowledge_update_content",
        conversation.state,
      );

      let promptMessage = "";
      switch (selectedField) {
        case "title":
          promptMessage =
            "Por favor, escribe el nuevo título para el documento:";
          break;
        case "content":
          promptMessage =
            "Por favor, escribe el nuevo contenido principal del documento.\n\nPuedes enviar un mensaje largo o varios mensajes consecutivos. Cuando hayas terminado, escribe *FINALIZAR*:";
          break;
        case "summary":
          promptMessage = "Por favor, escribe el nuevo resumen del documento:";
          break;
        case "topic":
          promptMessage =
            "Por favor, escribe el nuevo tema o categoría para este documento:";
          break;
      }

      await this.whatsAppService.sendTextMessage(senderId, promptMessage);

      return {
        success: true,
        message: "Campo seleccionado, esperando nuevo contenido",
        selectedField,
        nextState: "knowledge_update_content",
      };
    } catch (error) {
      this.logger.error("Error procesando selección de campo:", error);
      throw error;
    }
  }

  async processContentUpdate(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (
        message.type === "document" &&
        conversation.knowledgeData?.fieldToUpdate === "content"
      ) {
        if (this.mediaProcessor) {
          const mediaResult = await this.mediaProcessor.processMedia(
            message,
            conversation,
          );

          if (!mediaResult.success) {
            await this.whatsAppService.sendTextMessage(
              senderId,
              "Hubo un problema al procesar el documento. Por favor, intenta enviando el texto directamente.",
            );
            return {
              success: false,
              error: "Error procesando documento",
              nextState: "knowledge_update_content",
            };
          }

          let documentContent = "";
          if (mediaResult.analysis && mediaResult.analysis.content) {
            documentContent = mediaResult.analysis.content;
          } else {
            try {
              const extraction =
                await this.fileProcessor.extractTextFromDocument(
                  mediaResult.filePath,
                );
              documentContent = extraction.content || "";
            } catch (e) {
              this.logger.error("Error extrayendo texto del documento:", e);
            }
          }

          if (!documentContent) {
            await this.whatsAppService.sendTextMessage(
              senderId,
              "No pude extraer texto del documento. Por favor, envía el contenido como texto.",
            );
            return {
              success: false,
              error: "No se pudo extraer texto",
              nextState: "knowledge_update_content",
            };
          }

          await this.conversationService.updateKnowledgeData(conversationId, {
            newContent: documentContent,
          });
          return await this.showUpdateConfirmation(conversationId);
        } else {
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Lo siento, no puedo procesar documentos adjuntos. Por favor, envía el contenido como texto.",
          );
          return {
            success: false,
            error: "Procesador de medios no disponible",
            nextState: "knowledge_update_content",
          };
        }
      }

      if (message.type !== "text") {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, envía el nuevo contenido como texto.",
        );
        return {
          success: false,
          error: "Tipo de mensaje no válido para actualización",
          nextState: "knowledge_update_content",
        };
      }

      const newContent = message.text.body;

      if (
        newContent.toLowerCase() === "finalizar" &&
        conversation.knowledgeData?.fieldToUpdate === "content" &&
        conversation.knowledgeData?.newContent
      ) {
        return await this.showUpdateConfirmation(conversationId);
      }

      if (conversation.knowledgeData?.fieldToUpdate !== "content") {
        await this.conversationService.updateKnowledgeData(conversationId, {
          newContent: newContent,
        });
        return await this.showUpdateConfirmation(conversationId);
      }

      let existingContent = conversation.knowledgeData?.newContent || "";
      const updatedContent = existingContent
        ? existingContent + "\n\n" + newContent
        : newContent;

      await this.conversationService.updateKnowledgeData(conversationId, {
        newContent: updatedContent,
      });
      await this.whatsAppService.sendTextMessage(
        senderId,
        "✓ Contenido recibido. Puedes continuar enviando más texto o escribir *FINALIZAR* cuando hayas terminado.",
      );

      return {
        success: true,
        message: "Contenido acumulado",
        contentLength: updatedContent.length,
        nextState: "knowledge_update_content",
      };
    } catch (error) {
      this.logger.error("Error procesando actualización de contenido:", error);
      throw error;
    }
  }

  async showUpdateConfirmation(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const knowledgeData = conversation.knowledgeData;
      const fieldToUpdate = knowledgeData?.fieldToUpdate;
      const newContent = knowledgeData?.newContent;

      if (!fieldToUpdate || !newContent) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Faltan datos para completar la actualización. Por favor, inicia el proceso nuevamente.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Datos incompletos",
          nextState: "initial",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "knowledge_update_confirmation",
        conversation.state,
      );

      let confirmationMessage = `*Confirmación de Actualización*\n\n`;
      confirmationMessage += `Documento: "${knowledgeData.documentTitle}"\n`;
      confirmationMessage += `Campo a actualizar: ${this._getFieldDisplayName(fieldToUpdate)}\n\n`;
      confirmationMessage += `*Nueva información:*\n`;

      if (fieldToUpdate === "content") {
        confirmationMessage += this._truncateText(newContent, 200);
      } else {
        confirmationMessage += newContent;
      }

      confirmationMessage += "\n\n¿Confirmas esta actualización?";

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Confirmar Actualización",
        bodyText: confirmationMessage,
        footerText:
          "Esta acción actualizará la información en la base de conocimiento",
        buttons: [
          { id: "knowledge_update_confirm_yes", text: "Sí, confirmar" },
          { id: "knowledge_update_confirm_no", text: "No, cancelar" },
        ],
      });

      return {
        success: true,
        message: "Confirmación mostrada",
        nextState: "knowledge_update_confirmation",
      };
    } catch (error) {
      this.logger.error("Error mostrando confirmación:", error);
      throw error;
    }
  }

  async processConfirmation(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      let isConfirmed = false;

      if (
        message.type === "interactive" &&
        message.interactive.type === "button_reply"
      ) {
        isConfirmed =
          message.interactive.button_reply.id ===
          "knowledge_update_confirm_yes";
      } else if (message.type === "text") {
        const text = message.text.body.toLowerCase();
        isConfirmed =
          text.includes("sí") ||
          text.includes("si") ||
          text.includes("confirmar");
      }

      if (!isConfirmed) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Has cancelado la actualización. El documento permanecerá sin cambios.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: true,
          message: "Actualización cancelada",
          nextState: "initial",
        };
      }

      const knowledgeData = conversation.knowledgeData;
      const documentId = knowledgeData?.lastUploadId;
      const fieldToUpdate = knowledgeData?.fieldToUpdate;
      const newContent = knowledgeData?.newContent;

      if (!documentId || !fieldToUpdate || !newContent) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, faltan datos necesarios para completar la actualización. Por favor, inicia el proceso nuevamente.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Datos incompletos para actualización",
          nextState: "initial",
        };
      }

      const updateData: Record<string, any> = {};
      switch (fieldToUpdate) {
        case "title":
          updateData.title = newContent;
          updateData.documentTitle = newContent;
          break;
        case "content":
          updateData.content = newContent;
          break;
        case "summary":
          updateData.summary = newContent;
          break;
        case "topic":
          updateData.topic = newContent;
          break;
      }

      updateData.version = (knowledgeData.version || 1) + 1;

      const updatedDocument = await this.knowledgeService.update(
        documentId,
        updateData,
      );

      if (!updatedDocument) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un problema al actualizar el documento. Por favor, intenta nuevamente más tarde.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Error actualizando documento",
          nextState: "initial",
        };
      }

      await this.whatsAppService.sendTextMessage(
        senderId,
        `✅ *Actualización Completada*\n\n` +
          `El documento "${updatedDocument.title || updatedDocument.documentTitle}" ha sido actualizado correctamente.\n\n` +
          `Campo actualizado: ${this._getFieldDisplayName(fieldToUpdate)}\n` +
          `Nueva versión: ${updatedDocument.version || 1}`,
      );

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      return {
        success: true,
        message: "Documento actualizado correctamente",
        documentId: documentId,
        updatedField: fieldToUpdate,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando confirmación:", error);
      throw error;
    }
  }

  private _truncateTitle(title: string, maxLength = 24): string {
    if (!title) return "Sin título";
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + "...";
  }

  private _truncateText(text: string, maxLength = 100): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  private _getFieldDisplayName(field: string): string {
    const fieldNames: Record<string, string> = {
      title: "Título",
      content: "Contenido",
      summary: "Resumen",
      topic: "Tema/Categoría",
    };
    return fieldNames[field] || field;
  }
}
