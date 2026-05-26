import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { KnowledgeService } from "../../services/knowledge.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { UserService } from "@shared/modules/user/user.service";
import { AiService } from "../../services/ai.service";
import { MediaProcessorService } from "../../services/media-processor.service";
import * as path from "path";
import { FileProcessor } from "@shared/services/file-processor.service";

@Injectable()
export class KnowledgeCreationUseCase {
  private readonly logger = new Logger(KnowledgeCreationUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly knowledgeService: KnowledgeService,
    private readonly whatsAppService: WhatsAppService,
    private readonly userService: UserService,
    private readonly aiService: AiService,
    private readonly mediaProcessor: MediaProcessorService,
    private readonly fileProcessor: FileProcessor,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      conversation = await this.conversationService.getByIdPopulated(
        conversation._id,
      );

      if (!conversation) {
        throw new Error("Conversación no encontrada");
      }

      const senderId = conversation.senderId;
      const conversationId = conversation._id;

      if (!conversation.userId) {
        await this.conversationService.updateState(
          conversationId,
          "user_registration",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Para contribuir con documentos al sistema de conocimiento, primero necesitamos registrarte. Por favor, completa el siguiente formulario.",
        );
        const userRegistrationUseCase = {} as any;
        return await userRegistrationUseCase.execute(conversationId);
      }

      const hasPermission = await this._checkUploadPermissions(conversation);
      if (!hasPermission) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo sentimos, no tienes permisos para subir documentos al sistema de conocimiento. Por favor, contacta con un administrador si crees que deberías tener acceso.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Usuario sin permisos para crear conocimiento",
          nextState: "initial",
        };
      }

      if (message.type === "text" && conversation.state) {
        const messageText = message.text.body;

        if (conversation.state === "knowledge_title_input") {
          return await this.processTitle(conversationId, messageText);
        }

        if (conversation.state === "knowledge_content_input") {
          return await this.processContent(conversationId, messageText);
        }
      }

      if (
        message.type === "interactive" ||
        (message &&
          message.interactive &&
          (message.interactive.button_reply || message.interactive.list_reply))
      ) {
        this.logger.log(
          "Detectado mensaje interactivo:",
          JSON.stringify(message),
        );
        return await this.handleInteractiveMessage(conversation, message);
      } else if (message.type === "document") {
        return await this.processIncomingDocument(conversation, message);
      } else {
        await this.conversationService.updateState(
          conversationId,
          "knowledge_type_selection",
          conversation.state,
        );
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Nuevo Documento",
          bodyText:
            "¿Qué tipo de documento deseas agregar al sistema de conocimiento?",
          footerText: "El documento será revisado antes de publicarse",
          buttons: [
            { id: "kcuc_type_text", text: "Texto directo" },
            { id: "kcuc_type_file", text: "Archivo (PDF, etc.)" },
          ],
        });
        return {
          success: true,
          message: "Proceso de creación de conocimiento iniciado",
          nextState: "knowledge_type_selection",
        };
      }
    } catch (error) {
      this.logger.error("Error iniciando creación de conocimiento:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async handleInteractiveMessage(
    conversation: any,
    message: any,
  ): Promise<any> {
    try {
      if (!message.interactive || !message.interactive.button_reply) {
        throw new Error("Formato de mensaje interactivo no válido");
      }

      const buttonId = message.interactive.button_reply.id;
      const conversationId = conversation._id;
      const currentState = conversation.state;

      this.logger.log(
        `Procesando botón: ${buttonId} en estado: ${currentState}`,
      );

      if (!buttonId.startsWith("kcuc_")) {
        this.logger.log(`Botón ${buttonId} no pertenece a este caso de uso`);
        return {
          success: false,
          error: "ID de botón no válido para este caso de uso",
          nextState: currentState,
        };
      }

      if (buttonId === "kcuc_type_text") {
        return await this.processTypeSelection(conversationId, "text");
      } else if (buttonId === "kcuc_type_file") {
        return await this.processTypeSelection(conversationId, "file");
      } else if (buttonId === "kcuc_title_accept") {
        return await this.processTitleConfirmation(conversationId, "accept");
      } else if (buttonId === "kcuc_title_new") {
        return await this.processTitleConfirmation(conversationId, "new");
      } else if (buttonId === "kcuc_confirm_yes") {
        return await this.processConfirmation(conversationId, "yes");
      } else if (buttonId === "kcuc_confirm_no") {
        return await this.processConfirmation(conversationId, "no");
      } else {
        this.logger.log(`Botón no reconocido: ${buttonId}`);
        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          "Opción no reconocida. Por favor, selecciona una de las opciones proporcionadas.",
        );
        return {
          success: false,
          error: "Botón no reconocido",
          nextState: currentState,
        };
      }
    } catch (error) {
      this.logger.error("Error procesando mensaje interactivo:", error);
      try {
        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          "Lo siento, ocurrió un error al procesar tu respuesta. Por favor, intenta nuevamente.",
        );
        return {
          success: false,
          error: (error as Error).message,
          nextState: conversation.state,
        };
      } catch (e) {
        this.logger.error("Error enviando mensaje de error:", e);
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    }
  }

  async processIncomingDocument(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      const senderId = conversation.senderId;

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Recibido. Estoy procesando tu documento para el sistema de conocimiento...",
      );
      await this.conversationService.updateState(
        conversationId,
        "knowledge_processing_file",
        conversation.state,
      );

      const processedMedia = await this.mediaProcessor.processMedia(
        message,
        conversation,
      );

      if (!processedMedia || !processedMedia.success) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No pude procesar el documento. Error: ${processedMedia?.error || "Formato no compatible"}`,
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Error procesando documento",
          nextState: "initial",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        documentType: processedMedia.fileType || "document",
        filePath: processedMedia.filePath,
        fileName: processedMedia.fileName,
        fileType: processedMedia.fileType,
        status: "processing",
        processingProgress: 20,
        captionText: processedMedia.captionText || "",
      });

      const extractionResult = await this.extractFileContent(
        conversation,
        processedMedia.filePath,
      );

      if (!extractionResult.success) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se pudo extraer el contenido del documento: ${extractionResult.error}. Por favor, intenta con otro formato.`,
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Error extrayendo contenido",
          nextState: "initial",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        content: extractionResult.content,
        status: "pending_title",
        processingProgress: 50,
      });

      if (processedMedia.captionText && processedMedia.captionText.length > 3) {
        await this.conversationService.updateKnowledgeData(conversationId, {
          topic: processedMedia.captionText,
          documentTitle: processedMedia.captionText,
          status: "pending_confirmation",
        });
        return await this.showDocumentSummary(conversationId);
      }

      if (extractionResult.suggestedTitle) {
        await this.conversationService.updateKnowledgeData(conversationId, {
          suggestedTitle: extractionResult.suggestedTitle,
        });

        const messageText = `Título sugerido: "${extractionResult.suggestedTitle}"\n\n¿Deseas usar este título o proporcionar uno diferente?`;

        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Título del Documento",
          bodyText: messageText,
          footerText: "Puedes aceptar el sugerido o escribir uno nuevo",
          buttons: [
            { id: "kcuc_title_accept", text: "Usar título sugerido" },
            { id: "kcuc_title_new", text: "Proporcionar otro" },
          ],
        });

        await this.conversationService.updateState(
          conversationId,
          "knowledge_title_confirmation",
          conversation.state,
        );
        return {
          success: true,
          message: "Documento procesado, consultando título",
          suggestedTitle: extractionResult.suggestedTitle,
          nextState: "knowledge_title_confirmation",
        };
      }

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Por favor, proporciona un título para este documento:",
      );
      await this.conversationService.updateState(
        conversationId,
        "knowledge_title_input",
        conversation.state,
      );
      return {
        success: true,
        message: "Documento procesado, solicitando título",
        nextState: "knowledge_title_input",
      };
    } catch (error) {
      this.logger.error("Error procesando documento:", error);
      try {
        const senderId = conversation.senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al procesar el documento. Por favor, intenta nuevamente más tarde.",
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
        nextState: "initial",
      };
    }
  }

  async processTypeSelection(
    conversationId: string,
    documentType: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (documentType === "text") {
        await this.conversationService.updateKnowledgeData(conversationId, {
          documentType: "text",
          status: "pending_title",
        });
        await this.conversationService.updateState(
          conversationId,
          "knowledge_title_input",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, ingresa un título para el documento:",
        );
        return {
          success: true,
          message: "Seleccionado tipo texto, solicitando título",
          nextState: "knowledge_title_input",
        };
      } else if (documentType === "file") {
        await this.conversationService.updateKnowledgeData(conversationId, {
          documentType: "other",
          status: "pending",
        });
        await this.conversationService.updateState(
          conversationId,
          "knowledge_waiting_file",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, envía el archivo que deseas agregar al sistema de conocimiento (PDF, documento de texto, etc.):",
        );
        return {
          success: true,
          message: "Seleccionado tipo archivo, esperando archivo",
          nextState: "knowledge_waiting_file",
        };
      } else {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Tipo de documento no reconocido. Por favor, selecciona una de las opciones proporcionadas.",
        );
        return {
          success: false,
          message: "Tipo de documento no reconocido",
          nextState: "knowledge_type_selection",
        };
      }
    } catch (error) {
      this.logger.error("Error procesando selección de tipo:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processTitle(conversationId: string, title: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (!title || title.trim().length < 3) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El título es demasiado corto. Por favor, proporciona un título más descriptivo:",
        );
        return {
          success: false,
          message: "Título demasiado corto",
          nextState: "knowledge_title_input",
        };
      }

      const knowledgeData = conversation.knowledgeData || {};

      if (knowledgeData.content) {
        await this.conversationService.updateKnowledgeData(conversationId, {
          topic: title.trim(),
          documentTitle: title.trim(),
          status: "pending_confirmation",
        });
        return await this.showDocumentSummary(conversationId);
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        topic: title.trim(),
        documentTitle: title.trim(),
        status: "pending_content",
      });
      await this.conversationService.updateState(
        conversationId,
        "knowledge_content_input",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        `Título: "${title.trim()}"\n\nAhora, por favor, ingresa el contenido del documento:`,
      );
      return {
        success: true,
        message: "Título procesado, solicitando contenido",
        nextState: "knowledge_content_input",
      };
    } catch (error) {
      this.logger.error("Error procesando título:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processContent(conversationId: string, content: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (!content || content.trim().length < 20) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El contenido es demasiado corto. Por favor, proporciona información más detallada:",
        );
        return {
          success: false,
          message: "Contenido demasiado corto",
          nextState: "knowledge_content_input",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        content: content.trim(),
        status: "processing",
      });

      if (this.aiService) {
        await this.processContentWithAI(conversation, content);
      } else {
        const keywords = this._extractBasicKeywords(content);
        await this.conversationService.updateKnowledgeData(conversationId, {
          keywords: keywords,
          status: "pending_confirmation",
        });
      }

      return await this.showDocumentSummary(conversationId);
    } catch (error) {
      this.logger.error("Error procesando contenido:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processTitleConfirmation(
    conversationId: string,
    response: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const knowledgeData = conversation.knowledgeData;

      if (response === "accept" && knowledgeData.suggestedTitle) {
        await this.conversationService.updateKnowledgeData(conversationId, {
          topic: knowledgeData.suggestedTitle,
          documentTitle: knowledgeData.suggestedTitle,
          status: "pending_confirmation",
        });
        return await this.showDocumentSummary(conversationId);
      } else {
        await this.conversationService.updateState(
          conversationId,
          "knowledge_title_input",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, proporciona un título para el documento:",
        );
        return {
          success: true,
          message: "Solicitando título personalizado",
          nextState: "knowledge_title_input",
        };
      }
    } catch (error) {
      this.logger.error("Error procesando confirmación de título:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processFile(conversationId: string, fileData: any): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (!fileData || !fileData.filePath) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se pudo procesar el archivo. Por favor, intenta con otro archivo:",
        );
        return {
          success: false,
          message: "Archivo no válido",
          nextState: "knowledge_waiting_file",
        };
      }

      const extension = path
        .extname(fileData.filePath)
        .toLowerCase()
        .substring(1);
      let documentType = "other";
      if (extension === "pdf") documentType = "pdf";
      else if (["txt", "doc", "docx", "rtf"].includes(extension))
        documentType = "text";

      await this.conversationService.updateKnowledgeData(conversationId, {
        documentType: documentType,
        filePath: fileData.filePath,
        fileName: fileData.fileName || path.basename(fileData.filePath),
        fileType: fileData.fileType || extension,
        status: "processing",
        processingProgress: 10,
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        `Archivo "${fileData.fileName}" recibido. Procesando el contenido...`,
      );
      await this.conversationService.updateState(
        conversationId,
        "knowledge_processing_file",
        conversation.state,
      );

      const extractionResult = await this.extractFileContent(
        conversation,
        fileData.filePath,
      );

      if (!extractionResult.success) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se pudo extraer el contenido del archivo: ${extractionResult.error}. Por favor, intenta con otro archivo.`,
        );
        await this.conversationService.updateState(
          conversationId,
          "knowledge_waiting_file",
          conversation.state,
        );
        return {
          success: false,
          message: "Error extrayendo contenido",
          error: extractionResult.error,
          nextState: "knowledge_waiting_file",
        };
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        content: extractionResult.content,
        status: "pending_title",
        processingProgress: 50,
      });

      let messageText = "Por favor, proporciona un título para este documento:";

      if (extractionResult.suggestedTitle) {
        await this.conversationService.updateKnowledgeData(conversationId, {
          suggestedTitle: extractionResult.suggestedTitle,
        });
        messageText = `Título sugerido: "${extractionResult.suggestedTitle}"\n\n¿Deseas usar este título o proporcionar uno diferente?`;
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Título del Documento",
          bodyText: messageText,
          footerText: "Puedes aceptar el sugerido o escribir uno nuevo",
          buttons: [
            { id: "kcuc_title_accept", text: "Usar título sugerido" },
            { id: "kcuc_title_new", text: "Proporcionar otro" },
          ],
        });
        await this.conversationService.updateState(
          conversationId,
          "knowledge_title_confirmation",
          conversation.state,
        );
        return {
          success: true,
          message: "Archivo procesado, consultando título",
          suggestedTitle: extractionResult.suggestedTitle,
          nextState: "knowledge_title_confirmation",
        };
      }

      await this.whatsAppService.sendTextMessage(senderId, messageText);
      await this.conversationService.updateState(
        conversationId,
        "knowledge_title_input",
        conversation.state,
      );
      return {
        success: true,
        message: "Archivo procesado, solicitando título",
        nextState: "knowledge_title_input",
      };
    } catch (error) {
      this.logger.error("Error procesando archivo:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async extractFileContent(conversation: any, filePath: string): Promise<any> {
    try {
      conversation = await this.conversationService.getByIdPopulated(
        conversation._id,
      );
      if (
        conversation.knowledgeData?.status === "pending_confirmation" ||
        conversation.knowledgeData?.status === "completed" ||
        !filePath
      ) {
        return { success: false, error: "Ya se está procesando un documento" };
      }

      const extractionResult =
        await this.fileProcessor.extractTextFromDocument(filePath);

      if (!extractionResult || !extractionResult.content) {
        return {
          success: false,
          error: "No se pudo extraer contenido del archivo",
        };
      }

      let suggestedTitle = "";
      let keywords = extractionResult.keywords || [];

      if (this.aiService) {
        const aiResult = await this.processFileWithAI(
          conversation,
          extractionResult.content,
        );
        if (aiResult.success) {
          suggestedTitle = aiResult.suggestedTitle;
          if (aiResult.keywords && aiResult.keywords.length > 0)
            keywords = aiResult.keywords;
        }
      } else if (!suggestedTitle) {
        const lines = extractionResult.content
          .split("\n")
          .filter((line: string) => line.trim().length > 0);
        if (lines.length > 0) {
          const firstLine = lines[0].trim();
          if (firstLine.length < 60 && firstLine.length > 3)
            suggestedTitle = firstLine;
        }
      }

      return {
        success: true,
        content: extractionResult.content,
        suggestedTitle: suggestedTitle,
        keywords: keywords,
      };
    } catch (error) {
      this.logger.error("Error extrayendo contenido de archivo:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processConfirmation(
    conversationId: string,
    confirmation: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getByIdPopulated(conversationId);
      const senderId = conversation.senderId;

      if (confirmation !== "yes") {
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Has cancelado la creación del documento. Si deseas iniciar nuevamente, solo indícalo.",
        );
        return {
          success: true,
          message: "Proceso cancelado por el usuario",
          nextState: "initial",
        };
      }

      const userId = conversation.userId;
      const knowledgeData = conversation.knowledgeData;

      if (!knowledgeData.topic || !knowledgeData.content) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se pudo crear el documento debido a que faltan datos esenciales (título o contenido). Por favor, inicia nuevamente el proceso.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Datos incompletos para crear documento",
        };
      }

      const documentData = {
        topic: knowledgeData.topic,
        content: knowledgeData.content,
        keywords: knowledgeData.keywords || [],
        summary: knowledgeData.summary || "",
        documentType: knowledgeData.documentType || "text",
        creator: userId,
        approved: false,
        fileUrl: knowledgeData.filePath || "",
        originalFilename: knowledgeData.fileName || "",
      };

      const document = await this.knowledgeService.create(documentData);

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastUploadId: document._id,
        status: "completed",
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        `✅ *Documento enviado correctamente*\n\nTu documento "${document.topic}" ha sido recibido y será revisado por los administradores antes de ser publicado en el sistema de conocimiento.\n\nGracias por tu contribución.`,
      );

      const hasApprovalPermission =
        await this._checkUploadPermissions(conversation);

      if (hasApprovalPermission) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Como administrador, ¿deseas revisar y aprobar este documento ahora?",
        );
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Aprobación Inmediata",
          bodyText: "¿Revisar el documento para aprobación?",
          footerText: "Puedes aprobarlo ahora o hacerlo más tarde",
          buttons: [
            { id: "kauc_review_now", text: "Revisar ahora" },
            { id: "kauc_review_later", text: "Revisar después" },
          ],
        });
        await this.conversationService.updateState(
          conversationId,
          "knowledge_pre_approval",
          conversation.state,
        );
        return {
          success: true,
          message: "Documento creado, esperando decisión de aprobación",
          documentId: document._id,
          nextState: "knowledge_pre_approval",
        };
      } else {
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: true,
          message: "Documento creado correctamente",
          documentId: document._id,
          nextState: "initial",
        };
      }
    } catch (error) {
      this.logger.error("Error procesando confirmación:", error);
      try {
        const senderId = (
          await this.conversationService.getById(conversationId)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al procesar tu documento. Por favor, intenta nuevamente más tarde.",
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

  async processContentWithAI(conversation: any, content: string): Promise<any> {
    try {
      const conversationId = conversation._id;

      await this.conversationService.updateKnowledgeData(conversationId, {
        processingProgress: 70,
      });

      const messages = [
        {
          role: "system",
          content: `Analiza el siguiente texto y extrae:
        1. Las 5-10 palabras clave más relevantes (separadas por comas)
        2. Un título sugerido breve y descriptivo
        3. Un resumen conciso (máximo 2 a 3 párrafos)
        
        Formatea la respuesta como JSON:
        {
          "keywords": ["palabra1", "palabra2", ...],
          "suggestedTitle": "Título sugerido",
          "summary": "Resumen del contenido..."
        }`,
        },
        { role: "user", content: content },
      ];

      const aiResponse = await this.aiService.query(messages, {
        model: "advanced",
        temperature: 0.3,
      });

      if (!aiResponse || !aiResponse.content) {
        throw new Error("No se recibió respuesta válida de IA");
      }

      let results = { keywords: [], suggestedTitle: "", summary: "" };

      try {
        const jsonStr = aiResponse.content;
        results = this._extractJsonWithRegex(jsonStr);
      } catch (parseError) {
        this.logger.error("Error parseando respuesta de IA:", parseError);
        results = this._extractJsonWithRegex(aiResponse.content);
      }

      this.logger.log("Resultados de IA:", JSON.stringify(results, null, 2));

      await this.conversationService.updateKnowledgeData(conversationId, {
        keywords: results.keywords || [],
        suggestedTitle: results.suggestedTitle || "",
        summary: results.summary || "",
        status: "pending_confirmation",
        processingProgress: 100,
      });

      await this.conversationService.updateState(
        conversationId,
        "knowledge_title_confirmation",
        conversation.state,
      );
      await this.conversationService.updateKnowledgeData(conversationId, {
        status: "pending_confirmation",
      });

      return { success: true, ...results };
    } catch (error) {
      this.logger.error("Error procesando contenido con IA:", error);
      const keywords = this._extractBasicKeywords(content);
      await this.conversationService.updateKnowledgeData(conversation._id, {
        keywords: keywords,
        status: "pending_confirmation",
        processingProgress: 100,
      });
      return {
        success: false,
        error: (error as Error).message,
        keywords: keywords,
      };
    }
  }

  async processFileWithAI(conversation: any, content: string): Promise<any> {
    return this.processContentWithAI(conversation, content);
  }

  async showDocumentSummary(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getByIdPopulated(conversationId);
      const senderId = conversation.senderId;
      const knowledgeData = conversation.knowledgeData;

      await this.conversationService.updateState(
        conversationId,
        "knowledge_confirmation",
        conversation.state,
      );

      let summaryMessage = "*Resumen del documento*\n\n";
      summaryMessage += `*Título:* ${knowledgeData.topic || "No especificado"}\n`;
      if (knowledgeData.documentType) {
        summaryMessage += `*Tipo:* ${this._getDocumentTypeLabel(knowledgeData.documentType)}\n`;
      }
      if (knowledgeData.keywords && knowledgeData.keywords.length > 0) {
        summaryMessage += `*Palabras clave:* ${knowledgeData.keywords.join(", ")}\n`;
      }
      if (knowledgeData.summary) {
        summaryMessage += `\n*Resumen:* ${knowledgeData.summary}\n`;
      }
      if (!knowledgeData.summary) {
        const contentPreview = knowledgeData.content
          ? knowledgeData.content.substring(0, 150) +
            (knowledgeData.content.length > 150 ? "..." : "")
          : "No disponible";
        summaryMessage += `\n*Vista previa:* ${contentPreview}\n`;
      }
      summaryMessage +=
        "\n¿Confirmas esta información para añadir el documento al sistema de conocimiento?";

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Confirmación de Documento",
        bodyText: summaryMessage,
        footerText: "El documento será revisado antes de publicarse",
        buttons: [
          { id: "kcuc_confirm_yes", text: "Sí, enviar documento" },
          { id: "kcuc_confirm_no", text: "No, cancelar" },
        ],
      });

      return {
        success: true,
        message: "Resumen mostrado, esperando confirmación",
        nextState: "knowledge_confirmation",
      };
    } catch (error) {
      this.logger.error("Error mostrando resumen:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _checkUploadPermissions(conversation: any): Promise<boolean> {
    if (!conversation.userId) return false;

    try {
      const user = await this.userService.getById(conversation.userId);
      if (!user) return false;

      if (user.role?.name === "Administrador") return true;

      if (user.role?.permisos) {
        return user.role.permisos.some(
          (permiso: any) =>
            permiso.name === "upload_knowledge" && permiso.method === "post",
        );
      }
      return false;
    } catch (error) {
      this.logger.error(`Error verificando permisos: ${error}`);
      return false;
    }
  }

  private _extractJsonWithRegex(text: string | any): any {
    const result: {
      keywords: string[];
      suggestedTitle: string;
      summary: string;
    } = {
      keywords: [],
      suggestedTitle: "",
      summary: "",
    };

    if (text && typeof text === "object") {
      if (Array.isArray(text.keywords)) result.keywords = text.keywords;
      if (typeof text.suggestedTitle === "string")
        result.suggestedTitle = text.suggestedTitle;
      if (typeof text.summary === "string") result.summary = text.summary;
      return result;
    }

    const textStr = String(text || "");

    try {
      const parsedJson = JSON.parse(textStr);
      if (parsedJson && typeof parsedJson === "object") {
        if (Array.isArray(parsedJson.keywords))
          result.keywords = parsedJson.keywords;
        if (typeof parsedJson.suggestedTitle === "string")
          result.suggestedTitle = parsedJson.suggestedTitle;
        if (typeof parsedJson.summary === "string")
          result.summary = parsedJson.summary;
        return result;
      }
    } catch (error) {
      this.logger.log("No es un JSON válido, usando regex para extraer datos");
    }

    const keywordsMatch = textStr.match(/"keywords"\s*:\s*\[(.*?)\]/s);
    if (keywordsMatch && keywordsMatch[1]) {
      const keywordsStr = keywordsMatch[1].replace(/"/g, "").replace(/'/g, "");
      result.keywords = keywordsStr
        .split(",")
        .map((k: string) => k.trim())
        .filter((k: string) => k);
    }

    const titleMatch = textStr.match(/"suggestedTitle"\s*:\s*"(.*?)"/s);
    if (titleMatch && titleMatch[1])
      result.suggestedTitle = titleMatch[1].trim();

    const summaryMatch = textStr.match(/"summary"\s*:\s*"(.*?)"/s);
    if (summaryMatch && summaryMatch[1])
      result.summary = summaryMatch[1].trim();

    return result;
  }

  private _extractBasicKeywords(text: string): string[] {
    if (!text) return [];

    const stopwords = [
      "el",
      "la",
      "los",
      "las",
      "un",
      "una",
      "unos",
      "unas",
      "y",
      "o",
      "a",
      "ante",
      "bajo",
      "con",
      "de",
      "desde",
      "en",
      "entre",
      "hacia",
      "hasta",
      "para",
      "por",
      "según",
      "sin",
      "sobre",
      "tras",
      "que",
      "este",
      "esta",
      "estos",
      "estas",
      "ese",
      "esa",
      "esos",
      "esas",
      "del",
    ];

    const words = text
      .toLowerCase()
      .replace(/[^\wáéíóúüñ ]/g, " ")
      .split(/\s+/)
      .filter((word: string) => word.length > 3)
      .filter((word: string) => !stopwords.includes(word));

    const wordCounts: Record<string, number> = {};
    words.forEach((word: string) => {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    });

    const sortedWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .map((entry) => entry[0]);

    return [...new Set(sortedWords)].slice(0, 10);
  }

  private _getDocumentTypeLabel(type: string): string {
    const typeMap: Record<string, string> = {
      pdf: "Documento PDF",
      text: "Documento de texto",
      image: "Imagen",
      document: "Documento",
      other: "Otro tipo de archivo",
    };
    return typeMap[type] || "Documento";
  }
}
