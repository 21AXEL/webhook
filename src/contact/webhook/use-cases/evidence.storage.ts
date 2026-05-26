// Utilidades y constantes de almacenamiento de evidencias para tickets.
// Es la única fuente de verdad: tanto los use-cases de WhatsApp como la
// configuración de Multer (src/config/multer.config.ts) consumen de aquí.

import { existsSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { randomUUID } from "crypto";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────

// Extensiones permitidas — validación desde WhatsApp (buffer + originalName)
export const ALLOWED_EXTENSIONS = new Set([
  // Imágenes
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  // Documentos
  ".pdf",
  // Video
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mkv",
  // Audio
  ".mp3",
  ".ogg",
  ".wav",
  ".opus",
  ".m4a",
]);

// MIME types permitidos — validación desde Multer (upload HTTP)
// Deben coincidir conceptualmente con ALLOWED_EXTENSIONS.
export const ALLOWED_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

// Tamaño máximo por archivo: 10 MB
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Número máximo de archivos por solicitud HTTP
export const MAX_FILES_PER_REQUEST = 5;

// Directorio base en disco (relativo a la raíz del proceso).
// Cambiar este valor afecta tanto al upload HTTP como al de WhatsApp.
export const UPLOAD_BASE_DIR = join(process.cwd(), "uploads", "tickets");

// ─────────────────────────────────────────────
// Helpers de disco
// ─────────────────────────────────────────────

/**
 * Crea el directorio del ticket si no existe y retorna la ruta absoluta.
 */
export const ensureTicketDir = (ticketId: string): string => {
  const dir = join(UPLOAD_BASE_DIR, ticketId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/**
 * Genera un nombre de archivo único preservando la extensión original.
 * UUID evita colisiones y caracteres inválidos en el sistema de archivos.
 */
export const generateFilename = (originalName: string): string => {
  const ext = extname(originalName).toLowerCase();
  return `${randomUUID()}${ext}`;
};

// ─────────────────────────────────────────────
// Helpers de rutas y URLs
// ─────────────────────────────────────────────

/**
 * Retorna la ruta relativa que se persiste en MongoDB.
 * Formato: uploads/tickets/<ticketId>/<filename>
 */
export const buildStoragePath = (ticketId: string, filename: string): string =>
  `uploads/tickets/${ticketId}/${filename}`;

/**
 * Construye la URL pública de acceso al archivo.
 * Cambiar esta función es suficiente para migrar a almacenamiento en la nube.
 */
export const buildEvidenceUrl = (
  baseUrl: string,
  ticketId: string,
  filename: string,
): string => `${baseUrl}/uploads/tickets/${ticketId}/${filename}`;
