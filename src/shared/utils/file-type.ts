/**
 * file-types.ts
 * Utilidad para clasificar archivos por mime/extensión y consultar reglas
 * de procesamiento. Migrada desde el antiguo utils/FileTypes.js.
 */

export type FileCategory =
  | "image"
  | "pdf"
  | "document"
  | "text"
  | "csv"
  | "spreadsheet"
  | "audio"
  | "video"
  | "unknown";

const MIME_TO_CATEGORY: Record<string, FileCategory> = {
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "pdf",
  "text/plain": "text",
  "text/csv": "csv",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "spreadsheet",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/webm": "audio",
  "audio/x-m4a": "audio",
  "video/mp4": "video",
  "video/mpeg": "video",
  "video/quicktime": "video",
  "video/webm": "video",
};

const EXT_TO_CATEGORY: Record<string, FileCategory> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  pdf: "pdf",
  txt: "text",
  md: "text",
  csv: "csv",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  wav: "audio",
  mp4: "video",
  mov: "video",
  avi: "video",
  webm: "video",
  mkv: "video",
};

// Extensión por defecto para un mime desconocido dentro de una categoría
const DEFAULT_EXT: Record<FileCategory, string> = {
  image: "jpg",
  pdf: "pdf",
  document: "pdf",
  text: "txt",
  csv: "csv",
  spreadsheet: "xlsx",
  audio: "mp3",
  video: "mp4",
  unknown: "bin",
};

// Límites de tamaño en bytes — 16 MB es el techo de WhatsApp para audio/video
const SIZE_LIMITS: Record<FileCategory, number> = {
  image: 16 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  text: 20 * 1024 * 1024,
  csv: 50 * 1024 * 1024,
  spreadsheet: 50 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  unknown: 10 * 1024 * 1024,
};

interface ProcessingConfig {
  extractText: boolean;
  canProcessWithAI: boolean;
}

const PROCESSING: Record<FileCategory, ProcessingConfig> = {
  image: { extractText: false, canProcessWithAI: true },
  pdf: { extractText: true, canProcessWithAI: true },
  document: { extractText: true, canProcessWithAI: true },
  text: { extractText: true, canProcessWithAI: true },
  csv: { extractText: true, canProcessWithAI: true },
  spreadsheet: { extractText: true, canProcessWithAI: true },
  audio: { extractText: false, canProcessWithAI: true },
  video: { extractText: false, canProcessWithAI: true },
  unknown: { extractText: false, canProcessWithAI: false },
};

export const FileTypes = {
  getTypeFromMime(mime: string): FileCategory {
    return MIME_TO_CATEGORY[(mime ?? "").toLowerCase()] ?? "unknown";
  },

  getExtensionFromMime(mime: string): string {
    return DEFAULT_EXT[this.getTypeFromMime(mime)];
  },

  getTypeFromExtension(ext: string): FileCategory {
    const normalized = (ext ?? "").toLowerCase().replace(/^\./, "");
    return EXT_TO_CATEGORY[normalized] ?? "unknown";
  },

  getSizeLimit(category: FileCategory): number {
    return SIZE_LIMITS[category] ?? SIZE_LIMITS.unknown;
  },

  isWithinSizeLimit(size: number, category: FileCategory): boolean {
    return size <= this.getSizeLimit(category);
  },

  getProcessingConfig(category: FileCategory): ProcessingConfig {
    return PROCESSING[category] ?? PROCESSING.unknown;
  },

  canProcessWithAI(category: FileCategory): boolean {
    return this.getProcessingConfig(category).canProcessWithAI;
  },
};
