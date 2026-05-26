/**
 * media-processor.service.ts
 * Servicio de infraestructura para procesar archivos multimedia de WhatsApp.
 * Migrado desde MediaProcessor.js — ServiceLocator reemplazado por DI de NestJS.
 * UnifiedFileProcessorService reemplazado por WhatsAppService.getMediaUrl().
 */
import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "./ai.service";
import { WhatsAppService } from "./whatsapp.service";

@Injectable()
export class MediaProcessorService {
  private readonly logger = new Logger(MediaProcessorService.name);

  constructor(
    private readonly aiService: AiService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  // ─── Punto de entrada público ──────────────────────────────────────────────────

  /**
   * Procesa un archivo multimedia recibido de WhatsApp
   * @param message      - Mensaje que contiene el multimedia
   * @param conversation - Conversación actual
   * @returns Resultado del procesamiento
   */
  async processMedia(message: any, conversation: any): Promise<any> {
    if (!message || !message.type) {
      return { success: false, error: "Mensaje no válido" };
    }

    // Determinar el tipo de multimedia
    const mediaTypes = ["image", "video", "audio", "document", "sticker"];
    if (!mediaTypes.includes(message.type)) {
      return { success: false, error: "Tipo de archivo no soportado" };
    }

    try {
      this.logger.log(`Procesando archivo multimedia tipo: ${message.type}`);

      // Extraer información del archivo según su tipo
      const mediaId = message[message.type]?.id;
      const mimeType = message[message.type]?.mime_type;
      const filename =
        message[message.type]?.filename ||
        `${message.type}_${Date.now()}.${this._getDefaultExtension(message.type)}`;

      if (!mediaId) {
        this.logger.warn(`No se encontró ID válido para ${message.type}`);
        return { success: false, error: "ID de archivo inválido" };
      }

      // Obtener URL de descarga desde la API de WhatsApp
      // (reemplaza this.fileProcessor.processWhatsAppMedia de Express)
      const mediaUrl = await this.whatsAppService.getMediaUrl(mediaId);

      if (!mediaUrl) {
        return { success: false, error: "Error obteniendo URL del archivo" };
      }

      // Construir objeto de archivo procesado
      const processedFile = {
        path: mediaUrl,
        filename: filename,
        fileType: mimeType || message.type,
      };

      return {
        success: true,
        mediaType: message.type,
        filePath: processedFile.path,
        fileName: processedFile.filename,
        fileType: processedFile.fileType,
        analysis: null, // Análisis deshabilitado (ver _analyzeMedia)
        captionText: message.caption || "",
      };
    } catch (error: any) {
      this.logger.error(
        `Error procesando archivo multimedia: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
        mediaType: message.type,
      };
    }
  }

  // ─── Análisis de contenido multimedia ───────────────────────────────────────

  /**
   * Analiza el contenido del archivo multimedia
   * @param fileInfo  - Información del archivo procesado
   * @param mediaType - Tipo de multimedia
   * @param conversation - Conversación actual
   * @returns Resultado del análisis
   */
  async _analyzeMedia(
    fileInfo: any,
    mediaType: string,
    conversation: any,
  ): Promise<any> {
    try {
      if (!fileInfo.path) return null;

      switch (mediaType) {
        case "image":
          return await this._analyzeImage(fileInfo.path, conversation);
        case "document":
          return await this._analyzeDocument(fileInfo, conversation);
        case "audio":
          return await this._analyzeAudio(fileInfo.path, conversation);
        case "video":
          return await this._analyzeVideo(fileInfo.path, conversation);
        default:
          return null;
      }
    } catch (error: any) {
      this.logger.error(`Error analizando ${mediaType}: ${error.message}`);
      return { error: error.message };
    }
  }

  /**
   * Analiza una imagen con IA
   * @param imagePath    - URL o ruta de la imagen
   * @param conversation - Conversación actual
   * @returns Resultado del análisis
   */
  async _analyzeImage(imagePath: string, conversation: any): Promise<any> {
    try {
      const prompt =
        "Analiza esta imagen y describe brevemente su contenido. " +
        "Si contiene texto, transcríbelo. " +
        "Si parece un incidente o emergencia, indícalo.";

      const analysis = await this.aiService.analyzeImage(imagePath, prompt);

      return {
        success: true,
        type: "image_analysis",
        content: analysis.content,
        incidentDetected: this._detectIncidentInText(analysis.content || ""),
        summary: this._summarizeText(analysis.content || "", 100),
      };
    } catch (error: any) {
      this.logger.error(`Error analizando imagen: ${error.message}`);
      return { success: false, type: "image_analysis", error: error.message };
    }
  }

  /**
   * Analiza un documento
   * @param fileInfo     - Información del archivo procesado
   * @param conversation - Conversación actual
   * @returns Resultado del análisis
   */
  async _analyzeDocument(fileInfo: any, conversation: any): Promise<any> {
    try {
      // Sin UnifiedFileProcessorService, devolvemos info básica del archivo
      return {
        success: true,
        type: "document_analysis",
        content: "",
        contentType: fileInfo.fileType || "unknown",
        purpose: "general",
        keywords: [],
        summary: "",
      };
    } catch (error: any) {
      this.logger.error(`Error analizando documento: ${error.message}`);
      return {
        success: false,
        type: "document_analysis",
        error: error.message,
      };
    }
  }

  /**
   * Analiza un archivo de audio (stub — requiere servicio de transcripción externo)
   * @param audioPath    - URL o ruta del archivo de audio
   * @param conversation - Conversación actual
   * @returns Resultado del análisis
   */
  async _analyzeAudio(audioPath: string, conversation: any): Promise<any> {
    return {
      success: false,
      type: "audio_analysis",
      error: "Transcripción de audio no disponible en este entorno",
    };
  }

  /**
   * Analiza un archivo de video (stub — requiere servicio de transcripción externo)
   * @param videoPath    - URL o ruta del archivo de video
   * @param conversation - Conversación actual
   * @returns Resultado del análisis
   */
  async _analyzeVideo(videoPath: string, conversation: any): Promise<any> {
    return {
      success: false,
      type: "video_analysis",
      error: "Transcripción de video no disponible en este entorno",
    };
  }

  // ─── Helpers de detección y resumen ───────────────────────────────────────────

  /**
   * Detecta si un texto contiene palabras clave de emergencia
   * @param text - Texto a analizar
   * @returns True si se detectan palabras de emergencia
   */
  _detectEmergencyInText(text: string): boolean {
    if (!text) return false;

    const emergencyKeywords = [
      "emergencia",
      "auxilio",
      "socorro",
      "ambulancia",
      "ayuda urgente",
      "incendio",
      "accidente grave",
      "herido",
      "sangre",
      "bomba",
      "armado",
      "disparo",
      "fuego",
      "ataque",
      "desastre",
    ];

    const normalizedText = text.toLowerCase();
    return emergencyKeywords.some((keyword) =>
      normalizedText.includes(keyword),
    );
  }

  /**
   * Detecta si un texto contiene palabras clave de incidente
   * @param text - Texto a analizar
   * @returns True si se detectan palabras de incidente
   */
  _detectIncidentInText(text: string): boolean {
    if (!text) return false;

    const incidentKeywords = [
      "problema",
      "incidente",
      "daño",
      "roto",
      "avería",
      "basura",
      "agua",
      "luz",
      "electricidad",
      "alcantarilla",
      "calle",
      "bache",
      "accidente",
      "robo",
      "delito",
      "denuncia",
      "queja",
      "reporte",
    ];

    const normalizedText = text.toLowerCase();
    return incidentKeywords.some((keyword) => normalizedText.includes(keyword));
  }

  /**
   * Crea un resumen de un texto largo
   * @param text     - Texto a resumir
   * @param maxChars - Longitud máxima del resumen
   * @returns Texto resumido
   */
  _summarizeText(text: string, maxChars = 100): string {
    if (!text) return "";
    if (text.length <= maxChars) return text;

    // Buscar el último espacio antes del límite
    const cutOff = text.lastIndexOf(" ", maxChars);
    if (cutOff === -1) return text.substring(0, maxChars) + "...";
    return text.substring(0, cutOff) + "...";
  }

  /**
   * Obtiene la extensión predeterminada para un tipo de multimedia
   * @param mediaType - Tipo de multimedia
   * @returns Extensión predeterminada
   */
  private _getDefaultExtension(mediaType: string): string {
    const defaultExtensions: Record<string, string> = {
      image: "jpg",
      video: "mp4",
      audio: "mp3",
      document: "pdf",
      sticker: "webp",
    };
    return defaultExtensions[mediaType] || "bin";
  }
}
