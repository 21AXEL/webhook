/**
 * conversation.service.ts
 * Servicio de dominio para gestionar conversaciones de WhatsApp.
 * Migrado desde ConversationService.js — ServiceLocator reemplazado por DI de NestJS.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  CONVERSATION_MODEL,
  ConversationDocument,
} from "../shared/schemas/conversation.schema";
import { UserService } from "../shared/modules/user/user.service";

@Injectable()
export class ConversationService {
  constructor(
    @InjectModel(CONVERSATION_MODEL)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly userService: UserService,
  ) {}

  // ─── Consultas ──────────────────────────────────────────────────────────────

  /** Obtiene una conversación por su ID */
  async getById(id: string): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findById(id);
    if (!conversation)
      throw new NotFoundException("Conversación no encontrada");
    return conversation;
  }

  /** Obtiene una conversación por ID y puebla el usuario */
  async getByIdPopulated(id: string): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findById(id)
      .populate("userId");
    if (!conversation)
      throw new NotFoundException("Conversación no encontrada");
    return conversation;
  }

  /** Busca una conversación activa por senderId */
  async getBySenderId(senderId: string): Promise<ConversationDocument | null> {
    return this.conversationModel.findOne({ senderId, isActive: true });
  }

  /** Busca una conversación activa por senderId y puebla el usuario */
  async getBySenderIdPopulated(
    senderId: string,
  ): Promise<ConversationDocument | null> {
    return this.conversationModel
      .findOne({ senderId, isActive: true })
      .populate("userId");
  }

  // ─── Creación ───────────────────────────────────────────────────────────────

  /** Crea una nueva conversación para el senderId dado */
  async create(senderId: string): Promise<ConversationDocument> {
    // Buscar usuario registrado por número de teléfono
    const user = await this.userService
      .getByPhoneNumber(senderId)
      .catch(() => null);
    return this.conversationModel.create({
      senderId,
      userId: user?._id ?? null,
      state: "initial",
      history: [],
    });
  }

  // ─── Actualizaciones generales ──────────────────────────────────────────────

  /** Actualiza campos arbitrarios de una conversación */
  async update(
    id: string,
    updateData: Partial<ConversationDocument> | Record<string, any>,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findByIdAndUpdate(
      id,
      updateData,
      { new: true },
    );
    if (!conversation)
      throw new NotFoundException("Conversación no encontrada");
    return conversation;
  }

  /** Actualiza el estado de la máquina de estados */
  async updateState(
    id: string,
    state: string,
    lastState: string | null = null,
  ): Promise<ConversationDocument> {
    const result = await this.conversationModel.findByIdAndUpdate(
      id,
      { state, lastState },
      { new: true },
    );
    if (!result) throw new NotFoundException("Conversación no encontrada");
    return result;
  }

  /** Actualiza el historial de la conversación (método de conveniencia) */
  async updateConversationHistory(
    id: string,
    response: string,
    isUser: boolean = false,
  ): Promise<ConversationDocument> {
    return this.addMessageToHistory(id, response, isUser);
  }

  // ─── Historial ──────────────────────────────────────────────────────────────

  /** Añade un mensaje al historial de la conversación */
  async addMessageToHistory(
    conversationId: string,
    message: string = "",
    isUser: boolean,
    metadata: Record<string, any> = {},
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation)
      throw new NotFoundException(
        `Conversación ${conversationId} no encontrada`,
      );

    const historyEntry = {
      message,
      timestamp: new Date(),
      role: isUser ? "user" : "assistant",
      metadata,
    };

    conversation.history.push(historyEntry as any);
    conversation.lastInteraction = new Date();
    return conversation.save();
  }

  // ─── Desactivación y eliminación ───────────────────────────────────────────

  /** Marca una conversación como inactiva (soft delete) */
  async deactivate(id: string): Promise<ConversationDocument> {
    const result = await this.conversationModel.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true },
    );
    if (!result) throw new NotFoundException("Conversación no encontrada");
    return result;
  }

  /** Elimina una conversación permanentemente */
  async delete(id: string): Promise<{ success: boolean; message: string }> {
    const result = await this.conversationModel.findByIdAndDelete(id);
    if (!result) throw new NotFoundException("Conversación no encontrada");
    return { success: true, message: "Conversación eliminada" };
  }

  // ─── Datos temporales de incidente ─────────────────────────────────────────

  /** Actualiza parcialmente los datos temporales del incidente */
  async updateTempIncidentData(
    id: string,
    incidentData: Record<string, any>,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findById(id);
    if (!conversation)
      throw new NotFoundException(`Conversación no encontrada: ${id}`);

    if (!conversation.tempIncidentData)
      conversation.tempIncidentData = {} as any;

    for (const key of Object.keys(incidentData)) {
      (conversation.tempIncidentData as any)[key] = incidentData[key];
    }

    conversation.markModified("tempIncidentData");
    return conversation.save();
  }

  /** Limpia los datos temporales del incidente */
  async clearTempIncidentData(id: string): Promise<ConversationDocument> {
    const emptyIncidentData = {
      category_id: null,
      subcategory_id: null,
      category: "",
      subcategory: "",
      description: "",
      priority: "low",
      timestamp: new Date(),
      photos: [],
      incidentIds: [],
    };
    return this.update(id, { tempIncidentData: emptyIncidentData as any });
  }

  // ─── Datos temporales de usuario ────────────────────────────────────────────

  /** Actualiza parcialmente los datos temporales del usuario */
  async updateTempUserData(
    id: string,
    userData: Record<string, any>,
  ): Promise<ConversationDocument> {
    const conversation = await this.getById(id);
    const currentData = conversation.tempUserData ?? {};
    return this.update(id, {
      tempUserData: { ...currentData, ...userData } as any,
    });
  }

  /** Limpia los datos temporales del usuario */
  async clearTempUserData(id: string): Promise<ConversationDocument> {
    return this.update(id, { tempUserData: {} as any });
  }

  // ─── Datos de conocimiento ───────────────────────────────────────────────────

  /** Actualiza parcialmente los datos de conocimiento de la conversación */
  async updateKnowledgeData(
    conversationId: string,
    knowledgeData: Record<string, any>,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation)
      throw new NotFoundException(
        `Conversación no encontrada: ${conversationId}`,
      );

    for (const key of Object.keys(knowledgeData)) {
      (conversation.knowledgeData as any)[key] = knowledgeData[key];
    }

    conversation.markModified("knowledgeData");
    return conversation.save();
  }

  /** Limpia los datos de conocimiento */
  async clearKnowledgeData(id: string): Promise<ConversationDocument> {
    return this.update(id, { knowledgeData: {} as any });
  }

  // ─── Búsqueda y consultas avanzadas ─────────────────────────────────────────

  /** Busca conversaciones según criterios con paginación */
  async search(
    criteria: Record<string, any> = {},
    options: {
      page?: number;
      limit?: number;
      sort?: Record<string, 1 | -1>;
      startDate?: Date;
      endDate?: Date;
    } = {},
  ): Promise<{
    data: ConversationDocument[];
    pagination: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> {
    const {
      page = 1,
      limit = 10,
      sort = { lastInteraction: -1 },
      startDate,
      endDate,
    } = options;

    const skip = (page - 1) * limit;

    // Construir filtros
    const filter: Record<string, any> = { ...criteria };

    // Añadir filtro por fecha si existe
    if (startDate || endDate) {
      filter.lastInteraction = {};

      if (startDate) {
        filter.lastInteraction.$gte = startDate;
      }

      if (endDate) {
        filter.lastInteraction.$lte = endDate;
      }
    }

    const conversations = await this.conversationModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate("userId");

    const total = await this.conversationModel.countDocuments(filter);

    return {
      data: conversations,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── Construcción de historial para IA ───────────────────────────────────────

  /** Construye el historial de mensajes para un formato específico (para IA) */
  async buildMessageHistory(
    id: string,
    limit: number = 5,
  ): Promise<Array<{ role: string; content: string }>> {
    const conversation = await this.getByIdPopulated(id);
    const messages: Array<{ role: string; content: string }> = [];

    if (conversation.history && conversation.history.length > 0) {
      const formattedHistory = conversation.history
        .slice(-limit)
        .filter((item) => item.role && item.message)
        .map((item) => ({
          role: item.role,
          content: item.message,
        }));

      messages.push(...formattedHistory);
    }

    // Agregar datos temporales si existen (como contexto adicional)
    if (
      conversation.tempUserData &&
      Object.keys(conversation.tempUserData).length > 0
    ) {
      messages.push({
        role: "system",
        content: `Datos para la creación de un nuevo usuario: ${JSON.stringify(
          conversation.tempUserData,
        )}`,
      });
    }

    if (
      conversation.tempIncidentData &&
      Object.keys(conversation.tempIncidentData).length > 0
    ) {
      messages.push({
        role: "system",
        content: `Datos del incidente actuales: ${JSON.stringify(
          conversation.tempIncidentData,
        )}`,
      });
    }

    if (
      conversation.knowledgeData &&
      Object.keys(conversation.knowledgeData).length > 0
    ) {
      messages.push({
        role: "system",
        content: `Datos de conocimiento: ${JSON.stringify(
          conversation.knowledgeData,
        )}`,
      });
    }

    return messages;
  }

  // ─── Emergencias ─────────────────────────────────────────────────────────────

  /** Verifica si una conversación tiene una emergencia pendiente */
  async hasEmergencyPending(conversationId: string): Promise<boolean> {
    try {
      const conversation = await this.getById(conversationId);
      return !!(conversation.context && conversation.context.pendingEmergency);
    } catch (error) {
      console.error(
        `Error verificando emergencia pendiente: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Actualiza el estado de emergencia en la conversación */
  async updateEmergencyStatus(
    conversationId: string,
    hasPendingEmergency: boolean,
  ): Promise<ConversationDocument> {
    const conversation = await this.getById(conversationId);

    if (!conversation.context) {
      conversation.context = {};
    }

    conversation.context.pendingEmergency = hasPendingEmergency;
    conversation.markModified("context");

    await conversation.save();

    console.log(
      `Estado de emergencia ${hasPendingEmergency ? "activado" : "desactivado"} para conversación ${conversationId}`,
    );

    return conversation;
  }

  /** Guarda el análisis de emergencia en la conversación para recuperarlo después */
  async saveEmergencyAnalysisToConversation(
    conversationId: string,
    analysis: Record<string, any>,
  ): Promise<ConversationDocument> {
    const conversation = await this.getById(conversationId);

    if (!conversation.context) {
      conversation.context = {};
    }

    conversation.context.pendingEmergency = true;
    conversation.context.emergencyAnalysis = analysis;
    conversation.state = "waiting_emergency_location";
    (conversation as any).detectedIntent = "emergency";
    conversation.markModified("context");

    await conversation.save();

    console.log(
      `Análisis de emergencia guardado para conversación ${conversationId}`,
    );

    return conversation;
  }

  /** Verifica y procesa un mensaje de ubicación para una emergencia */
  async processEmergencyLocation(
    conversationId: string,
    locationData: Record<string, any>,
  ): Promise<{
    success: boolean;
    conversation?: ConversationDocument;
    emergencyAnalysis?: Record<string, any>;
    reason?: string;
  }> {
    const conversation = await this.getById(conversationId);

    if (!conversation.context?.pendingEmergency) {
      console.log(
        `No hay emergencia pendiente para conversación ${conversationId}`,
      );
      return { success: false, reason: "no_pending_emergency" };
    }

    // Actualizar ubicación en tempIncidentData
    if (!conversation.tempIncidentData) {
      conversation.tempIncidentData = {} as any;
    }

    if (!conversation.tempIncidentData.location) {
      conversation.tempIncidentData.location = {} as any;
    }

    conversation.tempIncidentData.location = {
      ...(conversation.tempIncidentData.location as any),
      ...locationData,
    };

    // Marcar emergencia como procesada
    conversation.context.pendingEmergency = false;
    conversation.markModified("context");
    conversation.markModified("tempIncidentData");

    // Actualizar estado
    conversation.state = "emergency_processing";

    await conversation.save();

    console.log(
      `Ubicación de emergencia procesada para conversación ${conversationId}`,
    );

    return {
      success: true,
      conversation,
      emergencyAnalysis: conversation.context.emergencyAnalysis as Record<
        string,
        any
      >,
    };
  }

  // ─── Expiración ─────────────────────────────────────────────────────────────

  /** Busca conversaciones expiradas (sin interacción en X horas) */
  async findExpired(hours = 24): Promise<ConversationDocument[]> {
    const expiration = new Date();
    expiration.setHours(expiration.getHours() - hours);
    return this.conversationModel.find({
      isActive: true,
      lastInteraction: { $lt: expiration },
    });
  }

  /** Alias para getExpiredConversations (consistencia con versión original) */
  async getExpiredConversations(): Promise<ConversationDocument[]> {
    return this.findExpired(24);
  }

  /**
   * Guarda datos temporales del flujo de tickets en conversation.context.ticketData.
   * Usa $set con merge para no pisar datos de otros flujos en context.
   * No requiere modificar el schema — context es Mixed.
   */
  async updateTempData(id: string, data: Record<string, any>): Promise<void> {
    // Merge con los datos existentes en context.ticketData
    const conversation = await this.conversationModel
      .findById(id)
      .select("context")
      .lean()
      .exec();

    const existing = (conversation?.context as any)?.ticketData ?? {};

    await this.conversationModel
      .updateOne(
        { _id: id },
        {
          $set: {
            "context.ticketData": { ...existing, ...data },
          },
        },
      )
      .exec();
  }

  // conversation.service.ts
  async clearTempData(id: string): Promise<void> {
    await this.conversationModel
      .updateOne({ _id: id }, { $unset: { "context.ticketData": "" } })
      .exec();
  }
}
