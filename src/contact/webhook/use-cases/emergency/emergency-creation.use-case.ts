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
import { AiService } from "../../services/ai.service";
import { DataExtractorService } from "@contact/webhook/services/data-extractor.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import {
  _extractLocationData,
  _extractMessageText,
  _extractUserData,
  _hasValidLocation,
} from "@shared/utils/extractor-message";

@Injectable()
export class EmergencyCreationUseCase {
  private readonly logger = new Logger(EmergencyCreationUseCase.name);
  private adminPhoneNumbers: string[];
  private categoryMap: Record<string, string>;
  private intentTypeMap: Record<string, string>;
  private emojiMap: Record<string, string>;

  constructor(
    @InjectModel(CONVERSATION_MODEL)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly conversationService: ConversationService,
    private readonly incidentService: IncidentService,
    private readonly userService: UserService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
    private readonly dataExtractorService: DataExtractorService,
  ) {
    this.adminPhoneNumbers = [
      process.env.ADMIN_PHONE_1 || "593980196858",
      process.env.ADMIN_PHONE_2 || "593995767887",
    ];

    this.categoryMap = {
      médica: "Emergencia Médica",
      medica: "Emergencia Médica",
      salud: "Emergencia Médica",
      seguridad: "Seguridad Ciudadana",
      robo: "Seguridad Ciudadana",
      asalto: "Seguridad Ciudadana",
      violencia: "Seguridad Ciudadana",
      incendio: "Incendio",
      fuego: "Incendio",
      inundación: "Desastre Natural",
      inundacion: "Desastre Natural",
      derrumbe: "Desastre Natural",
      "desastre natural": "Desastre Natural",
      general: "Emergencia General",
    };

    this.intentTypeMap = {
      incendio: "incendio",
      fuego: "incendio",
      "accidente de tránsito": "médica",
      "accidente de transito": "médica",
      accidente: "médica",
      herido: "médica",
      herida: "médica",
      ataque: "médica",
      robo: "seguridad",
      asalto: "seguridad",
      violencia: "seguridad",
      inundación: "inundación",
      inundacion: "inundación",
      derrumbe: "derrumbe",
    };

    this.emojiMap = {
      incendio: "🔥",
      médica: "🚑",
      medica: "🚑",
      seguridad: "🚨",
      inundación: "🌊",
      inundacion: "🌊",
      derrumbe: "🏚️",
      general: "🚨",
    };
  }

  async execute(conversation: any, message: any): Promise<any> {
    this.logger.log("🚨 Procesando mensaje de emergencia", conversation._id);
    const conversationId = conversation._id;
    const intent = conversation.context?.intent || null;

    try {
      if (message.type === "location") {
        return await this._handleLocationForEmergency(message, conversation);
      }

      const messageText = _extractMessageText(message);
      if (!messageText) {
        throw new Error("No se pudo extraer texto del mensaje");
      }

      let analysis = await this._getEmergencyAnalysis(messageText, intent);
      await this.conversationService.saveEmergencyAnalysisToConversation(
        conversation._id,
        analysis,
      );
      this.logger.log(`📊 Análisis de emergencia: ${JSON.stringify(analysis)}`);

      if (!_hasValidLocation(conversation)) {
        return await this._requestLocationFromUser(conversation, analysis.type);
      }

      try {
        const emergencyCategory =
          await this.incidentService.getCategoryName("EMERGENCIAS");
        if (emergencyCategory) {
          await this.conversationService.updateTempIncidentData(
            conversationId,
            {
              category_id: emergencyCategory._id,
              category: emergencyCategory.nombre,
              priority: "high",
            },
          );
        }
      } catch (error) {
        this.logger.error("Error obteniendo categoría de emergencia:", error);
      }

      return await this._processCompleteEmergency(
        message,
        conversation,
        analysis,
      );
    } catch (error: any) {
      this.logger.error(`❌ Error procesando emergencia: ${error}`);
      return await this._handleEmergencyError(error, conversation);
    }
  }

  private async _getEmergencyAnalysis(
    messageText: string,
    intent: any,
  ): Promise<any> {
    if (intent && intent.entities && intent.entities.incidente) {
      const incidentType =
        this.intentTypeMap[intent.entities.incidente.toLowerCase()] ||
        "general";
      const location = intent.entities.ubicacion || "No especificada";
      this.logger.log(
        `🧠 Usando entidad detectada para emergencia: ${incidentType}`,
      );
      return {
        type: incidentType,
        risk: "alto",
        peopleAffected: "No especificado",
        resourcesNeeded: [],
        recommendedActions: [],
        details: messageText,
        location: location,
      };
    }
    return await this.analyzeEmergency(messageText);
  }

  async analyzeEmergency(message: string): Promise<any> {
    if (!this.aiService) {
      return {
        type: "general",
        risk: "alto",
        peopleAffected: "No especificado",
        resourcesNeeded: [],
        recommendedActions: [],
        details: message,
        location: "No especificada",
      };
    }

    const messages = [
      {
        role: "system",
        content: `Analiza la siguiente situación de emergencia y completa exactamente esta estructura JSON:
      {
        "type": "médica|seguridad|incendio|inundación|derrumbe|general",
        "risk": "alto|medio|bajo",
        "peopleAffected": "número o descripción",
        "resourcesNeeded": ["recurso1", "recurso2"],
        "recommendedActions": ["acción1", "acción2"],
        "details": "breve descripción",
        "location": "ubicación si se menciona"
      }
      
      Usa solamente valores estandarizados para 'type' y 'risk'.`,
      },
      {
        role: "user",
        content: message,
      },
    ];

    const response = await this.aiService.query(messages);
    const parsedResponse = (this.aiService as any)._extractJSON(
      response.content,
    );

    return {
      type: parsedResponse.type || "general",
      risk: ["alto", "medio", "bajo"].includes(
        parsedResponse.risk?.toLowerCase(),
      )
        ? parsedResponse.risk.toLowerCase()
        : "alto",
      peopleAffected: parsedResponse.peopleAffected || "No especificado",
      resourcesNeeded: Array.isArray(parsedResponse.resourcesNeeded)
        ? parsedResponse.resourcesNeeded
        : [],
      recommendedActions: Array.isArray(parsedResponse.recommendedActions)
        ? parsedResponse.recommendedActions
        : [],
      details: parsedResponse.details || message,
      location: parsedResponse.location || "No especificada",
    };
  }

  private async _requestLocationFromUser(
    conversation: any,
    emergencyType = "general",
  ): Promise<any> {
    await this.whatsAppService.sendLocationButton(conversation.senderId);
    await this.conversationService.update(conversation._id, {
      "context.pendingEmergency": true,
    });
    await this.conversationService.updateState(
      conversation._id,
      "waiting_emergency_location",
    );
    return { status: "location_requested", pendingLocation: true };
  }

  private async _handleLocationForEmergency(
    message: any,
    conversation: any,
  ): Promise<any> {
    try {
      this.logger.log("🚨 Procesando ubicación para emergencia pendiente");
      const savedAnalysis = conversation.context?.emergencyAnalysis;
      if (!savedAnalysis) {
        throw new Error("No se encontró análisis de emergencia guardado");
      }

      const location = this._extractLocationFromMessage(message);
      await this._updateConversationWithLocation(
        conversation,
        location,
        savedAnalysis,
      );
      await this._notifyAdministrators(
        message,
        conversation,
        null,
        savedAnalysis,
      );

      // Determinar servicios requeridos (no usado pero mantenido)
      // const requiredServices = this.determineRequiredServices(savedAnalysis.type || 'general', savedAnalysis.risk || 'alto');

      const confirmMessage = this._getConfirmationMessageByType(
        savedAnalysis.type,
      );
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        confirmMessage,
      );

      return await this._processCompleteEmergency(
        message,
        conversation,
        savedAnalysis,
      );
    } catch (error) {
      return this._handleEmergencyError(error as Error, conversation);
    }
  }

  private _extractLocationFromMessage(message: any): any {
    return {
      latitude: message.location?.latitude,
      longitude: message.location?.longitude,
      address: message.location?.address || "Dirección no disponible",
    };
  }

  private async _updateConversationWithLocation(
    conversation: any,
    location: any,
    savedAnalysis: any,
  ): Promise<void> {
    this.logger.log(
      `📍 Ubicación recibida: ${location.latitude}, ${location.longitude}`,
    );
    if (!conversation.tempIncidentData) conversation.tempIncidentData = {};
    if (!conversation.tempIncidentData.location)
      conversation.tempIncidentData.location = {};

    conversation.tempIncidentData.location.latitude = location.latitude;
    conversation.tempIncidentData.location.longitude = location.longitude;
    conversation.tempIncidentData.location.address = location.address;
    savedAnalysis.location = `${location.address} (${location.latitude}, ${location.longitude})`;

    await this.conversationService.addMessageToHistory(
      conversation._id,
      `Ubicación recibida: ${location.address} (${location.latitude}, ${location.longitude})`,
      true,
      { type: "location_message" },
    );

    await this.conversationService.updateState(
      conversation._id,
      "emergency_processing",
    );
    conversation.context.pendingEmergency = false;
    await this.conversationService.update(conversation._id, {
      "context.pendingEmergency": false,
    });
    conversation.tempIncidentData.priority = "high";

    if (!conversation.tempIncidentData.category) {
      conversation.tempIncidentData.category =
        this.categoryMap[savedAnalysis.type?.toLowerCase()] ||
        "Emergencia General";
    }

    if (savedAnalysis.details) {
      const currentDesc = conversation.tempIncidentData.description || "";
      conversation.tempIncidentData.description = currentDesc
        ? `${currentDesc}\n\nDETALLES DE EMERGENCIA: ${savedAnalysis.details}`
        : `DETALLES DE EMERGENCIA: ${savedAnalysis.details}`;
    }

    await conversation.save();
  }

  private async _processCompleteEmergency(
    message: any,
    conversation: any,
    analysis: any,
  ): Promise<any> {
    try {
      this.logger.log("🚨 Procesando emergencia completa con ubicación");
      const instructions = await this.getEmergencyInstructions(analysis);
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        instructions.content,
      );

      const incidentData = await this._prepareIncidentData(
        conversation,
        analysis,
      );
      this.logger.log(`🚨 Datos de incidente: ${JSON.stringify(incidentData)}`);
      const reportResult = await this.incidentService.create(incidentData);
      await this.conversationService.clearTempIncidentData(conversation._id);

      if (reportResult && reportResult._id) {
        await this.conversationService.update(conversation._id, {
          "tempIncidentData.incidentIds": [
            ...(conversation.tempIncidentData?.incidentIds || []),
            reportResult._id,
          ],
        });
      }

      return {
        success: true,
        nextState: "main_menu",
        response: instructions.content,
        emergencyHandled: true,
        incidentId: reportResult?._id,
      };
    } catch (error) {
      this.logger.error("Error procesando emergencia completa:", error);
      return this._handleEmergencyError(error as Error, conversation);
    }
  }

  private async _prepareIncidentData(
    conversation: any,
    analysis: any,
  ): Promise<any> {
    this.logger.log(`Conversación ID: ${conversation._id}`);
    this.logger.log(`Analysis: ${JSON.stringify(analysis)}`);

    conversation = await this.conversationService.getByIdPopulated(
      conversation._id,
    );
    this.logger.log(`Conversación populada: ${!!conversation}`);
    this.logger.log(`Tiene userId: ${!!conversation.userId}`);
    this.logger.log(
      `Temp data: ${JSON.stringify(conversation.tempIncidentData)}`,
    );

    const messageText = conversation.tempIncidentData?.description || "";
    this.logger.log(`Mensaje texto: ${messageText}`);

    let subcategoria: any;
    try {
      const categoryName =
        this.categoryMap[analysis.type?.toLowerCase()] || "Emergencia General";
      this.logger.log(`Buscando categoría: ${categoryName}`);
      subcategoria =
        await this.incidentService.getSubcategoryName(categoryName);
      this.logger.log(
        `Subcategoría encontrada: ${JSON.stringify(subcategoria)}`,
      );
    } catch (error) {
      this.logger.error(
        `Error específico obteniendo subcategoría: ${(error as Error).message}`,
      );
      try {
        this.logger.log("Intentando con categoría genérica");
        subcategoria =
          await this.incidentService.getSubcategoryName("Emergencia General");
        this.logger.log(
          `Subcategoría genérica encontrada: ${JSON.stringify(subcategoria)}`,
        );
      } catch (fallbackError) {
        this.logger.error(
          `Error en fallback: ${(fallbackError as Error).message}`,
        );
        subcategoria = { _id: null, categoria: { _id: null } };
      }
    }

    const estado = await this.incidentService.getEstadoByName("Pendiente");

    const result = {
      ciudadano: conversation.userId || null,
      senderId: conversation.senderId,
      categoria: subcategoria?.categoria?._id || null,
      subcategoria: subcategoria?._id || null,
      descripcion: messageText || analysis?.details || "Sin descripción",
      priority: "high",
      estado: estado?._id,
      direccion_geo: {
        nombre:
          conversation.tempIncidentData?.location?.address || "No especificada",
        latitud: conversation.tempIncidentData?.location?.latitude || 0,
        longitud: conversation.tempIncidentData?.location?.longitude || 0,
      },
      urgencia: true,
    };

    this.logger.log(`Resultado preparado: ${JSON.stringify(result)}`);
    return result;
  }

  determineRequiredServices(
    emergencyType: string,
    riskLevel: string,
  ): string[] {
    const services: string[] = [];
    const type = emergencyType.toLowerCase();

    if (["médica", "medica", "salud"].includes(type)) {
      services.push("ambulance");
    } else if (["incendio", "fuego"].includes(type)) {
      services.push("firefighters");
    } else if (["seguridad", "robo", "asalto", "violencia"].includes(type)) {
      services.push("police");
    } else if (
      ["inundación", "inundacion", "derrumbe", "desastre natural"].includes(
        type,
      )
    ) {
      services.push("civilDefense");
    } else {
      services.push("police");
    }

    if (riskLevel.toLowerCase() === "alto") {
      if (!services.includes("police")) services.push("police");
      services.push("municipalityControl");
    }

    return services;
  }

  async getEmergencyInstructions(analysis: any): Promise<any> {
    if (!this.aiService) {
      return {
        content:
          "Hemos recibido tu emergencia. Los servicios de emergencia han sido notificados y están en camino. Mantente en un lugar seguro y sigue las instrucciones de las autoridades.",
      };
    }

    let additionalContent = "";

    switch (analysis.type.toLowerCase()) {
      case "incendio":
        additionalContent =
          "Si es seguro, utiliza extintores para fuegos pequeños. Mantente agachado para evitar el humo. No uses ascensores.";
        break;
      case "médica":
      case "medica":
        additionalContent =
          "Si hay heridos, mantén la calma y no los muevas a menos que estén en peligro inmediato. Aplica primeros auxilios solo si estás capacitado.";
        break;
      case "seguridad":
        additionalContent =
          "Busca refugio seguro, no expongas tu ubicación en redes sociales. Colabora con las autoridades cuando lleguen.";
        break;
      case "inundación":
      case "inundacion":
        additionalContent =
          "Muévete a un terreno elevado. No camines por aguas en movimiento. Evita el contacto con cables eléctricos caídos.";
        break;
      default:
        additionalContent =
          "Mantente a salvo y sigue las instrucciones de las autoridades.";
    }

    const prompt = {
      role: "system",
      content: `
      El usuario ha reportado una emergencia de tipo "${analysis.type}" con nivel de riesgo "${analysis.risk}".
      
      Genera un mensaje BREVE con instrucciones claras y útiles que:
      
      1. Reconozca la gravedad de la situación
      2. Informe que se ha notificado a los servicios de emergencia
      3. Proporcione instrucciones específicas adaptadas a esta emergencia
      4. Use un tono tranquilizador pero serio
      
      Considera esta información adicional para tu respuesta: ${additionalContent}
      
      Limita tu respuesta a un máximo de 250 caracteres.
      `,
    };

    return this.aiService.query([prompt]);
  }

  private _getConfirmationMessageByType(emergencyType: string): string {
    const type = emergencyType?.toLowerCase() || "general";

    switch (type) {
      case "incendio":
        return "✅ Hemos recibido tu ubicación. Los bomberos han sido notificados y están en camino. Mantente en un lugar seguro.";
      case "médica":
      case "medica":
        return "✅ Hemos recibido tu ubicación. La ambulancia ha sido notificada y está en camino. Permanece tranquilo.";
      case "seguridad":
        return "✅ Hemos recibido tu ubicación. Las fuerzas de seguridad han sido notificadas y están en camino. Busca un lugar seguro.";
      case "inundación":
      case "inundacion":
        return "✅ Hemos recibido tu ubicación. Los servicios de emergencia han sido notificados y están en camino. Busca un lugar elevado.";
      default:
        return "✅ Hemos recibido tu ubicación. Los servicios de emergencia han sido notificados y están en camino.";
    }
  }

  private async _notifyAdministrators(
    message: any,
    conversation: any,
    intent: any,
    analysis: any = null,
  ): Promise<void> {
    try {
      conversation = await this.conversationService.getByIdPopulated(
        conversation._id,
      );
      if (!_hasValidLocation(conversation)) {
        this.logger.log(
          "⚠️ No hay datos de ubicación para notificar a administradores",
        );
        return;
      }

      const userData = await _extractUserData(conversation);
      const locationData = await _extractLocationData(conversation);
      const emergencyType = analysis ? analysis.type : "No especificado";
      const currentTime = new Date().toLocaleString();
      const mapLink = locationData.mapLink || "#";

      const templateComponents = [
        userData.name || "Usuario no identificado",
        userData.phone,
        emergencyType,
        locationData.address || "No especificada",
        locationData.coordinates || "Coordenadas no disponibles",
        currentTime,
        mapLink,
        conversation.tempIncidentData?.description || "No especificada",
      ];

      if (!this.adminPhoneNumbers.length) {
        this.logger.warn(
          "⚠️ No hay números de administradores configurados para notificar",
        );
        return;
      }

      const notificationPromises = this.adminPhoneNumbers.map((adminPhone) =>
        this.whatsAppService.sendTemplateMessage(
          adminPhone,
          "emergency_notification_staff",
          templateComponents,
        ),
      );

      await Promise.all(notificationPromises);
      this.logger.log(
        `🚨 Administradores notificados de emergencia - ${this.adminPhoneNumbers.length} notificaciones enviadas`,
      );
    } catch (error) {
      this.logger.error(
        `Error notificando administradores: ${(error as Error).message}`,
      );
    }
  }

  private async _handleEmergencyError(
    error: Error,
    conversation: any,
  ): Promise<any> {
    this.logger.error(`❌ Error procesando emergencia: ${error}`);
    try {
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Hemos registrado tu emergencia. Un operador se pondrá en contacto contigo a la brevedad posible.",
      );
    } catch (sendError) {
      this.logger.error(
        `Error enviando mensaje de error: ${(sendError as Error).message}`,
      );
    }

    return {
      success: false,
      nextState: "main_menu",
      response: "Error procesando emergencia",
      error: error.message,
    };
  }

  async processLocation(
    conversationId: string,
    locationData: any,
  ): Promise<any> {
    try {
      this.logger.log("🚨 Procesando ubicación para emergencia", {
        conversationId,
        locationData,
      });

      const conversation =
        await this.conversationService.getById(conversationId);

      if (!conversation) {
        throw new Error("Conversación no encontrada");
      }

      const savedAnalysis = conversation.context?.emergencyAnalysis;

      if (!savedAnalysis) {
        // Si no hay análisis guardado, crear uno básico
        return await this._createEmergencyFromLocation(
          conversationId,
          locationData,
          conversation,
        );
      }

      // Actualizar conversación con la ubicación
      await this._updateConversationWithLocation(
        conversation,
        locationData,
        savedAnalysis,
      );

      // Notificar a administradores
      await this._notifyAdministrators(null, conversation, null, savedAnalysis);

      const confirmMessage = this._getConfirmationMessageByType(
        savedAnalysis.type,
      );
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        confirmMessage,
      );

      return await this._processCompleteEmergency(
        null,
        conversation,
        savedAnalysis,
      );
    } catch (error) {
      this.logger.error("Error en processLocation:", error);
      return this._handleEmergencyError(
        error as Error,
        { _id: conversationId } as any,
      );
    }
  }

  private async _createEmergencyFromLocation(
    conversationId: string,
    locationData: any,
    conversation: any,
  ): Promise<any> {
    this.logger.log("Creando emergencia solo con ubicación");

    const defaultAnalysis = {
      type: "general",
      risk: "alto",
      peopleAffected: "No especificado",
      resourcesNeeded: [],
      recommendedActions: [],
      details: "Emergencia reportada sin descripción adicional",
      location: `${locationData.address || ""} (${locationData.latitude}, ${locationData.longitude})`,
    };

    await this.conversationService.saveEmergencyAnalysisToConversation(
      conversation._id,
      defaultAnalysis,
    );

    await this._updateConversationWithLocation(
      conversation,
      locationData,
      defaultAnalysis,
    );
    await this._notifyAdministrators(null, conversation, null, defaultAnalysis);

    const confirmMessage = this._getConfirmationMessageByType("general");
    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      confirmMessage,
    );

    return await this._processCompleteEmergency(
      null,
      conversation,
      defaultAnalysis,
    );
  }
}
