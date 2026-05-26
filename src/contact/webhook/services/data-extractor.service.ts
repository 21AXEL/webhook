/**
 * data-extractor.service.ts
 * Servicio de infraestructura para extraer datos estructurados de mensajes de WhatsApp
 * usando IA. Migrado desde DataExtractorService.js — ServiceLocator reemplazado por DI
 * de NestJS. Las utilidades de ExtractorMessage.js se incluyen como métodos privados.
 */
import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "./ai.service";
import {
  _extractLocationFromMessage,
  _extractMessageText,
} from "@shared/utils/extractor-message";

@Injectable()
export class DataExtractorService {
  private readonly logger = new Logger(DataExtractorService.name);

  constructor(private readonly aiService: AiService) {}

  // ─── Extracción de datos ─────────────────────────────────────────────────────

  /**
   * Extrae datos de usuario de un mensaje
   * @param message      - Mensaje del usuario
   * @param conversation - Objeto de conversación
   * @returns Datos de usuario extraídos y validados
   */
  async extractUserData(message: any, conversation: any): Promise<any> {
    const messageText =
      typeof message === "string" ? message : _extractMessageText(message);
    const MAX_RETRIES = 3;
    let attempts = 0;

    const prompt = {
      role: "system",
      content: `Extrae y valida la siguiente información del mensaje:
      - Nombre: name
      - Apellido: lastName 
      - DNI (Cédula): dni
      - Fecha de Expedición: date_expedition
      - Email: email
      - Teléfono: telf
      
      Aplica las siguientes validaciones:
      - DNI: 10 dígitos
      - Email: formato válido
      - Teléfono: 10 a 13 dígitos
      - Fecha de Expedición: Formato DD/MM/AAAA (/^\\d{2}\\/\\d{2}\\/\\d{4}$/) de ser necesario transformarlo a este formato

      -Recuerda, el DNI debe ser distinto al Teléfono. 
      -Si no recibes el dato del Teléfono o no lo menciona directamente, el número de teléfono es: ${conversation.senderId}
      
      Responde en formato JSON con la estructura: 
      {
        "name": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "last_name": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "dni": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "date_expedition": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "email": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "telf": {
          "value": "valor extraído",
          "isValid": true/false
        },
        "response": { 
          "text": "",
        }
      }
      
      Para el campo "response", genera un mensaje adecuado dependiendo de la validación:
      
      1. Si todos los campos son válidos:
        - text: "¡Gracias! Hemos verificado todos tus datos correctamente. Ahora podemos continuar con tu reporte."
      
      2. Si faltan campos o hay campos inválidos:
        - text: Un mensaje amable pidiendo los datos específicos faltantes o inválidos. Ejemplo: "Por favor, necesito que me proporciones un [campo] válido para continuar."
      `,
    };

    while (attempts < MAX_RETRIES) {
      try {
        const response = await this.aiService.query([
          prompt,
          { role: "user", content: messageText },
        ]);

        let parsedData: any;

        // Intentar extraer JSON de la respuesta
        try {
          if (typeof response.content === "string") {
            parsedData = JSON.parse(response.content);
          } else {
            parsedData = response.content;
          }
          return parsedData;
        } catch (parseError) {
          // Intentar extraer JSON con regex
          const jsonMatch = response.content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedData = JSON.parse(jsonMatch[0]);
            return parsedData;
          }
        }

        attempts++;
      } catch (error: any) {
        attempts++;
        this.logger.error(`Error en intento ${attempts}: ${error.message}`);
      }
    }

    throw new Error(
      "No se pudo obtener una respuesta JSON válida después de varios intentos",
    );
  }

  /**
   * Extrae datos de incidente de un mensaje
   * @param message         - Mensaje del usuario
   * @param conversation    - Objeto de conversación
   * @param incidentService - Servicio de incidentes para obtener categorías
   * @returns Datos de incidente extraídos o null si no hay suficiente información
   */
  async extractIncidentData(
    message: any,
    conversation: any,
    incidentService: any,
  ): Promise<any> {
    try {
      // Extraer texto del mensaje según su tipo
      const messageText =
        typeof message === "string" ? message : _extractMessageText(message);

      if (!messageText || messageText.trim().length < 15) {
        this.logger.log("Mensaje demasiado corto para extracción IA");
        return null; // Mensaje demasiado corto para análisis
      }

      // Obtener categorías para análisis
      const subcategorias =
        await incidentService.getCategoriesWithSubcategories();

      const MAX_RETRIES = 3;
      let attempts = 0;

      const prompt = {
        role: "system",
        content: `Basándote en el siguiente catálogo de categorías y subcategorías:
      ${JSON.stringify(subcategorias, null, 2)}

      PRIMERO, analiza si el mensaje contiene suficiente información para identificar un incidente concreto. 

      Responde SIEMPRE con un objeto JSON que contenga todos estos campos:

      {
        "category_id": "ID de la categoría que mejor coincida (vacío si datos insuficientes)",
        "subcategory_id": "ID de la subcategoría que mejor coincida (vacío si datos insuficientes)",
        "category": "Nombre de la categoría identificada (vacío si datos insuficientes)",
        "subcategory": "Nombre de la subcategoría identificada (vacío si datos insuficientes)",
        "description": "Descripción detallada del incidente (vacío si datos insuficientes)",
        "location": {
          "nombre": "Ubicación o referencia textual del lugar (puede ser aproximada o genérica)"
        },
        "priority": "Nivel de urgencia (vacío si datos insuficientes): [\"high\", \"medium\", \"low\"]",
        "response": {
          "message": "Si es una pregunta sobre el proceso: 'Gracias por contactarnos. Para reportar un incidente, por favor comparta los detalles del evento (qué ocurrió), la ubicación y cuándo sucedió. Estamos aquí para ayudarle.' Si datos insuficientes para un incidente específico: 'Entiendo que desea reportar un incidente. Para proceder, necesitaría algunos detalles adicionales como: descripción del problema y cuándo ocurrió. ¿Podría proporcionarnos esta información?'",
          "next_state": "Si datos insuficientes: 'collecting_info', si hay datos suficientes: 'incident_confirmed'",
          "insufficient_data": false
        }
      }

      IMPORTANTE: 
      - Si puedes identificar claramente la categoría, subcategoría y tienes una descripción del incidente, considera que hay datos suficientes y establece "insufficient_data" como false, incluso si falta información precisa sobre la ubicación o timestamp.
      - La ubicación exacta (coordenadas) se recogerá en otro paso, así que no consideres la falta de coordenadas como datos insuficientes.
      - El campo "response.insufficient_data" debe ser un valor booleano (true o false), NO un string entre comillas.
      - Si hay suficiente información para identificar el tipo de incidente y su descripción básica, establece "insufficient_data" como false y "next_state" como "incident_confirmed".
      - El mensaje de respuesta debe ser siempre amable, formal y orientado al servicio, adaptado al tipo de consulta del usuario.
      - Si el usuario simplemente pregunta cómo reportar un incidente, proporciona instrucciones claras en lugar de solicitar información.

      Asegúrate de que la respuesta sea ESTRICTAMENTE UN OBJETO JSON válido sin texto adicional, explicaciones o comillas de código alrededor.`,
      };

      while (attempts < MAX_RETRIES) {
        try {
          const response = await this.aiService.query(
            [prompt, { role: "user", content: messageText }],
            { temperature: 0.3, responseFormat: "json" },
          );

          let parsedData: any;
          try {
            // Intentar extraer JSON de la respuesta
            if (typeof response.content === "string") {
              parsedData = JSON.parse(response.content);
            } else {
              parsedData = response.content;
            }
          } catch (parseError: any) {
            this.logger.error(
              `Error parseando respuesta de IA: ${parseError.message}`,
            );
            // Intentar extraer JSON con regex
            const jsonMatch = response.content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsedData = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error("No se pudo extraer JSON de la respuesta");
            }
          }

          this.logger.log(
            `Intento de extraer información del incidente: ${JSON.stringify(parsedData)}`,
          );

          // Verificar si tenemos datos de insuficiencia
          if (parsedData && parsedData.response?.insufficient_data === true) {
            return parsedData; // Retornar directamente para solicitar más información
          }

          // Verificar si tenemos los datos esenciales de un incidente real
          if (
            parsedData &&
            (parsedData.category_id || parsedData.description)
          ) {
            // Verificar datos existentes de la conversación
            const tempData = conversation.tempIncidentData || {};

            // Si hay una ubicación en el mensaje, extraerla e incluirla
            if (message.type === "location") {
              const locationData = _extractLocationFromMessage(message);
              tempData.location = { ...tempData.location, ...locationData };
            }

            // Combinar datos extraídos con datos existentes
            return { ...tempData, ...parsedData };
          }

          attempts++;
        } catch (error: any) {
          attempts++;
          this.logger.error(`Error en intento ${attempts}: ${error.message}`);
        }
      }

      this.logger.warn(
        "No se pudo obtener datos válidos del incidente después de varios intentos",
      );
      return null;
    } catch (error: any) {
      this.logger.error(`Error en extractIncidentData: ${error.message}`);
      return null;
    }
  }
}
