/**
 * conversation.schema.ts
 * Esquema de Mongoose para las conversaciones de WhatsApp.
 * RESTRICCIÓN: No modificar la estructura del documento — existen registros en producción.
 * Se registra con el mismo nombre de colección que el sistema original.
 */

import mongoose, { Document, Schema } from "mongoose";

// ─── Sub-esquema: datos temporales de usuario ─────────────────────────────────
const TempUserDataSchema = new Schema(
  {
    name: {
      value: { type: String, default: "" },
      isValid: { type: Boolean, default: false },
    },
    last_name: {
      value: { type: String, default: "" },
      isValid: { type: Boolean, default: false },
    },
    dni: {
      value: { type: String, default: "", trim: true },
      isValid: { type: Boolean, default: false },
    },
    email: {
      value: { type: String, default: "", trim: true },
      isValid: { type: Boolean, default: false },
    },
    telf: {
      value: { type: String, default: "", trim: true },
      isValid: { type: Boolean, default: false },
    },
    date_expedition: {
      value: { type: String, default: "", trim: true },
      isValid: { type: Boolean, default: false },
    },
  },
  { _id: false },
);

// ─── Sub-esquema: ubicación ────────────────────────────────────────────────────
const LocationSchema = new Schema(
  {
    nombre: { type: String, default: "" },
    longitude: { type: Number, default: 0 },
    latitude: { type: Number, default: 0 },
    address: { type: String, default: "" },
    coordinates: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], default: [0, 0] },
    },
  },
  { _id: false },
);

// ─── Sub-esquema: datos temporales de incidente ────────────────────────────────
const TempIncidentDataSchema = new Schema(
  {
    category_id: { type: Schema.Types.ObjectId, default: null },
    subcategory_id: { type: Schema.Types.ObjectId, default: null },
    category: { type: String, default: "" },
    subcategory: { type: String, default: "" },
    description: { type: String, default: "" },
    location: LocationSchema,
    priority: { type: String, enum: ["high", "medium", "low"], default: "low" },
    timestamp: { type: Date, default: Date.now },
    photos: [],
    incidentIds: [Schema.Types.ObjectId],
  },
  { _id: false },
);

// ─── Sub-esquema: datos de conocimiento ───────────────────────────────────────
const KnowledgeDataSchema = new Schema(
  {
    topic: { type: String, default: "" },
    content: { type: String, default: "" },
    summary: { type: String, default: "" },
    documentTitle: { type: String, default: "" },
    suggestedTitle: { type: String, default: "" },
    keywords: { type: [String], default: [] },
    documentType: {
      type: String,
      enum: ["pdf", "image", "text", "document", "other"],
      default: "text",
    },
    fileName: { type: String, default: "" },
    filePath: { type: String, default: "" },
    fileType: { type: String, default: "" },
    fileStatus: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },
    documentAnalysis: { type: String, default: "" },
    suggestedKeywords: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "pending",
        "pending_confirmation",
        "pending_title",
        "processing",
        "completed",
        "failed",
        "pending_approval",
      ],
      default: "pending",
    },
    documentStatus: {
      type: String,
      enum: [
        "pending_title",
        "pending_keywords",
        "processing",
        "completed",
        "failed",
      ],
      default: "processing",
    },
    lastUploadId: {
      type: Schema.Types.ObjectId,
      ref: "knowledge",
      default: null,
    },
    duplicateDocumentId: {
      type: Schema.Types.ObjectId,
      ref: "knowledge",
      default: null,
    },
    lastSearch: { type: String, default: "" },
    searchResults: [{ type: Schema.Types.ObjectId, ref: "knowledge" }],
    totalResults: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    timestamp: { type: Date, default: Date.now },
    processingProgress: { type: Number, default: 0 },
    processingMessage: { type: String, default: "" },
    processingError: { type: String, default: "" },
  },
  { _id: false },
);

// ─── Sub-esquema: historial de mensajes ───────────────────────────────────────
const HistoryEntrySchema = new Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },
    message: { type: String, required: false, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { _id: false },
);

// ─── Esquema principal ────────────────────────────────────────────────────────
export const ConversationSchema = new Schema(
  {
    senderId: { type: String, required: true, index: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "user",
      index: true,
      sparse: true,
    },
    state: { type: String, default: "initial", index: true },
    lastState: { type: String, default: "", index: true },
    tempUserData: { type: TempUserDataSchema, default: () => ({}) },
    tempIncidentData: { type: TempIncidentDataSchema, default: () => ({}) },
    knowledgeData: { type: KnowledgeDataSchema, default: () => ({}) },
    lastInteraction: { type: Date, default: Date.now, index: true },
    history: [HistoryEntrySchema],
    context: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// ─── Virtuals ─────────────────────────────────────────────────────────────────
ConversationSchema.virtual("userDataComplete").get(function () {
  if (this.userId) return true;
  if (!this.tempUserData) return false;
  const requiredFields = ["name", "dni", "telf"];
  return requiredFields.every(
    (f) => this.tempUserData[f]?.value && this.tempUserData[f]?.isValid,
  );
});

// ─── Métodos de instancia ─────────────────────────────────────────────────────
ConversationSchema.methods.formatHistoryForAI = function (limit = 10) {
  if (!this.history) return [];
  return this.history
    .slice(-limit)
    .filter((e) => e.role && e.message)
    .map((e) => ({ role: e.role, content: e.message }));
};

ConversationSchema.methods.getSummary = function () {
  return {
    id: this._id,
    senderId: this.senderId,
    state: this.state,
    isActive: this.isActive,
    historyLength: this.history?.length ?? 0,
    hasUserData:
      !!this.userId || Object.keys(this.tempUserData ?? {}).length > 0,
    hasIncidentData: Object.keys(this.tempIncidentData ?? {}).length > 0,
  };
};

// ─── Métodos estáticos ────────────────────────────────────────────────────────
ConversationSchema.statics.findExpired = async function (hours = 24) {
  const expiration = new Date();
  expiration.setHours(expiration.getHours() - hours);
  return this.find({ isActive: true, lastInteraction: { $lt: expiration } });
};

// ─── Nombre del token para inyección en NestJS ────────────────────────────────
/** Usar con @InjectModel(CONVERSATION_MODEL) */
export const CONVERSATION_MODEL = "Conversation";

// ─── Tipo de documento ────────────────────────────────────────────────────────
export type ConversationDocument = Document & {
  senderId: string;
  userId?: mongoose.Types.ObjectId;
  state: string;
  lastState: string;
  tempUserData: Record<string, any>;
  tempIncidentData: Record<string, any>;
  knowledgeData: Record<string, any>;
  lastInteraction: Date;
  history: Array<{
    role: string;
    message: string;
    metadata: any;
    timestamp: Date;
  }>;
  context: Record<string, any>;
  isActive: boolean;
  metadata: Record<string, any>;
  formatHistoryForAI(limit?: number): Array<{ role: string; content: string }>;
  getSummary(): Record<string, any>;
  markModified(path: string): void;
};
