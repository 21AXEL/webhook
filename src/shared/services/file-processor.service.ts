/**
 * file-processor.service.ts
 *
 * Servicio de infraestructura para procesamiento de archivos.
 * Migrado desde UnifiedFileProcessorService.js — ServiceLocator reemplazado por DI.
 *
 * Mantiene la API original (extractTextFromDocument, transcribeAudio,
 * analyzeImage, processFileWithAI…) para que los use-cases existentes funcionen
 * sin modificarse.
 *
 * Responsabilidades:
 *   - Operaciones de disco (guardar, descargar desde URL, limpiar temporales)
 *   - Extracción de texto desde PDF, TXT, CSV (papaparse + pdf-parse)
 *   - Transcripción de audio/video vía OpenAI Whisper (ffmpeg para convertir)
 *   - Análisis de imágenes vía OpenAI Vision
 *   - Análisis de contenido textual con OpenAI
 *
 * Lo que NO hace (ya está en otros servicios):
 *   - Obtener URL ni descargar binarios desde WhatsApp → WhatsAppService
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  createReadStream,
  createWriteStream,
} from "fs";
import { join, extname, basename, isAbsolute, resolve } from "path";
import { finished } from "stream/promises";
import axios from "axios";
import FormData from "form-data";
import Papa from "papaparse";
import ffmpeg from "fluent-ffmpeg";
import { PDFParse, LoadParameters } from "pdf-parse";

import { FileTypes, FileCategory } from "../utils/file-type";

// @ffmpeg-installer/ffmpeg es CommonJS sin tipos propios; lo cargamos con require
// para evitar declarar un módulo ambiente y mantener el tipado mínimo.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegInstaller: { path: string } = require("@ffmpeg-installer/ffmpeg");
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ─────────────────────────────────────────────
// Tipos públicos
// ─────────────────────────────────────────────

export interface SavedFile {
  path: string;
  filename: string;
  extension: string;
  fileType: FileCategory;
}

export interface TextExtractionResult {
  content: string;
  keywords: string[];
  type: FileCategory;
  metadata?: Record<string, any>;
  data?: any;
}

export interface AIProcessingResult {
  analysis: string;
  rawContent?: string;
  model: string;
  keywords?: string[];
}

export interface ProcessFileOptions {
  prompt?: string;
  systemPrompt?: string;
  userPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

// ─────────────────────────────────────────────

@Injectable()
export class FileProcessor {
  private readonly logger = new Logger(FileProcessor.name);

  // Rutas absolutas — expuestas para que use-cases puedan elegir dónde guardar
  public readonly uploadsBaseDir: string;
  public readonly knowledgePath: string;
  public readonly incidentsPath: string;
  public readonly documentsPath: string;
  public readonly audiosPath: string;
  public readonly videosPath: string;
  public readonly tempPath: string;

  private readonly openaiApiKey: string;
  private readonly openaiChatEndpoint =
    "https://api.openai.com/v1/chat/completions";
  private readonly openaiWhisperEndpoint =
    "https://api.openai.com/v1/audio/transcriptions";

  constructor(private readonly configService: ConfigService) {
    // Lee la ruta base desde config, con fallback al directorio local
    this.uploadsBaseDir =
      this.configService.get<string>("files.basePath") ??
      resolve(process.cwd(), "uploads");

    this.knowledgePath = join(this.uploadsBaseDir, "knowledge");
    this.incidentsPath = join(this.uploadsBaseDir, "incidentes_denuncia");
    this.documentsPath = join(this.uploadsBaseDir, "documentos");
    this.audiosPath = join(this.uploadsBaseDir, "audios");
    this.videosPath = join(this.uploadsBaseDir, "videos");
    this.tempPath = join(this.uploadsBaseDir, "temp");

    this.openaiApiKey = this.configService.get<string>("CHATGPT_API_KEY") ?? "";

    this._initializeDirectories();
  }

  // ─── Operaciones de archivo ────────────────────────────────────────────────

  /** Guarda un buffer en disco bajo el directorio indicado. */
  async saveFile(
    fileBuffer: Buffer,
    filename: string,
    extension: string,
    directory: string,
  ): Promise<SavedFile> {
    try {
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

      const filePath = join(directory, `${filename}.${extension}`);
      writeFileSync(filePath, fileBuffer);
      this.logger.log(`Archivo guardado: ${filePath}`);

      return {
        path: filePath,
        filename: `${filename}.${extension}`,
        extension,
        fileType: FileTypes.getTypeFromExtension(extension),
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Error al guardar archivo: ${(error as Error).message}`,
      );
    }
  }

  /** Descarga un archivo desde URL y lo guarda en disco. */
  async downloadFileFromUrl(
    url: string,
    filename: string,
    directory: string,
  ): Promise<SavedFile> {
    try {
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

      const outputPath = join(directory, filename);
      const writer = createWriteStream(outputPath);
      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
      });

      response.data.pipe(writer);
      await finished(writer);

      const extension = extname(filename).slice(1);
      return {
        path: outputPath,
        filename,
        extension,
        fileType: FileTypes.getTypeFromExtension(extension),
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Error descargando archivo: ${(error as Error).message}`,
      );
    }
  }

  /** Guarda un archivo en el directorio temporal (limpiable con cleanupTempFiles). */
  async saveTempFile(buffer: Buffer, filename: string): Promise<SavedFile> {
    const extension = extname(filename).slice(1) || "tmp";
    const base = basename(filename, `.${extension}`);
    return this.saveFile(buffer, base, extension, this.tempPath);
  }

  /** Elimina archivos temporales más antiguos que `maxAgeHours`. */
  async cleanupTempFiles(maxAgeHours = 24): Promise<void> {
    try {
      if (!existsSync(this.tempPath)) return;

      const files = readdirSync(this.tempPath);
      const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = join(this.tempPath, file);
        const stats = statSync(filePath);
        if (stats.mtimeMs < cutoffMs) {
          unlinkSync(filePath);
          this.logger.log(`Archivo temporal eliminado: ${filePath}`);
        }
      }
    } catch (error) {
      // Best-effort: registramos pero no propagamos
      this.logger.error(
        `Error limpiando archivos temporales: ${(error as Error).message}`,
      );
    }
  }

  // ─── Extracción de texto ───────────────────────────────────────────────────

  /** Extrae texto de un PDF y calcula keywords básicas. */
  // Luego modifica el método extractTextFromPdf:
  async extractTextFromPdf(filePath: string): Promise<TextExtractionResult> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`PDF no encontrado: ${absolutePath}`);
    }

    try {
      const buffer = readFileSync(absolutePath);

      // Crear parámetros de carga para PDFParse
      const loadParams: LoadParameters = {
        data: buffer,
      };

      // Crear instancia del parser
      const pdfParser = new PDFParse(loadParams);

      // Extraer texto usando getText
      const textResult = await pdfParser.getText();

      // También puedes obtener metadata adicional con getInfo
      const infoResult = await pdfParser.getInfo();

      // Limpiar recursos
      await pdfParser.destroy();

      return {
        content: textResult.text,
        keywords: this.extractKeywords(textResult.text),
        type: "pdf",
        metadata: {
          pages: textResult.total,
          info: infoResult.info,
        },
      };
    } catch (error: any) {
      this.logger.error(`Error extrayendo texto del PDF: ${error.message}`);
      throw new InternalServerErrorException(
        `Error procesando PDF: ${error.message}`,
      );
    }
  }

  /**
   * Extrae texto desde diferentes formatos según la extensión.
   * Tipos soportados: pdf, text, csv.
   */
  async extractTextFromDocument(
    filePath: string,
  ): Promise<TextExtractionResult> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Archivo no encontrado: ${absolutePath}`);
    }

    const extension = extname(absolutePath).toLowerCase().slice(1);
    const fileType = FileTypes.getTypeFromExtension(extension);

    if (!FileTypes.getProcessingConfig(fileType).extractText) {
      throw new BadRequestException(
        `No se puede extraer texto de archivos tipo '${fileType}'`,
      );
    }

    switch (fileType) {
      case "pdf":
        return this.extractTextFromPdf(absolutePath);

      case "text": {
        const content = readFileSync(absolutePath, "utf8");
        return {
          content,
          keywords: this.extractKeywords(content),
          type: "text",
        };
      }

      case "csv": {
        const csvRaw = readFileSync(absolutePath, "utf8");
        const parsed = Papa.parse(csvRaw, { header: true });
        return {
          content: JSON.stringify(parsed.data),
          keywords: this.extractKeywords(csvRaw),
          type: "csv",
          data: parsed.data,
        };
      }

      default:
        return {
          content: `[Tipo de documento no soportado: .${extension}]`,
          keywords: [],
          type: fileType,
        };
    }
  }

  /**
   * Extracción simple de palabras clave por frecuencia.
   * Descarta stopwords comunes en español y tokens de menos de 4 caracteres.
   */
  extractKeywords(content: string, maxKeywords = 10): string[] {
    if (!content || typeof content !== "string") return [];

    const stopwords = new Set([
      "ante",
      "bajo",
      "como",
      "con",
      "contra",
      "desde",
      "durante",
      "entre",
      "hacia",
      "hasta",
      "mediante",
      "para",
      "pero",
      "porque",
      "según",
      "sobre",
      "tras",
      "fueron",
      "este",
      "esta",
      "estos",
      "estas",
      "esto",
      "ese",
      "esa",
      "esos",
      "esas",
      "eso",
      "los",
      "las",
      "unos",
      "unas",
      "del",
      "más",
      "muy",
      "sus",
      "fue",
      "han",
      "sido",
      "que",
      "cual",
      "cuales",
      "quien",
      "quienes",
      "donde",
      "cuando",
      "cuanto",
    ]);

    const counts = new Map<string, number>();
    const tokens = content
      .toLowerCase()
      .replace(/[^\wáéíóúüñ\s]/g, " ")
      .split(/\s+/);

    for (const token of tokens) {
      if (token.length <= 3 || stopwords.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word]) => word);
  }

  // ─── Audio y video ─────────────────────────────────────────────────────────

  /** Convierte un audio a MP3. Si ya es MP3, retorna la misma ruta. */
  async convertAudioToMp3(filePath: string): Promise<string> {
    const fileExt = extname(filePath).toLowerCase();
    if (fileExt === ".mp3") return filePath;

    const outputPath = filePath.replace(fileExt, ".mp3");

    return new Promise<string>((resolveP, rejectP) => {
      ffmpeg(filePath)
        .output(outputPath)
        .audioCodec("libmp3lame")
        .on("end", () => resolveP(outputPath))
        .on("error", (err: Error) =>
          rejectP(new Error(`Error convirtiendo audio: ${err.message}`)),
        )
        .run();
    });
  }

  /** Extrae la pista de audio de un video, en MP3. */
  async extractAudioFromVideo(videoPath: string): Promise<string> {
    const audioPath = videoPath.replace(extname(videoPath), ".mp3");

    return new Promise<string>((resolveP, rejectP) => {
      ffmpeg(videoPath)
        .output(audioPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .on("end", () => resolveP(audioPath))
        .on("error", (err: Error) =>
          rejectP(new Error(`Error extrayendo audio: ${err.message}`)),
        )
        .run();
    });
  }

  /**
   * Transcribe audio con OpenAI Whisper.
   * Convierte a MP3 si es necesario y limpia el intermedio.
   */
  async transcribeAudio(filePath: string): Promise<string> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Audio no encontrado: ${absolutePath}`);
    }
    if (!this.openaiApiKey) {
      throw new InternalServerErrorException(
        "CHATGPT_API_KEY no configurada — no se puede transcribir audio",
      );
    }

    const mp3Path = await this.convertAudioToMp3(absolutePath);

    try {
      const form = new FormData();
      form.append("file", createReadStream(mp3Path));
      form.append("model", "whisper-1");
      form.append("response_format", "text");

      const { data } = await axios.post(this.openaiWhisperEndpoint, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
        maxBodyLength: Infinity,
      });

      return typeof data === "string" ? data : (data?.text ?? "");
    } finally {
      // Limpia el intermedio sólo si fue convertido (no era el original)
      if (mp3Path !== absolutePath && existsSync(mp3Path)) {
        try {
          unlinkSync(mp3Path);
        } catch {
          /* noop */
        }
      }
    }
  }

  /** Transcribe un video extrayendo primero su audio. */
  async transcribeVideo(filePath: string): Promise<string> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Video no encontrado: ${absolutePath}`);
    }

    const audioPath = await this.extractAudioFromVideo(absolutePath);
    try {
      return await this.transcribeAudio(audioPath);
    } finally {
      if (existsSync(audioPath)) {
        try {
          unlinkSync(audioPath);
        } catch {
          /* noop */
        }
      }
    }
  }

  // ─── Análisis con IA (llamadas directas a OpenAI) ──────────────────────────

  /**
   * Analiza una imagen con OpenAI Vision (gpt-4o).
   * Llamada directa para no acoplar este servicio a AiService.
   * Si prefieres centralizar la lógica de IA, construye el dataURL aquí
   * y pásalo a AiService.analyzeImage() desde el use-case.
   */
  async analyzeImage(
    filePath: string,
    prompt = "Describe detalladamente el contenido de esta imagen.",
  ): Promise<{ content: string; model: string; usage: any }> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Imagen no encontrada: ${absolutePath}`);
    }
    if (!this.openaiApiKey) {
      throw new InternalServerErrorException(
        "CHATGPT_API_KEY no configurada — no se puede analizar imagen",
      );
    }

    const base64 = readFileSync(absolutePath).toString("base64");
    const model = "gpt-4o";

    const { data } = await axios.post(
      this.openaiChatEndpoint,
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${base64}` },
              },
            ],
          },
        ],
        max_tokens: 500,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
      },
    );

    return {
      content: data.choices[0].message.content,
      model,
      usage: data.usage,
    };
  }

  /**
   * Procesa un archivo con IA según su tipo:
   *   - image:        análisis visual
   *   - audio/video:  transcripción + análisis del transcript
   *   - pdf/text/csv: extracción + análisis del contenido
   */
  async processFileWithAI(
    filePath: string,
    options: ProcessFileOptions = {},
  ): Promise<AIProcessingResult> {
    const absolutePath = this._resolveAbsolute(filePath);
    if (!existsSync(absolutePath)) {
      throw new NotFoundException(`Archivo no encontrado: ${absolutePath}`);
    }

    const extension = extname(absolutePath).toLowerCase().slice(1);
    const fileType = FileTypes.getTypeFromExtension(extension);

    if (!FileTypes.canProcessWithAI(fileType)) {
      throw new BadRequestException(
        `Archivos tipo '${fileType}' no pueden procesarse con IA`,
      );
    }

    // Imagen: análisis visual directo
    if (fileType === "image") {
      const result = await this.analyzeImage(
        absolutePath,
        options.prompt ?? "Analiza esta imagen y describe su contenido.",
      );
      return { analysis: result.content, model: result.model };
    }

    // Resto: extraer texto y enviar al modelo de chat
    const extraction = await this._extractContentByFileType(
      absolutePath,
      fileType,
    );
    const model = options.model ?? this._defaultModelForType(fileType);

    const { data } = await axios.post(
      this.openaiChatEndpoint,
      {
        model,
        messages: [
          {
            role: "system",
            content:
              options.systemPrompt ??
              "Analiza el siguiente contenido y extrae la información más relevante.",
          },
          {
            role: "user",
            content: options.userPrompt
              ? `${options.userPrompt}\n\n${extraction.content}`
              : `Analiza el siguiente contenido:\n\n${extraction.content}`,
          },
        ],
        max_tokens: options.maxTokens ?? 800,
        temperature: options.temperature ?? 0.3,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.openaiApiKey}`,
        },
      },
    );

    return {
      analysis: data.choices[0].message.content,
      rawContent: extraction.content,
      model,
      ...(extraction.keywords?.length ? { keywords: extraction.keywords } : {}),
    };
  }

  // ─── Helpers privados ──────────────────────────────────────────────────────

  private async _extractContentByFileType(
    filePath: string,
    fileType: FileCategory,
  ): Promise<TextExtractionResult> {
    switch (fileType) {
      case "pdf":
        return this.extractTextFromPdf(filePath);

      case "audio": {
        const transcript = await this.transcribeAudio(filePath);
        return {
          content: transcript,
          keywords: this.extractKeywords(transcript),
          type: "audio",
        };
      }

      case "video": {
        const transcript = await this.transcribeVideo(filePath);
        return {
          content: transcript,
          keywords: this.extractKeywords(transcript),
          type: "video",
        };
      }

      case "text":
      case "csv":
      case "spreadsheet":
      case "document":
        return this.extractTextFromDocument(filePath);

      default:
        throw new BadRequestException(
          `No se puede extraer contenido del tipo: ${fileType}`,
        );
    }
  }

  private _defaultModelForType(fileType: FileCategory): string {
    // PDFs y hojas de cálculo se benefician de un modelo más capaz
    if (
      fileType === "pdf" ||
      fileType === "csv" ||
      fileType === "spreadsheet"
    ) {
      return "gpt-4o";
    }
    return "gpt-4o-mini";
  }

  private _resolveAbsolute(filePath: string): string {
    return isAbsolute(filePath)
      ? filePath
      : join(this.uploadsBaseDir, filePath);
  }

  private _initializeDirectories(): void {
    const dirs = [
      this.uploadsBaseDir,
      this.knowledgePath,
      this.incidentsPath,
      this.documentsPath,
      this.audiosPath,
      this.videosPath,
      this.tempPath,
    ];
    for (const dir of dirs) {
      try {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      } catch (error) {
        this.logger.error(
          `No se pudo crear el directorio ${dir}: ${(error as Error).message}`,
        );
      }
    }
  }
}
