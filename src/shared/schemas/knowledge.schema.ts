/**
 * knowledge.schema.ts
 * Esquema de Mongoose para los documentos de conocimiento.
 * RESTRICCIÓN: No modificar la estructura del documento — existen registros en producción.
 * El nombre del modelo 'knowledge' determina la colección 'knowledges' en MongoDB.
 */

import mongoose, { Document, Schema } from "mongoose";

export const KnowledgeSchema = new Schema(
  {
    topic: { type: String, required: true, index: true },
    summary: { type: String, required: false },
    content: { type: String, required: true },
    keywords: [{ type: String, index: true }],
    documentType: {
      type: String,
      enum: ["pdf", "text", "other"],
      default: "text",
    },
    creator: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      default: null,
    },
    approved: { type: Boolean, default: false, index: true },
    isActive: { type: Boolean, default: true, index: true },
    originalFilename: { type: String, default: "" },
    fileUrl: { type: String, default: "" },
    version: { type: Number, default: 1 },
    previousVersions: [
      {
        content: String,
        updatedBy: { type: Schema.Types.ObjectId, ref: "user" },
        updatedAt: { type: Date, default: Date.now },
      },
    ],
    processingStatus: {
      status: {
        type: String,
        enum: ["pending", "processing", "completed", "failed", "rejected"],
        default: "pending",
      },
      progress: { type: Number, default: 0, min: 0, max: 100 },
      startedAt: Date,
      completedAt: Date,
      updatedAt: Date,
      statusMessage: String,
      error: String,
    },
    structuredContent: {
      isAvailable: { type: Boolean, default: false },
      currentVersion: { type: Number, default: 1 },
      lastUpdated: Date,
      contentRef: { type: Schema.Types.ObjectId, ref: "structuredContent" },
    },
  },
  { timestamps: true },
);

// ─── Índices de texto ─────────────────────────────────────────────────────────
KnowledgeSchema.index(
  { topic: "text", content: "text", summary: "text", keywords: "text" },
  {
    weights: { topic: 10, keywords: 5, summary: 3, content: 1 },
    name: "TextSearchIndex",
  },
);
KnowledgeSchema.index({ "structuredContent.isAvailable": 1 });
KnowledgeSchema.index({ "processingStatus.status": 1 });

// ─── Middleware pre-save ───────────────────────────────────────────────────────
KnowledgeSchema.pre("save", async function (next) {
  // Inicializar structuredContent si no existe
  if (!this.structuredContent) {
    this.structuredContent = {
      isAvailable: false,
      currentVersion: 1,
    };
  }

  // Si el contenido o versión cambian, marcar que necesita actualización
  if (this.isModified("content") || this.isModified("version")) {
    this.structuredContent.isAvailable = false;
    this.structuredContent.lastUpdated = new Date();
  }

  next();
});

// ─── Middleware pre-findOneAndUpdate (opcional, para actualizaciones directas) ──
KnowledgeSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate() as any;

  // Si la actualización incluye cambios en content o version
  if (
    update?.$set?.content ||
    update?.content ||
    update?.$set?.version ||
    update?.version
  ) {
    if (!update.$set) update.$set = {};

    // Inicializar structuredContent si no existe
    if (!update.$set.structuredContent) {
      update.$set.structuredContent = {
        isAvailable: false,
        currentVersion: 1,
        lastUpdated: new Date(),
      };
    } else {
      update.$set.structuredContent.isAvailable = false;
      update.$set.structuredContent.lastUpdated = new Date();
    }
  }

  next();
});

// ─── Método estático para verificar estructura ─────────────────────────────────
KnowledgeSchema.statics.ensureStructure = function (doc: any) {
  if (!doc.structuredContent) {
    doc.structuredContent = {
      isAvailable: false,
      currentVersion: 1,
    };
  }
  if (!doc.processingStatus) {
    doc.processingStatus = {
      status: "pending",
      progress: 0,
    };
  }
  return doc;
};

// ─── Nombre del token para inyección en NestJS ────────────────────────────────
/** Usar con @InjectModel(KNOWLEDGE_MODEL) */
export const KNOWLEDGE_MODEL = "knowledge";

// ─── Tipo de documento ────────────────────────────────────────────────────────
export type KnowledgeDocument = Document & {
  topic: string;
  summary?: string;
  content: string;
  keywords: string[];
  documentType: "pdf" | "text" | "other";
  creator: mongoose.Types.ObjectId;
  approvedBy: mongoose.Types.ObjectId | null;
  approved: boolean;
  isActive: boolean;
  originalFilename: string;
  fileUrl: string;
  version: number;
  previousVersions: Array<{
    content: string;
    updatedBy: mongoose.Types.ObjectId;
    updatedAt: Date;
  }>;
  processingStatus: {
    status: string;
    progress: number;
    startedAt?: Date;
    completedAt?: Date;
    updatedAt?: Date;
    statusMessage?: string;
    error?: string;
  };
  structuredContent: {
    isAvailable: boolean;
    currentVersion: number;
    lastUpdated?: Date;
    contentRef?: mongoose.Types.ObjectId;
  };
};
