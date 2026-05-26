// Configuración de Multer para almacenamiento de evidencias en disco.
// Las constantes (extensiones permitidas, tamaño máximo, directorio base)
// se importan desde evidence.storage.ts para evitar duplicación.
//
// IMPORTANTE: este archivo reemplaza al antiguo multer.congif.ts (typo).
// Eliminar manualmente el archivo viejo tras aplicar este cambio.
import { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";
import { BadRequestException } from "@nestjs/common";
import { diskStorage } from "multer";
import { Request } from "express";
import { extname } from "path";

import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_FILES_PER_REQUEST,
  UPLOAD_BASE_DIR,
  ensureTicketDir,
  generateFilename,
} from "../contact/webhook/use-cases/evidence.storage";

// Re-exportamos los helpers de URLs/paths para que controladores HTTP los
// importen desde este módulo de configuración sin acoplarse al path interno.
export {
  buildEvidenceUrl,
  buildStoragePath,
} from "../contact/webhook/use-cases/evidence.storage";

/**
 * Opciones de Multer para el endpoint de evidencias.
 * El ticketId se extrae del parámetro de ruta `/:ticketId/evidences`.
 */
export const evidenceMulterOptions = (): MulterOptions => ({
  storage: diskStorage({
    destination: (
      req: Request,
      _file: Express.Multer.File,
      cb: (error: Error | null, destination: string) => void,
    ) => {
      const ticketId: string = req.params["ticketId"]?.toString() ?? "unknown";
      // ensureTicketDir crea el directorio si no existe y respeta UPLOAD_BASE_DIR
      const dir = ensureTicketDir(ticketId);
      cb(null, dir);
    },
    filename: (
      _req: Request,
      file: Express.Multer.File,
      cb: (error: Error | null, filename: string) => void,
    ) => {
      // generateFilename ya valida extensión y produce UUID
      cb(null, generateFilename(file.originalname));
    },
  }),

  fileFilter: (
    _req: Request,
    file: Express.Multer.File,
    cb: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(
        new BadRequestException(
          `Tipo de archivo no permitido: ${file.mimetype}. ` +
            `Tipos válidos: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
        ),
        false,
      );
    }
    // Defensa en profundidad: validar también la extensión del archivo
    const ext = extname(file.originalname).toLowerCase();
    if (!ext) {
      return cb(
        new BadRequestException(
          "El archivo no tiene extensión y no puede ser procesado.",
        ),
        false,
      );
    }
    cb(null, true);
  },

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_REQUEST,
  },
});

// Re-export para compatibilidad con código que importe UPLOAD_BASE_DIR
// directamente desde la configuración Multer.
export { UPLOAD_BASE_DIR };
