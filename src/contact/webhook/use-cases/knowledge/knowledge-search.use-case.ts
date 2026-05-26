import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { KnowledgeService } from "../../services/knowledge.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { AiService } from "../../services/ai.service";

@Injectable()
export class KnowledgeSearchUseCase {
  private readonly logger = new Logger(KnowledgeSearchUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly knowledgeService: KnowledgeService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
  ) {}

  async execute(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);

      if (!conversation) {
        throw new Error("Conversación no encontrada");
      }

      const senderId = conversation.senderId;

      await this.conversationService.clearKnowledgeData(conversationId);
      await this.conversationService.updateState(
        conversationId,
        "knowledge_search_query",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "🔍 *Búsqueda en la base de conocimiento*\n\n" +
          "Por favor, ingresa los términos de búsqueda para encontrar información en nuestra base de conocimiento:",
      );

      return {
        success: true,
        message: "Proceso de búsqueda iniciado",
        nextState: "knowledge_search_query",
      };
    } catch (error) {
      this.logger.error("Error iniciando búsqueda de conocimiento:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processSearchQuery(
    conversationId: string,
    query: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (!query || query.trim().length < 3) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, ingresa una consulta más específica (mínimo 3 caracteres):",
        );
        return {
          success: false,
          message: "Consulta demasiado corta",
          nextState: "knowledge_search_query",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastSearch: query.trim(),
        status: "processing",
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        `🔎 Buscando: "${query.trim()}"...`,
      );

      const searchResults = await this.knowledgeService.search(query.trim(), {
        onlyApproved: true,
        onlyActive: true,
        page: 1,
        limit: 5,
      });

      const resultIds = searchResults.data.map((item: any) => item._id);
      await this.conversationService.updateKnowledgeData(conversationId, {
        searchResults: resultIds,
        totalResults: searchResults.pagination.total,
        status: "completed",
      });

      await this.showSearchResults(conversationId, searchResults);

      return {
        success: true,
        message: "Búsqueda procesada",
        resultsCount: searchResults.data.length,
        totalResults: searchResults.pagination.total,
        nextState:
          searchResults.data.length > 0
            ? "knowledge_results_selection"
            : "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando búsqueda:", error);

      try {
        const senderId = (
          await this.conversationService.getById(conversationId)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al procesar tu búsqueda. Por favor, intenta nuevamente más tarde.",
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

  async showSearchResults(
    conversationId: string,
    searchResults: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (!searchResults.data || searchResults.data.length === 0) {
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "❌ No se encontraron resultados para tu búsqueda. Por favor, intenta con otros términos.",
        );
        return {
          success: true,
          message: "No hay resultados",
          nextState: "initial",
        };
      }

      let resultMessage = `✅ *Resultados de búsqueda (${searchResults.data.length})*\n\n`;

      if (searchResults.data.length <= 3) {
        await this.conversationService.updateState(
          conversationId,
          "knowledge_results_display",
          conversation.state,
        );

        for (let i = 0; i < searchResults.data.length; i++) {
          const doc = searchResults.data[i];
          const contentPreview =
            doc.summary ||
            doc.content?.substring(0, 200) +
              (doc.content?.length > 200 ? "..." : "") ||
            "Sin contenido disponible";

          await this.whatsAppService.sendTextMessage(
            senderId,
            `*${i + 1}. ${doc.topic}*\n\n${contentPreview}\n\n` +
              (doc.keywords?.length > 0
                ? `🏷️ *Palabras clave:* ${doc.keywords.join(", ")}\n`
                : ""),
          );
        }

        if (searchResults.data.length > 1) {
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Si deseas ver el contenido completo de algún documento, escribe 'ver X' donde X es el número del documento.",
          );
        }

        return {
          success: true,
          message: "Resultados mostrados directamente",
          nextState: "knowledge_results_display",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "knowledge_results_selection",
        conversation.state,
      );

      const options = searchResults.data.map((doc: any, index: number) => ({
        id: `know_result_${index}`,
        title: this._truncateTitle(doc.topic || `Resultado ${index + 1}`, 24),
        description: doc.summary
          ? this._truncateText(doc.summary, 60)
          : doc.content
            ? this._truncateText(doc.content, 60)
            : "Ver información completa",
      }));

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText: resultMessage,
        headerText: "Resultados encontrados",
        buttonText: "Ver resultados",
        sections: [
          {
            title: "Resultados de búsqueda",
            rows: options,
          },
        ],
      });

      return {
        success: true,
        message: "Lista de resultados mostrada",
        nextState: "knowledge_results_selection",
      };
    } catch (error) {
      this.logger.error("Error mostrando resultados:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processResultSelection(
    conversationId: string,
    selection: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const knowledgeData = conversation.knowledgeData;

      let selectedIndex = -1;

      if (typeof selection === "string") {
        if (selection.startsWith("know_result_")) {
          selectedIndex = parseInt(selection.replace("know_result_", ""), 10);
        } else if (selection.startsWith("ver ")) {
          selectedIndex = parseInt(selection.replace("ver ", ""), 10) - 1;
        } else {
          selectedIndex = parseInt(selection, 10) - 1;
        }
      } else if (typeof selection === "number") {
        selectedIndex = selection - 1;
      }

      if (
        isNaN(selectedIndex) ||
        selectedIndex < 0 ||
        !knowledgeData.searchResults ||
        selectedIndex >= knowledgeData.searchResults.length
      ) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Selección no válida. Por favor, selecciona uno de los resultados mostrados.",
        );
        return {
          success: false,
          message: "Selección inválida",
          nextState: "knowledge_results_selection",
        };
      }

      const documentId = knowledgeData.searchResults[selectedIndex];
      const document = await this.knowledgeService.getById(documentId);

      if (!document) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no se pudo recuperar el documento seleccionado.",
        );
        return {
          success: false,
          message: "Documento no encontrado",
          nextState: "initial",
        };
      }

      await this.showDocument(conversationId, document);

      return {
        success: true,
        message: "Documento mostrado",
        documentId: document._id,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando selección:", error);

      try {
        const senderId = (
          await this.conversationService.getById(conversationId)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al mostrar el documento. Por favor, intenta nuevamente.",
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

  async showDocument(conversationId: string, document: any): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      let docMessage = `📄 *${document.topic}*\n`;

      if (document.keywords && document.keywords.length > 0) {
        docMessage += `\n🏷️ *Palabras clave:* ${document.keywords.join(", ")}\n`;
      }

      let content = document.content || "";
      const maxLength = 3000;

      if (content.length <= maxLength) {
        docMessage += `\n${content}`;
        await this.whatsAppService.sendTextMessage(senderId, docMessage);
      } else {
        await this.whatsAppService.sendTextMessage(senderId, docMessage);

        let remaining = content;
        let partNum = 1;
        const totalParts = Math.ceil(content.length / maxLength);

        while (remaining.length > 0) {
          let currentPart: string;

          if (remaining.length <= maxLength) {
            currentPart = remaining;
            remaining = "";
          } else {
            let cutPoint = remaining
              .substring(0, maxLength)
              .lastIndexOf("\n\n");
            if (cutPoint === -1 || cutPoint < maxLength * 0.5) {
              cutPoint = remaining.substring(0, maxLength).lastIndexOf(". ");
            }
            if (cutPoint === -1 || cutPoint < maxLength * 0.5) {
              cutPoint = maxLength;
            } else {
              cutPoint += 2;
            }

            currentPart = remaining.substring(0, cutPoint);
            remaining = remaining.substring(cutPoint);
          }

          const partHeader =
            totalParts > 1 ? `*Parte ${partNum}/${totalParts}*\n\n` : "";
          await this.whatsAppService.sendTextMessage(
            senderId,
            partHeader + currentPart,
          );
          partNum++;

          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if (document.fileUrl) {
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Documento Original",
          bodyText: "¿Deseas recibir el archivo original de este documento?",
          footerText: document.originalFilename || "Archivo",
          buttons: [
            { id: "know_file_yes", text: "Sí, enviar archivo" },
            { id: "know_file_no", text: "No, gracias" },
          ],
        });

        await this.conversationService.updateState(
          conversationId,
          "knowledge_file_request",
          conversation.state,
        );
        await this.conversationService.updateKnowledgeData(conversationId, {
          lastUploadId: document._id,
        });

        return {
          success: true,
          message: "Documento mostrado, esperando confirmación para archivo",
          nextState: "knowledge_file_request",
        };
      }

      return {
        success: true,
        message: "Documento mostrado",
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error mostrando documento:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processFileRequest(
    conversationId: string,
    response: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      if (response !== "yes") {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "De acuerdo. ¿Hay algo más en lo que pueda ayudarte?",
        );
        return {
          success: true,
          message: "Solicitud de archivo rechazada",
          nextState: "initial",
        };
      }

      const documentId = conversation.knowledgeData?.lastUploadId;

      if (!documentId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no se pudo encontrar el archivo solicitado.",
        );
        return {
          success: false,
          message: "Referencia de documento no encontrada",
          nextState: "initial",
        };
      }

      const document = await this.knowledgeService.getById(documentId);

      if (!document || !document.fileUrl) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, el archivo original no está disponible.",
        );
        return {
          success: false,
          message: "Archivo no disponible",
          nextState: "initial",
        };
      }

      await this.whatsAppService.sendFileMessage(
        senderId,
        document.fileUrl,
        `Archivo: ${document.originalFilename || document.topic}`,
      );

      return {
        success: true,
        message: "Archivo enviado",
        fileUrl: document.fileUrl,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando solicitud de archivo:", error);

      try {
        const senderId = (
          await this.conversationService.getById(conversationId)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al enviar el archivo. Por favor, intenta nuevamente más tarde.",
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

  private _truncateTitle(title: string, maxLength = 24): string {
    if (!title) return "Sin título";
    if (title.length <= maxLength) return title;

    const cutPoint = title.lastIndexOf(" ", maxLength - 3);
    if (cutPoint > maxLength * 0.6) {
      return title.substring(0, cutPoint) + "...";
    }
    return title.substring(0, maxLength - 3) + "...";
  }

  private _truncateText(text: string, maxLength = 100): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }
}
