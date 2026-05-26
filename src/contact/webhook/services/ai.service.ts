/**
 * ai.service.ts
 * Servicio de infraestructura para interacción exclusiva con la API de OpenAI.
 * Migrado desde AIService.js — ServiceLocator reemplazado por DI de NestJS.
 * Optimizado para el aplicativo "Esmeraldas La Bella".
 */
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  private readonly config: { apiKey: string; endpoint: string };

  // Core system prompt - para el asistente virtual de Esmeraldas
  private readonly corePrompt: { role: string; content: string };

  // Configuraciones de modelos con propósitos específicos
  private readonly models: {
    standard: { id: string; maxTokens: number; temperature: number };
    advanced: { id: string; maxTokens: number; temperature: number };
    vision: { id: string; maxTokens: number; temperature: number };
  };

  constructor(private readonly configService: ConfigService) {
    this.config = {
      apiKey: this.configService.get<string>("CHATGPT_API_KEY") || "",
      endpoint: "https://api.openai.com/v1/chat/completions",
    };

    this.corePrompt = {
      role: "system",
      content: `Asistente virtual de Esmeraldas para el aplicativo "Esmeraldas La Bella".
      
      Funciones:
      - Registrar incidentes (tipo, ubicación, prioridad)
      - Gestionar usuarios (validar datos, proteger información)
      - Asistir con emergencias (identificación, instrucciones)
      - Notificar recolección de basura cercana
      - Gestionar información municipal (análisis, publicación)
      - Servicio de Helpdesk (responder preguntas, guiar en uso de la app)
      - Bienvenida (presentar el servicio y sus funcionalidades)

      Directrices: Responde en español, tono profesional y conciso, prioriza seguridad.`,
    };

    this.models = {
      standard: { id: "gpt-4o-mini", maxTokens: 1024, temperature: 0.7 },
      advanced: { id: "gpt-4-turbo", maxTokens: 2048, temperature: 0.5 },
      vision: {
        id: "gpt-4o-realtime-preview",
        maxTokens: 1024,
        temperature: 0.4,
      },
    };
  }

  // ─── Consulta principal ──────────────────────────────────────────────────────

  /**
   * Envía consulta al modelo de IA
   * @param messages - Array de mensajes a procesar
   * @param options  - Opciones de configuración
   * @returns Respuesta de IA y metadatos
   */
  async query(
    messages: any[],
    options: any = {},
  ): Promise<{ content: string; model: string; usage: any }> {
    try {
      // Seleccionar modelo basado en complejidad y tipo de contenido
      const modelConfig = this._selectModel(options);

      // Añadir prompt del sistema si no está ya incluido
      const processedMessages = this._prepareMessages(messages, options);

      // Realizar petición a la API
      const { data } = await axios.post(
        this.config.endpoint,
        {
          model: modelConfig.id,
          messages: processedMessages,
          temperature: options.temperature ?? modelConfig.temperature,
          max_tokens: options.maxTokens ?? modelConfig.maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
        },
      );

      // Extraer respuesta
      const response = data.choices[0].message.content;
      this.logger.log(
        response,
        `AIService: Respuesta obtenida del modelo ${modelConfig.id}`,
      );

      return {
        content: response,
        model: modelConfig.id,
        usage: data.usage || null,
      };
    } catch (error: any) {
      this.logger.error(
        `Error OpenAI: ${error.response?.data?.error?.message ?? error.message}`,
      );
      throw new Error(
        `Error OpenAI: ${error.response?.data?.error?.message ?? error.message}`,
      );
    }
  }

  // ─── Procesamiento de archivos ───────────────────────────────────────────────

  /**
   * Procesa contenido de archivo con el modelo de IA apropiado
   * @param file    - Información del archivo (contenido, tipo, metadata)
   * @param options - Opciones de procesamiento
   * @returns Resultados del análisis
   */
  async processFile(
    file: any,
    options: any = {},
  ): Promise<{ raw: string; parsed: any; model: string; usage: any }> {
    try {
      // Determinar modelo y prompt apropiados para el tipo de archivo
      const { model, prompt, maxTokens } = this._configureForFileType(
        file,
        options,
      );

      // Formatear solicitud según el tipo de archivo
      const requestData = this._createFileRequestData(
        file,
        model,
        prompt,
        options,
        maxTokens,
      );

      // Realizar petición a la API
      const { data } = await axios.post(this.config.endpoint, requestData, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      // Procesar y formatear respuesta
      const response = data.choices[0].message.content;
      const parsedData = await this._parseResponse(response, file.type);

      return {
        raw: response,
        parsed: parsedData,
        model: model,
        usage: data.usage || null,
      };
    } catch (error: any) {
      this.logger.error(`Error procesando archivo con IA: ${error.message}`);
      throw new Error(`Error OpenAI procesando archivo: ${error.message}`);
    }
  }

  // ─── Análisis de imágenes ────────────────────────────────────────────────────

  /**
   * Analiza imágenes usando el modelo vision
   * @param imageUrl - URL de la imagen o data URL
   * @param prompt   - Instrucciones para el análisis
   * @param options  - Opciones adicionales
   * @returns Análisis de la imagen
   */
  async analyzeImage(
    imageUrl: string,
    prompt: string,
    options: any = {},
  ): Promise<{ content: string; model: string; usage: any }> {
    try {
      // Validar URL de imagen
      if (!imageUrl) throw new Error("URL de imagen requerida");

      // Configuración para el modelo vision
      const modelConfig = this.models.vision;

      // Petición a la API
      const { data } = await axios.post(
        this.config.endpoint,
        {
          model: modelConfig.id,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt || "Describe detalladamente esta imagen",
                },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          max_tokens: options.maxTokens ?? modelConfig.maxTokens,
          temperature: options.temperature ?? modelConfig.temperature,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
        },
      );

      return {
        content: data.choices[0].message.content,
        model: modelConfig.id,
        usage: data.usage || null,
      };
    } catch (error: any) {
      this.logger.error(
        `Error analizando imagen: ${error.response?.data?.error?.message ?? error.message}`,
      );
      throw new Error(
        `Error OpenAI Vision: ${error.response?.data?.error?.message ?? error.message}`,
      );
    }
  }

  // ─── Detección de intenciones ────────────────────────────────────────────────

  /**
   * Detecta la intención del usuario a partir de un mensaje de texto.
   * Requerido por IntentProcessorService.
   * @param text         - Texto del mensaje
   * @param history      - Historial de conversación para contexto
   * @param currentState - Estado actual de la conversación
   * @returns Intención detectada como string
   */
  async detectIntent(
    text: string,
    history: any[],
    currentState: string,
  ): Promise<string> {
    const intentList = [
      "welcome",
      "register_user",
      "create_incident",
      "list_incidents",
      "create_emergency",
      "create_knowledge",
      "approve_knowledge",
      "update_knowledge",
      "knowledge_query",
      "knowledge_search",
      "process_media",
      "system_info",
      "help",
      "create_ticket", // ← NUEVO: abrir ticket de soporte TIC
      "manage_tickets", // ← NUEVO: panel TIS / gestionar tickets
      "list_my_tickets", // ← NUEVO: consultar tickets del funcionario
      "free_text",
    ];

    try {
      const messages = [
        {
          role: "system",
          content: `Eres un clasificador de intenciones para el asistente municipal "Esmeraldas La Bella".
          Analiza el mensaje del usuario y devuelve ÚNICAMENTE el nombre de la intención detectada (sin explicaciones, sin comillas).
          
          Intenciones disponibles:
          - welcome: Bienvenido al asistente virtual de Esmeraldas
          - register_user: El usuario quiere registrarse como ciudadano
          - create_incident: El usuario quiere reportar un incidente o problema en la ciudad
          - list_incidents: El usuario quiere ver sus incidentes anteriores
          - create_emergency: El usuario reporta una emergencia urgente
          - create_knowledge: El usuario quiere agregar información/documento a la base de conocimiento
          - approve_knowledge: El usuario quiere aprobar un documento pendiente
          - update_knowledge: El usuario quiere actualizar información existente
          - knowledge_query: El usuario hace una pregunta sobre información municipal
          - knowledge_search: El usuario busca información específica en la base de conocimiento
          - process_media: El usuario envía multimedia (imagen, audio, video, documento)
          - system_info: El usuario quiere información sobre el sistema
          - help: El usuario pide ayuda general
          - create_ticket: el usuario quiere abrir, crear o reportar un ticket de soporte técnico
          - manage_tickets: el usuario de TIS quiere ver tickets pendientes, resolver o gestionar tickets
          - list_my_tickets: el usuario quiere ver sus tickets, consultar el estado de sus solicitudes
          - free_text: No encaja en ninguna intención anterior
          
          Estado actual de la conversación: ${currentState}
          
          Responde ÚNICAMENTE con el nombre de la intención, nada más.`,
        },
        ...history.slice(-5),
        { role: "user", content: text || "" },
      ];

      const response = await this.query(messages, { temperature: 0.1 });
      const detectedIntent = response.content
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "");

      // Validar que la intención sea una de las conocidas
      if (intentList.includes(detectedIntent)) return detectedIntent;

      this.logger.warn(
        `Intención desconocida: "${detectedIntent}", usando free_text`,
      );
      return "free_text";
    } catch (error: any) {
      this.logger.error(`Error detectando intención: ${error.message}`);
      return "free_text";
    }
  }

  // ─── Helpers privados ────────────────────────────────────────────────────────

  /**
   * Parsea y extrae datos estructurados de la respuesta de IA
   * @param text     - Texto de respuesta
   * @param fileType - Tipo de archivo procesado
   * @returns Datos parseados o texto original
   */
  private async _parseResponse(text: string, fileType: string): Promise<any> {
    // Para tipos de datos estructurados, intentar extraer JSON
    if (["pdf", "csv", "excel", "spreadsheet"].includes(fileType)) {
      try {
        return this._extractJSON(text);
      } catch (error: any) {
        this.logger.warn(
          `No se pudo extraer JSON estructurado: ${error.message}`,
        );
        return text;
      }
    }
    return text;
  }

  /**
   * Extrae JSON del texto de respuesta o devuelve el JSON si ya está parseado
   * @param text - Texto con JSON o JSON ya parseado
   * @returns JSON extraído o null
   */
  _extractJSON(text: string | object): any {
    // Verificar si ya es un objeto JSON válido
    if (text && typeof text === "object" && Object.keys(text).length > 0)
      return text;

    if (typeof text === "string") {
      // Intento directo de parsear todo el texto
      try {
        return JSON.parse(text);
      } catch {
        // Buscar estructuras similares a JSON con regex
        const jsonRegex = /(\{[\s\S]*?\})/g;
        const matches: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = jsonRegex.exec(text)) !== null) {
          matches.push(match[0]);
        }

        // Probar cada coincidencia, primero las más largas
        matches.sort((a, b) => b.length - a.length);
        for (const m of matches) {
          try {
            const cleaned = m.replace(/[ --]/g, "").replace(/,\s*}/g, "}");
            const parsed = JSON.parse(cleaned);
            if (
              parsed &&
              typeof parsed === "object" &&
              Object.keys(parsed).length > 0
            )
              return parsed;
          } catch {
            /* continuar con la siguiente coincidencia */
          }
        }
      }
    }
    return null;
  }

  /**
   * Selecciona el modelo apropiado según el contenido y opciones
   * @param options - Opciones de solicitud
   * @returns Configuración del modelo seleccionado
   */
  private _selectModel(options: any): {
    id: string;
    maxTokens: number;
    temperature: number;
  } {
    // Si se proporciona un modelo explícito y es válido
    if (options.model && this.models[options.model])
      return this.models[options.model];
    // Para contenido de imagen
    if (options.contentType === "image") return this.models.vision;
    // Seleccionar según bandera de complejidad
    return options.complex ? this.models.advanced : this.models.standard;
  }

  /**
   * Prepara array de mensajes con prompt del sistema
   * @param messages - Mensajes del usuario
   * @param options  - Opciones de configuración
   * @returns Mensajes procesados
   */
  private _prepareMessages(messages: any[], options: any): any[] {
    // Verificar si ya hay un prompt del sistema incluido
    const hasSystemPrompt = messages.some((msg) => msg.role === "system");
    if (hasSystemPrompt) return messages;

    // Crear prompt de sistema personalizado si se especifica
    const systemPrompt = options.systemPrompt
      ? { role: "system", content: options.systemPrompt }
      : this.corePrompt;

    return [systemPrompt, ...messages];
  }

  /**
   * Configura parámetros de procesamiento según el tipo de archivo
   * @param file    - Información del archivo
   * @param options - Opciones del usuario
   * @returns Configuración para procesamiento de archivo
   */
  private _configureForFileType(
    file: any,
    options: any,
  ): { model: string; prompt: string; maxTokens: number } {
    let model = this.models.standard.id;
    let prompt =
      options.prompt ||
      "Analiza este contenido y extrae información relevante.";
    let maxTokens = options.maxTokens || this.models.standard.maxTokens;

    // Seleccionar modelo y personalizar prompt según tipo de archivo
    switch (file.type) {
      case "pdf":
        model = this.models.advanced.id;
        prompt = options.prompt || "Extrae datos estructurados de este PDF.";
        maxTokens = 2048;
        break;
      case "csv":
      case "excel":
      case "spreadsheet":
        model = this.models.advanced.id;
        prompt =
          options.prompt ||
          "Analiza estos datos y proporciona un resumen estructurado.";
        maxTokens = 2048;
        break;
      case "image":
        model = this.models.vision.id;
        prompt = options.prompt || "Describe detalladamente esta imagen.";
        break;
      case "audio":
      case "video":
        prompt =
          options.prompt ||
          "Analiza esta transcripción y extrae los puntos clave.";
        break;
    }

    return { model, prompt, maxTokens };
  }

  /**
   * Crea datos de solicitud para procesamiento de archivos
   * @param file      - Información del archivo
   * @param model     - Modelo a usar
   * @param prompt    - Instrucción de procesamiento
   * @param options   - Opciones adicionales
   * @param maxTokens - Tokens máximos para respuesta
   * @returns Datos de solicitud para API
   */
  private _createFileRequestData(
    file: any,
    model: string,
    prompt: string,
    options: any,
    maxTokens: number,
  ): object {
    // Formato especial para análisis de imágenes
    if (model === this.models.vision.id && file.imageUrl) {
      return {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: file.imageUrl } },
            ],
          },
        ],
        max_tokens: maxTokens,
      };
    }

    // Formato estándar para archivos basados en texto
    return {
      model,
      messages: [
        {
          role: "system",
          content: options.systemPrompt || this.corePrompt.content,
        },
        { role: "user", content: `${prompt}\n\n${file.content}` },
      ],
      temperature: options.temperature || 0.3,
      max_tokens: maxTokens,
    };
  }

  /**
   * Genera respuesta basada en un prompt y mensajes de conversación
   * @param prompt - Instrucción principal o prompt del sistema
   * @param messages - Historial de mensajes de la conversación
   * @param options - Opciones de configuración (modelo, temperatura, etc.)
   * @returns Respuesta generada por la IA
   */
  async generateResponse(
    prompt: string,
    messages: any[],
    options: any = {},
  ): Promise<{ content: string; model: string; usage: any }> {
    try {
      // Determinar configuración del modelo basada en opciones
      const modelConfig = this._selectModel({
        model: options.model,
        contentType: options.contentType,
        complex: options.complex,
      });

      // Preparar mensajes con el prompt como system message si se especifica
      const systemMessage = prompt
        ? {
            role: "system",
            content: prompt,
          }
        : null;

      const processedMessages = systemMessage
        ? [systemMessage, ...messages]
        : messages;

      // Realizar petición a la API
      const { data } = await axios.post(
        this.config.endpoint,
        {
          model: modelConfig.id,
          messages: processedMessages,
          temperature: options.temperature ?? modelConfig.temperature,
          max_tokens: options.maxTokens ?? modelConfig.maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
        },
      );

      const response = data.choices[0].message.content;

      this.logger.log(
        `GenerateResponse: Respuesta generada con modelo ${modelConfig.id}`,
      );

      return {
        content: response,
        model: modelConfig.id,
        usage: data.usage || null,
      };
    } catch (error: any) {
      this.logger.error(
        `Error en generateResponse: ${error.response?.data?.error?.message ?? error.message}`,
      );
      throw new Error(
        `Error OpenAI: ${error.response?.data?.error?.message ?? error.message}`,
      );
    }
  }
}
