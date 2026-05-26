import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  CONVERSATION_MODEL,
  ConversationDocument,
} from "@shared/schemas/conversation.schema";
import { ConversationService } from "../../../conversation.service";
import { IncidentService } from "@shared/modules/incident/incident.service";
import { UserService } from "@shared/modules/user/user.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { AiService } from "../../services/ai.service";
import { MediaProcessorService } from "../../services/media-processor.service";
import { DataExtractorService } from "../../services/data-extractor.service";
import {
  _extractLocationFromMessage,
  _extractMessageText,
} from "@shared/utils/extractor-message";

@Injectable()
export class IncidentCreationUseCase {
  private readonly logger = new Logger(IncidentCreationUseCase.name);

  constructor(
    @InjectModel(CONVERSATION_MODEL)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly conversationService: ConversationService,
    private readonly incidentService: IncidentService,
    private readonly userService: UserService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
    private readonly mediaProcessor: MediaProcessorService,
    private readonly dataExtractorService: DataExtractorService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      conversation =
        await this.conversationService.getByIdPopulated(conversationId);

      if (!conversation) {
        throw new Error("Conversación no encontrada");
      }

      const senderId = conversation.senderId;

      if (!conversation.userId) {
        await this.conversationService.updateState(
          conversationId,
          "user_registration",
          conversation.state,
        );

        await this.whatsAppService.sendTextMessage(
          senderId,
          "Para reportar un incidente, primero necesitamos registrarte como ciudadano. Puedes hacerlo en la página oficial de Esmeraldas La Bella.",
        );

        const userRegistrationUseCase = {} as any;
        return await userRegistrationUseCase.execute(conversationId);
      }

      if (message.type === "interactive") {
        return await this._handleInteractiveMessage(conversationId, message);
      }

      const messageText = _extractMessageText(message);

      if (message.type === "location") {
        const locationData = _extractLocationFromMessage(message);
        await this.conversationService.updateTempIncidentData(conversationId, {
          location: locationData,
        });
      }

      const currentState = this._determineCurrentState(conversation, message);

      switch (currentState) {
        case "initial":
          if (
            message.type === "text" &&
            messageText &&
            messageText.length > 10
          ) {
            return await this._tryExtractIncidentDataWithAI(
              conversationId,
              message,
              conversation,
            );
          } else {
            return await this._startIncidentCreation(
              conversationId,
              conversation,
            );
          }

        case "incident_category_selection":
          return await this._handleCategorySelection(conversationId, message);
        case "incident_subcategory_selection":
          return await this._handleSubcategorySelection(
            conversationId,
            message,
          );
        case "incident_description":
          return await this._handleDescriptionInput(conversationId, message);
        case "incident_location":
          return await this._handleLocationInput(conversationId, message);
        case "incident_photo_request":
          return await this._handlePhotoRequest(conversationId, message);
        case "incident_waiting_photo":
          return await this._handlePhotoSubmission(conversationId, message);
        case "incident_confirmation":
          return await this._handleConfirmation(conversationId, message);
        case "confirming_ai_extract":
          return await this._handleAIExtractConfirmation(
            conversationId,
            message,
          );
        default:
          if (
            message.type === "text" &&
            messageText &&
            messageText.length > 10
          ) {
            return await this._tryExtractIncidentDataWithAI(
              conversationId,
              message,
              conversation,
            );
          } else {
            return await this._startIncidentCreation(
              conversationId,
              conversation,
            );
          }
      }
    } catch (error) {
      this.logger.error("Error iniciando creación de incidente:", error);
      try {
        const senderId = (
          await this.conversationService.getById(conversation._id)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al iniciar el reporte. Por favor, intenta nuevamente.",
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

  async startIncidentCreation(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.updateState(
        conversationId,
        "incident_category_selection",
        conversation.state,
      );

      await this.conversationService.clearTempIncidentData(conversationId);

      return await this.sendCategoriesWithPagination(
        senderId,
        1,
        conversationId,
      );
    } catch (error) {
      this.logger.error("Error en startIncidentCreation:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _handleInteractiveMessage(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const currentState = conversation.state;

      let interactionType: string | null = null;
      let interactionId: string | null = null;

      if (message.interactive?.button_reply) {
        interactionType = "button";
        interactionId = message.interactive.button_reply.id;
      } else if (message.interactive?.list_reply) {
        interactionType = "list";
        interactionId = message.interactive.list_reply.id;
      } else {
        return null;
      }

      this.logger.log(
        `Interacción ${interactionType}: ${interactionId} en estado ${currentState}`,
      );

      if (interactionId && interactionId.startsWith("icuc_cat_")) {
        const categoryId = interactionId.replace("icuc_cat_", "");
        return await this.processCategorySelection(conversationId, categoryId);
      } else if (
        interactionId &&
        (interactionId.startsWith("icuc_more_cat_") ||
          interactionId.startsWith("icuc_prev_cat_"))
      ) {
        const page = parseInt(interactionId?.split("_").pop() ?? "", 10);
        return await this.sendCategoriesWithPagination(
          conversation.senderId,
          page,
          conversationId,
        );
      } else if (interactionId && interactionId.startsWith("icuc_subcat_")) {
        const subcategoryId = interactionId.replace("icuc_subcat_", "");
        return await this.processSubcategorySelection(
          conversationId,
          subcategoryId,
        );
      } else if (
        interactionId === "icuc_photo_yes" ||
        interactionId === "icuc_photo_no"
      ) {
        const response = interactionId === "icuc_photo_yes" ? "yes" : "no";
        return await this.processPhotoResponse(conversationId, response);
      } else if (interactionId === "icuc_continue_report") {
        return await this.showIncidentSummary(conversationId);
      } else if (interactionId === "icuc_send_more_photos") {
        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          "Por favor, envía otra foto del incidente:",
        );
        return {
          success: true,
          message: "Esperando otra foto",
          nextState: "incident_waiting_photo",
        };
      } else if (
        interactionId === "icuc_confirm_yes" ||
        interactionId === "icuc_confirm_no"
      ) {
        const confirmation =
          interactionId === "icuc_confirm_yes" ? "yes" : "no";
        return await this.processConfirmation(conversationId, confirmation);
      } else if (
        interactionId === "icuc_ai_confirm_yes" ||
        interactionId === "icuc_ai_confirm_no"
      ) {
        const confirmation =
          interactionId === "icuc_ai_confirm_yes" ? "yes" : "no";
        return await this._handleAIExtractConfirmation(conversationId, {
          type: "interactive",
          interactive: { button_reply: { id: interactionId } },
        });
      } else {
        this.logger.log(`Interacción no identificada: ${interactionId}`);
        return null;
      }
    } catch (error) {
      this.logger.error("Error procesando mensaje interactivo:", error);
      return null;
    }
  }

  private _determineCurrentState(conversation: any, message: any): string {
    if (conversation.state) {
      return conversation.state;
    }

    if (message.type === "location") {
      return "incident_location";
    }

    if (message.type === "image") {
      return "incident_waiting_photo";
    }

    const tempData = conversation.tempIncidentData || {};

    if (
      tempData.category_id &&
      tempData.subcategory_id &&
      tempData.description &&
      tempData.location?.latitude
    ) {
      if (tempData.photos && tempData.photos.length > 0) {
        return "incident_confirmation";
      } else {
        return "incident_waiting_photo";
      }
    }

    if (
      tempData.category_id &&
      tempData.subcategory_id &&
      tempData.description
    ) {
      return "incident_location";
    }

    if (tempData.category_id && tempData.subcategory_id) {
      return "incident_description";
    }

    if (tempData.category_id) {
      return "incident_subcategory_selection";
    }

    return "initial";
  }

  private async _startIncidentCreation(
    conversationId: string,
    conversation: any,
  ): Promise<any> {
    const senderId = conversation.senderId;
    const currentState = conversation.state;

    await this.conversationService.updateState(
      conversationId,
      "incident_category_selection",
      currentState,
    );

    if (currentState !== "confirming_ai_extract") {
      await this.conversationService.clearTempIncidentData(conversationId);
    }

    return await this.sendCategoriesWithPagination(senderId, 1, conversationId);
  }

  async sendCategoriesWithPagination(
    senderId: string,
    page: number = 1,
    conversationId?: string,
  ): Promise<any> {
    try {
      const categories = await this.incidentService.getAllCategories();
      const itemsPerPage = 9;
      const totalPages = Math.ceil(categories.length / itemsPerPage);
      page = Math.max(1, Math.min(page, totalPages));

      const startIndex = (page - 1) * itemsPerPage;
      const endIndex = Math.min(startIndex + itemsPerPage, categories.length);
      const pageCategories = categories.slice(startIndex, endIndex);

      let options = pageCategories.map((cat: any) => ({
        id: `icuc_cat_${cat._id}`,
        title: this._truncateTitle(cat.nombre, 24),
        description: cat.descripcion
          ? this._truncateDescription(cat.descripcion, 72)
          : "Selecciona esta categoría",
      }));

      if (page < totalPages) {
        options.push({
          id: `icuc_more_cat_${page + 1}`,
          title: "Más categorías →",
          description: `Ver más (${page + 1}/${totalPages})`,
        });
      }

      if (page > 1) {
        options.unshift({
          id: `icuc_prev_cat_${page - 1}`,
          title: "← Anteriores",
          description: `Volver (${page - 1}/${totalPages})`,
        });
      }

      options = options.slice(0, 10);

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText: `Selecciona categoría (${page}/${totalPages}):`,
        headerText: "Categorías",
        buttonText: "Ver categorías",
        sections: [{ title: "Categorías", rows: options }],
      });

      if (conversationId) {
        await this.conversationService.update(conversationId, {
          "context.categoryPage": page,
        });
      }

      return {
        success: true,
        message: "Categorías enviadas",
        nextState: "incident_category_selection",
      };
    } catch (error) {
      this.logger.error("Error enviando categorías:", error);
      try {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no se pudieron enviar las categorías. Por favor, describe tu problema directamente.",
        );
        return {
          success: true,
          message: "Mensaje alternativo enviado",
          nextState: "incident_description",
        };
      } catch (secondError) {
        this.logger.error("Error enviando mensaje alternativo:", secondError);
        throw error;
      }
    }
  }

  private _truncateTitle(title: string, maxLength = 24): string {
    if (!title) return "Sin título";
    return title.length <= maxLength
      ? title
      : `${title.substring(0, maxLength - 3)}...`;
  }

  private _truncateDescription(description: string, maxLength = 72): string {
    if (!description) return "Selecciona esta categoría";
    return description.length <= maxLength
      ? description
      : `${description.substring(0, maxLength - 3)}...`;
  }

  async processCategorySelection(
    conversationId: string,
    categoryId: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      const category = await this.incidentService.getCategoryById(categoryId);

      await this.conversationService.updateTempIncidentData(conversationId, {
        category_id: categoryId,
        category: category.nombre,
      });

      await this.conversationService.updateState(
        conversationId,
        "incident_subcategory_selection",
        conversation.state,
      );

      const subcategories =
        await this.incidentService.getSubcategoriesByCategory(categoryId);

      if (!subcategories || subcategories.length === 0) {
        return this.requestIncidentDescription(conversationId);
      }

      const options = subcategories.map((subcat: any) => ({
        id: `icuc_subcat_${subcat._id}`,
        title: this._truncateTitle(subcat.nombre, 24),
        description: subcat.descripcion
          ? this._truncateDescription(subcat.descripcion, 72)
          : "Selecciona esta subcategoría",
      }));

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText: `Has seleccionado la categoría: ${this._truncateTitle(category.nombre, 50)}. Ahora, selecciona una subcategoría:`,
        headerText: "Subcategorías",
        buttonText: "Ver subcategorías",
        sections: [{ title: "Subcategorías", rows: options }],
      });

      return {
        success: true,
        message: "Selección de categoría procesada",
        nextState: "incident_subcategory_selection",
      };
    } catch (error) {
      this.logger.error("Error procesando selección de categoría:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processSubcategorySelection(
    conversationId: string,
    subcategoryId: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const subcategory =
        await this.incidentService.getSubCategoryById(subcategoryId);

      await this.conversationService.updateTempIncidentData(conversationId, {
        subcategory_id: subcategoryId,
        subcategory: subcategory.nombre,
      });

      return await this.requestIncidentDescription(conversationId);
    } catch (error) {
      this.logger.error("Error procesando selección de subcategoría:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async requestIncidentDescription(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.updateState(
        conversationId,
        "incident_description",
        conversation.state,
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Por favor, describe brevemente el incidente (qué ocurre, detalles importantes, etc.):",
      );

      return {
        success: true,
        message: "Solicitud de descripción enviada",
        nextState: "incident_description",
      };
    } catch (error) {
      this.logger.error("Error solicitando descripción:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processDescription(
    conversationId: string,
    description: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (this.aiService) {
        try {
          const analysisPrompt = [
            {
              role: "system",
              content: `Analiza la siguiente descripción de incidente para un sistema municipal.
              Verifica si contiene:
              1. Contenido inapropiado o lenguaje ofensivo
              2. Información personal sensible (números de tarjetas, contraseñas)
              3. Contenido que no parece ser un incidente real municipal (spam, bromas)
              
              Responde únicamente con un JSON:
              {
                "isAppropriate": boolean,
                "reason": "razón si no es apropiado"
              }`,
            },
            { role: "user", content: description },
          ];

          const analysisResponse = await this.aiService.query(analysisPrompt, {
            responseFormat: "json",
          });

          let analysis;
          try {
            analysis = JSON.parse(analysisResponse.content);
          } catch {
            analysis = { isAppropriate: true };
          }

          if (!analysis.isAppropriate) {
            const inappropriateMessage = `No podemos procesar esta descripción porque: ${analysis.reason}. Por favor, proporciona una descripción apropiada del incidente:`;
            await this.whatsAppService.sendTextMessage(
              senderId,
              inappropriateMessage,
            );
            return {
              success: false,
              message: "Descripción inapropiada",
              nextState: "incident_description",
            };
          }
        } catch (aiError) {
          this.logger.error("Error analizando descripción con IA:", aiError);
        }
      }

      await this.conversationService.updateTempIncidentData(conversationId, {
        description: description,
      });

      await this.conversationService.updateState(
        conversationId,
        "incident_location",
        conversation.state,
      );

      await this.whatsAppService.sendLocationButton(senderId);

      return {
        success: true,
        message: "Descripción procesada, solicitada ubicación",
        nextState: "incident_location",
      };
    } catch (error) {
      this.logger.error("Error procesando descripción:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processLocation(
    conversationId: string,
    locationData: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.updateTempIncidentData(conversationId, {
        location: {
          nombre: conversation.tempIncidentData?.location?.nombre || "",
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          address:
            locationData.address ||
            conversation.tempIncidentData?.location?.address ||
            conversation.tempIncidentData?.location?.nombre ||
            "",
        },
      });

      await this.conversationService.updateState(
        conversationId,
        "incident_photo_request",
        conversation.state,
      );

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Fotos del incidente",
        bodyText: "¿Deseas agregar una foto del incidente?",
        footerText: "Las fotos ayudan a evaluar mejor la situación",
        buttons: [
          { id: "icuc_photo_yes", text: "Sí, agregar foto" },
          { id: "icuc_photo_no", text: "No, continuar sin foto" },
        ],
      });

      return {
        success: true,
        message: "Ubicación procesada, consultando por fotos",
        nextState: "incident_photo_request",
      };
    } catch (error) {
      this.logger.error("Error procesando ubicación:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processPhotoResponse(
    conversationId: string,
    response: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      if (response === "yes") {
        await this.conversationService.updateState(
          conversationId,
          "incident_waiting_photo",
          conversation.state,
        );
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Por favor, envía una foto del incidente:",
        );
        return {
          success: true,
          message: "Esperando foto del incidente",
          nextState: "incident_waiting_photo",
        };
      } else {
        return await this.showIncidentSummary(conversationId);
      }
    } catch (error) {
      this.logger.error("Error procesando respuesta de foto:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processPhoto(conversationId: string, photoData: any): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const tempData = conversation.tempIncidentData || {};
      const currentPhotos = tempData.photos || [];

      if (currentPhotos.length >= 5) {
        const senderId = conversation.senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Has alcanzado el límite máximo de 5 fotos. Continuamos con tu reporte.",
        );
        return await this.showIncidentSummary(conversationId);
      }

      currentPhotos.push({
        fileName: photoData.fileName,
        fileType: photoData.fileType,
        timestamp: new Date(),
      });

      await this.conversationService.updateTempIncidentData(conversationId, {
        photos: currentPhotos,
      });

      const remainingPhotos = 5 - currentPhotos.length;
      const senderId = conversation.senderId;

      if (remainingPhotos > 0) {
        await this.whatsAppService.sendButtonMessage(senderId, {
          bodyText: `✅ Imagen recibida. Puedes enviar ${remainingPhotos} foto${remainingPhotos > 1 ? "s" : ""} más o continuar con el reporte.`,
          buttons: [{ id: "icuc_continue_report", text: "Continuar" }],
        });
        return {
          success: true,
          message: "Foto recibida, esperando decisión",
          nextState: "incident_waiting_photo",
        };
      } else {
        return await this.showIncidentSummary(conversationId);
      }
    } catch (error) {
      this.logger.error("Error procesando foto:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async showIncidentSummary(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getByIdPopulated(conversationId);
      const senderId = conversation.senderId;
      const tempData = conversation.tempIncidentData || {};

      await this.conversationService.updateState(
        conversationId,
        "incident_confirmation",
        conversation.state,
      );

      let summaryMessage = "*Resumen del incidente*\n\n";
      summaryMessage += `*Categoría:* ${tempData.category || "No especificada"}\n`;
      if (tempData.subcategory) {
        summaryMessage += `*Subcategoría:* ${tempData.subcategory}\n`;
      }
      summaryMessage += `*Descripción:* ${tempData.description || "No proporcionada"}\n`;
      summaryMessage += `*Ubicación:* ${
        tempData.location?.address ||
        (tempData.location?.latitude
          ? `Latitud ${tempData.location.latitude}, Longitud ${tempData.location.longitude}`
          : "No disponible")
      }\n`;
      summaryMessage += `*Fotos:* ${tempData.photos && tempData.photos.length > 0 ? "Sí" : "No"}\n\n`;
      summaryMessage += "¿Confirmas esta información para crear el reporte?";

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Confirmación de Reporte",
        bodyText: summaryMessage,
        footerText: "Gracias por contribuir a mejorar Esmeraldas",
        buttons: [
          { id: "icuc_confirm_yes", text: "Sí, crear reporte" },
          { id: "icuc_confirm_no", text: "No, cancelar" },
        ],
      });

      return {
        success: true,
        message: "Resumen mostrado, esperando confirmación",
        nextState: "incident_confirmation",
      };
    } catch (error) {
      this.logger.error("Error mostrando resumen:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
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
        await this.conversationService.clearTempIncidentData(conversationId);
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Has cancelado la creación del reporte. Si deseas iniciar nuevamente, solo indícalo.",
        );
        return {
          success: true,
          message: "Proceso cancelado por el usuario",
          nextState: "initial",
        };
      }

      const userId = conversation.userId?.toString();
      const tempData = conversation.tempIncidentData;

      const validation = this.incidentService.validateIncidentData(tempData);
      if (!validation.isValid) {
        const errorMsg = Object.values(validation.errors).join(". ");
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se pudo crear el reporte debido a datos incompletos: ${errorMsg}. Por favor, inicia nuevamente el proceso.`,
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          error: "Datos incompletos para crear incidente",
          validation: validation.errors,
        };
      }

      const preformattedData = await this._prepareIncidentData(conversation);
      const incident = await this.incidentService.createFromTempData(
        preformattedData,
        userId,
      );

      await this.conversationService.updateTempIncidentData(conversationId, {
        incidentIds: [incident._id],
      });

      const confirmationMessage =
        await this._generateConfirmationMessage(incident);
      await this.whatsAppService.sendTextMessage(senderId, confirmationMessage);

      await this.conversationService.clearTempIncidentData(conversationId);
      await this.conversationService.clearKnowledgeData(conversationId);
      await this.conversationService.clearTempUserData(conversationId);
      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      return {
        success: true,
        message: "Incidente creado correctamente",
        incidentId: incident._id,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando confirmación:", error);
      try {
        const senderId = (
          await this.conversationService.getById(conversationId)
        ).senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, hubo un error al crear el reporte. Por favor, intenta nuevamente más tarde.",
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

  private async _prepareIncidentData(
    conversation: any,
    analysis: any = null,
  ): Promise<any> {
    this.logger.log(`Conversación ID: ${conversation._id}`);
    conversation = await this.conversationService.getByIdPopulated(
      conversation._id,
    );
    const messageText = conversation.tempIncidentData?.description || "";
    const estado = await this.incidentService.getEstadoByName("Pendiente");

    const photoFiles: string[] = [];
    if (
      conversation.tempIncidentData?.photos &&
      conversation.tempIncidentData.photos.length > 0
    ) {
      conversation.tempIncidentData.photos.forEach((photo: any) => {
        let extension = ".jpg";
        if (photo.fileType) {
          const parts = photo.fileType.split("/");
          if (parts.length > 1) extension = "." + parts[1];
        }
        photoFiles.push(`${photo.fileName}`);
      });
    }

    const result = {
      ciudadano: conversation.userId || null,
      senderId: conversation.senderId,
      categoria: conversation.tempIncidentData?.category_id || null,
      subcategoria: conversation.tempIncidentData?.subcategory_id || null,
      descripcion: messageText || analysis?.details || "Sin descripción",
      priority: conversation.tempIncidentData?.priority || "low",
      estado: estado?._id,
      direccion_geo: {
        nombre:
          conversation.tempIncidentData?.location?.address || "No especificada",
        latitud: conversation.tempIncidentData?.location?.latitude || 0,
        longitud: conversation.tempIncidentData?.location?.longitude || 0,
      },
      urgencia: false,
      foto: photoFiles,
    };

    this.logger.log(`Resultado preparado: ${JSON.stringify(result)}`);
    return result;
  }

  private async _generateConfirmationMessage(incident: any): Promise<string> {
    const dataincident = await this.incidentService.getByIdAndPopulate(
      incident._id,
    );
    let message = "✅ *¡Reporte creado con éxito!*\n\n";
    message += `*N° de reporte:* ${dataincident._id}\n`;
    message += `*Categoría:* ${dataincident.categoria && typeof dataincident.categoria === "object" && "nombre" in dataincident.categoria ? dataincident.categoria.nombre : "No especificada"}\n`;
    if (dataincident.subcategoria) {
      message += `*Subcategoría:* ${dataincident.subcategoria && typeof dataincident.subcategoria === "object" && "nombre" in dataincident.subcategoria ? dataincident.subcategoria.nombre : "No especificada"}\n`;
    }
    message += `*Estado:* ${dataincident.estado && typeof dataincident.estado === "object" && "emoji" in dataincident.estado ? dataincident.estado.emoji : "⏳"} ${dataincident.estado && typeof dataincident.estado === "object" && "nombre" in dataincident.estado ? dataincident.estado.nombre : "Pendiente"}\n\n`;
    message +=
      "Tu reporte ha sido recibido y será atendido próximamente. Puedes consultar el estado de tus reportes en cualquier momento.\n\n";
    message += "¡Gracias por contribuir a mejorar Esmeraldas La Bella!";
    return message;
  }

  private async _handleCategorySelection(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      let categoryId: string | null = null;

      if (message.type === "interactive" && message.interactive?.list_reply) {
        categoryId = message.interactive.list_reply.id;
        if (
          categoryId?.startsWith("icuc_more_cat_") ||
          categoryId?.startsWith("icuc_prev_cat_")
        ) {
          const page = parseInt(categoryId?.split("_").pop() ?? "", 10);
          const conversation =
            await this.conversationService.getById(conversationId);
          return await this.sendCategoriesWithPagination(
            conversation.senderId,
            page,
            conversationId,
          );
        }
        if (categoryId?.startsWith("icuc_cat_")) {
          categoryId = categoryId?.replace("icuc_cat_", "");
        }
      } else if (message.type === "text") {
        const messageText = message.text.body;
        const categories = await this.incidentService.getAllCategories();
        const matchedCategory = categories.find(
          (c: any) =>
            c.nombre.toLowerCase() === messageText.toLowerCase() ||
            c.nombre.toLowerCase().includes(messageText.toLowerCase()),
        );
        if (matchedCategory) {
          categoryId = matchedCategory._id.toString();
        }
      }

      if (!categoryId) {
        const conversation =
          await this.conversationService.getById(conversationId);
        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          "No pude identificar la categoría seleccionada. Por favor, selecciona una de la lista:",
        );
        return await this.sendCategoriesWithPagination(
          conversation.senderId,
          1,
          conversationId,
        );
      }

      return await this.processCategorySelection(conversationId, categoryId);
    } catch (error) {
      this.logger.error("Error procesando selección de categoría:", error);
      throw error;
    }
  }

  private async _handleSubcategorySelection(
    conversationId: string,
    message: any,
  ): Promise<any> {
    try {
      let subcategoryId: string | null = null;

      if (message.type === "interactive" && message.interactive?.list_reply) {
        subcategoryId = message.interactive.list_reply.id;
        if (subcategoryId?.startsWith("icuc_subcat_")) {
          subcategoryId = subcategoryId?.replace("icuc_subcat_", "");
        }
      } else if (message.type === "text") {
        const messageText = message.text.body;
        const conversation =
          await this.conversationService.getById(conversationId);
        const tempData = conversation.tempIncidentData || {};

        if (tempData.category_id) {
          const subcategories =
            await this.incidentService.getSubcategoriesByCategory(
              tempData.category_id,
            );
          const matchedSubcategory = subcategories.find(
            (sc: any) =>
              sc.nombre.toLowerCase() === messageText.toLowerCase() ||
              sc.nombre.toLowerCase().includes(messageText.toLowerCase()),
          );
          if (matchedSubcategory) {
            subcategoryId = matchedSubcategory._id.toString();
          }
        }
      }

      if (!subcategoryId) {
        const conversation =
          await this.conversationService.getById(conversationId);
        const tempData = conversation.tempIncidentData || {};

        if (!tempData.category_id) {
          return await this._startIncidentCreation(
            conversationId,
            conversation,
          );
        }

        const subcategories =
          await this.incidentService.getSubcategoriesByCategory(
            tempData.category_id,
          );
        const category = await this.incidentService.getById(
          tempData.category_id,
        );

        const options = subcategories.map((subcat: any) => ({
          id: `icuc_subcat_${subcat._id}`,
          title: subcat.nombre,
          description: subcat.descripcion || "Selecciona esta subcategoría",
        }));

        await this.whatsAppService.sendListMessage(conversation.senderId, {
          bodyText: `No pude identificar la subcategoría. Para la categoría ${category.nombre}, por favor elige una subcategoría:`,
          headerText: "Subcategorías",
          buttonText: "Ver subcategorías",
          sections: [
            {
              title: "Subcategorías",
              rows: options,
            },
          ],
        });

        return {
          success: false,
          message: "Subcategoría no identificada",
          nextState: "incident_subcategory_selection",
        };
      }

      return await this.processSubcategorySelection(
        conversationId,
        subcategoryId,
      );
    } catch (error) {
      this.logger.error("Error procesando selección de subcategoría:", error);
      throw error;
    }
  }

  private async _handleDescriptionInput(
    conversationId: string,
    message: any,
  ): Promise<any> {
    if (message.type !== "text") {
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Por favor, proporciona una descripción textual del incidente:",
      );
      return {
        success: false,
        message: "Tipo de mensaje incorrecto para descripción",
        nextState: "incident_description",
      };
    }

    const description = message.text.body;

    if (!description || description.trim().length < 10) {
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Por favor, proporciona una descripción más detallada del incidente (mínimo 10 caracteres):",
      );
      return {
        success: false,
        message: "Descripción demasiado corta",
        nextState: "incident_description",
      };
    }

    return await this.processDescription(conversationId, description);
  }

  private async _handleLocationInput(
    conversationId: string,
    message: any,
  ): Promise<any> {
    if (message.type !== "location") {
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.whatsAppService.sendLocationButton(conversation.senderId);
      return {
        success: false,
        message: "Tipo de mensaje incorrecto para ubicación",
        nextState: "incident_location",
      };
    }

    const locationData = _extractLocationFromMessage(message);
    return await this.processLocation(conversationId, locationData);
  }

  private async _handlePhotoRequest(
    conversationId: string,
    message: any,
  ): Promise<any> {
    let response = "no";

    if (message.type === "interactive" && message.interactive?.button_reply) {
      const buttonId = message.interactive.button_reply.id;
      response = buttonId === "icuc_photo_yes" ? "yes" : "no";
    } else if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      if (text.includes("sí") || text.includes("si") || text.includes("yes")) {
        response = "yes";
      }
    }

    return await this.processPhotoResponse(conversationId, response);
  }

  private async _handlePhotoSubmission(
    conversationId: string,
    message: any,
  ): Promise<any> {
    if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      if (
        text.includes("continuar") ||
        text.includes("siguiente") ||
        text.includes("skip")
      ) {
        return await this.showIncidentSummary(conversationId);
      }
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Por favor, envía una foto del incidente o escribe 'continuar' para omitir este paso:",
      );
      return {
        success: false,
        message: "Tipo de mensaje incorrecto para foto",
        nextState: "incident_waiting_photo",
      };
    }

    if (message.type !== "image") {
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Por favor, envía una imagen del incidente o escribe 'continuar' para omitir este paso:",
      );
      return {
        success: false,
        message: "Tipo de mensaje incorrecto para foto",
        nextState: "incident_waiting_photo",
      };
    }

    try {
      const processedMedia = this.mediaProcessor
        ? await this.mediaProcessor.processMedia(message, {
            _id: conversationId,
          })
        : null;

      if (processedMedia && processedMedia.success) {
        const photoData = {
          fileName: processedMedia.fileName || message.image.id,
          fileType: processedMedia.fileType || message.image.mime_type,
          filePath: processedMedia.filePath || "",
        };
        return await this.processPhoto(conversationId, photoData);
      } else {
        const photoData = {
          fileName: message.image.id || "path_to_image",
          fileType: message.image.mime_type || "image/jpeg",
        };
        return await this.processPhoto(conversationId, photoData);
      }
    } catch (error) {
      this.logger.error("Error procesando imagen:", error);
      const photoData = {
        fileName: message.image.id || "path_to_image",
        fileType: message.image.mime_type || "image/jpeg",
      };
      return await this.processPhoto(conversationId, photoData);
    }
  }

  private async _handleConfirmation(
    conversationId: string,
    message: any,
  ): Promise<any> {
    let confirmation = "no";

    if (message.type === "interactive" && message.interactive?.button_reply) {
      const buttonId = message.interactive.button_reply.id;
      confirmation = buttonId === "icuc_confirm_yes" ? "yes" : "no";
    } else if (message.type === "text") {
      const text = message.text.body.toLowerCase();
      if (
        text.includes("sí") ||
        text.includes("si") ||
        text.includes("yes") ||
        text.includes("confirm") ||
        text === "1"
      ) {
        confirmation = "yes";
      }
    }

    return await this.processConfirmation(conversationId, confirmation);
  }

  private async _tryExtractIncidentDataWithAI(
    conversationId: string,
    message: any,
    conversation: any,
  ): Promise<any> {
    if (!this.aiService || !this.dataExtractorService) {
      return null;
    }

    try {
      const messageText = message.type === "text" ? message.text.body : null;
      if (!messageText) return null;

      const extractedData = await this.dataExtractorService.extractIncidentData(
        message,
        conversation,
        this.incidentService,
      );

      if (
        extractedData?.response?.insufficient_data === true &&
        extractedData.response?.message
      ) {
        const senderId = conversation.senderId;
        await this.whatsAppService.sendTextMessage(
          senderId,
          extractedData.response.message,
        );
        return { response: extractedData.response };
      }

      if (
        extractedData &&
        ((extractedData.category_id &&
          extractedData.category_id.trim() !== "") ||
          (extractedData.description &&
            extractedData.description.trim() !== "") ||
          (extractedData.location &&
            extractedData.location.nombre &&
            extractedData.location.nombre.trim() !== ""))
      ) {
        this.logger.log(
          "🔄 AIService: Extracted incident data:",
          JSON.stringify(extractedData),
        );
        await this.conversationService.updateTempIncidentData(
          conversationId,
          extractedData,
        );

        if (
          extractedData.category_id &&
          extractedData.category_id.trim() !== "" &&
          extractedData.description &&
          extractedData.description.trim() !== ""
        ) {
          return await this._showAIExtractedSummary(
            conversationId,
            extractedData,
          );
        }
        return extractedData;
      }
      return null;
    } catch (error) {
      this.logger.error("Error extracting data with AI:", error);
      return null;
    }
  }

  private async _showAIExtractedSummary(
    conversationId: string,
    extractedData: any,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      let categoryName = extractedData.category || "No identificada";
      let subcategoryName = extractedData.subcategory || "No identificada";

      if (extractedData.category_id) {
        const category = await this.incidentService.getCategoryById(
          extractedData.category_id,
        );
        if (category) categoryName = category.nombre;
      }

      if (extractedData.subcategory_id) {
        const subcategory = await this.incidentService.getSubCategoryById(
          extractedData.subcategory_id,
        );
        if (subcategory) subcategoryName = subcategory.nombre;
      }

      const summaryMessage = `He identificado la siguiente información de tu mensaje:
      
      *Categoría:* ${categoryName}
      *Subcategoría:* ${subcategoryName}
      *Descripción:* ${extractedData.description || "No proporcionada"}
      ${extractedData.location ? `*Ubicación:* ${extractedData.location.address || extractedData.location.nombre || "Coordenadas registradas"}` : ""}

      ¿Es correcta esta información? Puedes confirmar o corregir estos datos.`;

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Información detectada",
        bodyText: summaryMessage,
        footerText: "Selecciona una opción",
        buttons: [
          { id: "icuc_ai_confirm_yes", text: "Confirmar" },
          { id: "icuc_ai_confirm_no", text: "Corregir" },
        ],
      });

      await this.conversationService.updateState(
        conversationId,
        "confirming_ai_extract",
        conversation.state,
      );
    } catch (error) {
      this.logger.error("Error mostrando resumen de IA:", error);
    }
  }

  private async _handleAIExtractConfirmation(
    conversationId: string,
    message: any,
  ): Promise<any> {
    const conversation = await this.conversationService.getById(conversationId);
    const senderId = conversation.senderId;
    const messageText = _extractMessageText(message);
    const tempData = conversation.tempIncidentData || {};

    const isConfirmation =
      messageText?.toLowerCase()?.includes("sí") ||
      messageText?.toLowerCase()?.includes("si") ||
      messageText?.toLowerCase()?.includes("confirm") ||
      (message.type === "interactive" &&
        message.interactive?.button_reply?.id === "icuc_ai_confirm_yes");

    if (!isConfirmation) {
      await this.conversationService.clearTempIncidentData(conversationId);
      return await this._startIncidentCreation(conversationId, conversation);
    }

    await this.conversationService.updateTempIncidentData(
      conversationId,
      tempData,
    );

    if (!tempData.location || !tempData.location.latitude) {
      await this.conversationService.updateState(
        conversationId,
        "incident_location",
        conversation.state,
      );
      await this.whatsAppService.sendLocationButton(senderId);
      return {
        success: true,
        message: "Solicitud de ubicación enviada",
        nextState: "incident_location",
      };
    } else if (!tempData.photos || tempData.photos.length === 0) {
      await this.conversationService.updateState(
        conversationId,
        "incident_waiting_photo",
        conversation.state,
      );
      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Fotos del incidente",
        bodyText: "¿Deseas agregar una foto del incidente?",
        footerText: "Las fotos ayudan a evaluar mejor la situación",
        buttons: [
          { id: "icuc_photo_yes", text: "Sí, agregar foto" },
          { id: "icuc_photo_no", text: "No, continuar sin foto" },
        ],
      });
      return {
        success: true,
        message: "Solicitud de foto enviada",
        nextState: "incident_photo_request",
      };
    } else {
      return await this.showIncidentSummary(conversationId);
    }
  }
}
