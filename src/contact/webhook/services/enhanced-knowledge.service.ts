// enhanced-knowledge.service.ts
import { Injectable, Logger } from "@nestjs/common";
import { KnowledgeService } from "./knowledge.service";
import { AiService } from "./ai.service";

interface ProcessedQuery {
  correctedQuery: string;
  normalizedQuery: string;
  entities: {
    departments: string[];
    services: string[];
    concepts: string[];
  };
  queryType: string;
  searchStrategy: {
    keyTerms: string[];
    filters: Record<string, any>;
    exactMatches: string[];
    regexPatterns: string[];
  };
  confidence: number;
}

interface EnhancedResult {
  extractedInfo?: any;
  [key: string]: any;
}

@Injectable()
export class EnhancedKnowledgeService {
  private readonly enhancedLogger = new Logger(EnhancedKnowledgeService.name);

  constructor(
    private readonly knowledgeService: KnowledgeService,
    private readonly aiService: AiService,
  ) {}

  /**
   * Procesa una consulta de usuario con IA para mejorar la búsqueda
   */
  async processQueryWithAI(rawQuery: string): Promise<ProcessedQuery> {
    try {
      if (!this.aiService) {
        this.enhancedLogger.warn(
          "Servicio de IA no disponible, usando procesamiento básico",
        );
        return this._fallbackProcessQuery(rawQuery);
      }

      const messages = [
        {
          role: "system",
          content: `Eres un asistente especializado en procesamiento de consultas municipales.
          Tu tarea es analizar consultas ciudadanas, normalizarlas, extraer entidades relevantes y generar una estrategia de búsqueda óptima.
          
          IMPORTANTE: Debes manejar errores ortográficos comunes en español y términos específicos municipales.
          
          Genera tu respuesta en formato JSON con la siguiente estructura:
          {
            "correctedQuery": "consulta corregida",
            "normalizedQuery": "consulta normalizada sin acentos",
            "entities": {
              "departments": ["nombres de departamentos detectados"],
              "services": ["servicios mencionados"],
              "concepts": ["conceptos clave identificados"]
            },
            "queryType": "tipo de consulta (contact_info, service, service_info, procedure, regulation, etc.)",
            "searchStrategy": {
              "keyTerms": ["términos clave para búsqueda", "ordenados por relevancia"],
              "filters": {"campo": "valor"},
              "exactMatches": ["coincidencias exactas a buscar"],
              "regexPatterns": ["patrones regex sugeridos"]
            },
            "confidence": 0.95
          }`,
        },
        {
          role: "user",
          content: `Procesa esta consulta ciudadana: "${rawQuery}"`,
        },
      ];

      const response = await this.aiService.query(messages, {
        temperature: 0.2,
      });

      this.enhancedLogger.log(`Respuesta de IA recibida`);

      let processedQuery: ProcessedQuery;

      try {
        if (typeof response.content === "string") {
          processedQuery = JSON.parse(response.content);
        } else {
          processedQuery = response.content;
        }
      } catch (err: any) {
        this.enhancedLogger.warn(
          `Error al parsear JSON, intentando limpiar secuencias: ${err.message}`,
        );
        const fixed = response.content.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
        processedQuery = JSON.parse(fixed);
      }

      this.enhancedLogger.log(
        `✅ Consulta procesada con IA: "${rawQuery}" → "${processedQuery.correctedQuery}"`,
      );
      return processedQuery;
    } catch (error: any) {
      this.enhancedLogger.error(
        `Error en procesamiento con IA: ${error.message}`,
      );
      return this._fallbackProcessQuery(rawQuery);
    }
  }

  /**
   * Método de respaldo para procesar consultas cuando la IA no está disponible
   */
  private _fallbackProcessQuery(query: string): ProcessedQuery {
    const normalizedQuery = query
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    return {
      correctedQuery: query,
      normalizedQuery,
      entities: {
        departments: [],
        services: [],
        concepts: [],
      },
      queryType: "general",
      searchStrategy: {
        keyTerms: query
          .toLowerCase()
          .split(/\s+/)
          .filter((term) => term.length > 3),
        filters: {},
        exactMatches: [],
        regexPatterns: [],
      },
      confidence: 0.5,
    };
  }

  /**
   * Realiza búsqueda avanzada utilizando el procesamiento de IA
   */
  async searchWithAI(
    query: string,
    options: Record<string, any> = {},
  ): Promise<{
    originalQuery: string;
    processedQuery: ProcessedQuery;
    results: any[];
    directAnswers: any | null;
    pagination: any;
    metadata: {
      confidence: number;
      queryType: string;
    };
  }> {
    try {
      const processedQuery = await this.processQueryWithAI(query);
      const searchCriteria = this._buildSearchCriteria(processedQuery, options);

      // Usar el método search del padre
      const searchResults = await this.knowledgeService.search(
        processedQuery.normalizedQuery,
        {
          ...options,
          ...searchCriteria,
          matchPercentage: 0.5,
        },
      );

      const enhancedResults = await this._enhanceResults(
        searchResults.data,
        processedQuery,
      );

      let directAnswers = null;
      if (
        processedQuery.queryType === "contact_info" &&
        enhancedResults.length > 0
      ) {
        directAnswers = await this._extractDirectAnswers(
          enhancedResults,
          processedQuery,
        );
      }

      if (
        processedQuery.queryType === "service_info" &&
        enhancedResults.length > 0
      ) {
        directAnswers = await this._extractDirectAnswers(
          enhancedResults,
          processedQuery,
        );
      }

      return {
        originalQuery: query,
        processedQuery,
        results: enhancedResults,
        directAnswers,
        pagination: searchResults.pagination,
        metadata: {
          confidence: processedQuery.confidence,
          queryType: processedQuery.queryType,
        },
      };
    } catch (error: any) {
      this.enhancedLogger.error(`Error en búsqueda con IA: ${error.message}`);
      const fallbackResults = await this.knowledgeService.search(query, {
        ...options,
        matchPercentage: 0.5,
      });
      return {
        originalQuery: query,
        processedQuery: this._fallbackProcessQuery(query),
        results: fallbackResults.data,
        directAnswers: null,
        pagination: fallbackResults.pagination,
        metadata: {
          confidence: 0.5,
          queryType: "general",
        },
      };
    }
  }

  /**
   * Construye criterios de búsqueda basados en el procesamiento de IA
   */
  private _buildSearchCriteria(
    processedQuery: ProcessedQuery,
    _options: Record<string, any>,
  ): Record<string, any> {
    const { searchStrategy, queryType, entities } = processedQuery;

    // Consultas de contacto
    if (queryType === "contact_info") {
      let searchTerms: string[] = [];

      if (entities.departments?.length > 0) {
        searchTerms.push(entities.departments[0]);
      }

      if (entities.services?.length > 0) {
        searchTerms.push(entities.services[0]);
      }

      if (searchTerms.length === 0 && searchStrategy.keyTerms?.length > 0) {
        searchTerms = searchStrategy.keyTerms.slice(0, 2);
      }

      return {
        searchTerms,
        fuzzySearch: false,
        exactMatch: false,
        simplifiedSearch: true,
        minMatchTerms: 1,
      };
    }

    // Consultas de servicios
    if (queryType === "service" || queryType === "service_info") {
      let searchTerms: string[] = [];

      if (entities.services?.length > 0) {
        searchTerms.push(...entities.services);
      }

      if (entities.concepts?.length > 0) {
        searchTerms.push(...entities.concepts);
      }

      // Términos específicos para recolección de basura
      if (
        searchTerms.some(
          (term) => term.includes("basura") || term.includes("recolección"),
        )
      ) {
        searchTerms.push("residuos", "desechos", "limpieza", "recoleccion");
      }

      if (searchTerms.length === 0 && searchStrategy.keyTerms?.length > 0) {
        searchTerms = searchStrategy.keyTerms;
      }

      const numTerminos = searchTerms.length;
      const minRequerido = numTerminos <= 3 ? 2 : Math.ceil(numTerminos * 0.4);

      this.enhancedLogger.log(
        `🔍 Términos de búsqueda para servicio: ${searchTerms.join(", ")}`,
      );

      return {
        searchTerms,
        fuzzySearch: false,
        exactMatch: false,
        simplifiedSearch: false,
        onlyApproved: true,
        onlyActive: true,
        minMatchTerms: minRequerido,
      };
    }

    return {};
  }

  /**
   * Mejora los resultados basados en el contexto de la consulta
   */
  private async _enhanceResults(
    results: any[],
    processedQuery: ProcessedQuery,
  ): Promise<EnhancedResult[]> {
    if (!results?.length) return [];

    return results.map((result) => {
      const enhancedResult: EnhancedResult = {
        ...(result.toObject?.() || result),
      };

      if (
        processedQuery.queryType === "contact_info" &&
        processedQuery.entities.departments?.length
      ) {
        enhancedResult.extractedInfo = this._extractContactInfo(
          result.content,
          processedQuery.entities.departments[0],
        );
      } else if (processedQuery.queryType === "service_info") {
        enhancedResult.extractedInfo = this._extractServiceInfo(
          result.content,
          processedQuery,
        );
      }

      return enhancedResult;
    });
  }

  /**
   * Extrae información específica de servicios del contenido
   */
  private _extractServiceInfo(
    content: string,
    processedQuery: ProcessedQuery,
  ): any {
    if (!content) return null;

    const extractedInfo: any = {
      service: processedQuery.entities.services?.[0] || null,
      relevantSections: [],
      keyInformation: {},
    };

    const lines = content.split("\n");
    const scheduleKeywords = [
      "hora",
      "horario",
      "horarios",
      "recolección",
      "basura",
      "residuos",
    ];
    const dayKeywords = [
      "lunes",
      "martes",
      "miércoles",
      "jueves",
      "viernes",
      "sábado",
      "domingo",
      "diurnas",
      "nocturnas",
    ];

    lines.forEach((line) => {
      const lineLower = line.toLowerCase().trim();

      if (
        scheduleKeywords.some((kw) => lineLower.includes(kw)) ||
        dayKeywords.some((kw) => lineLower.includes(kw))
      ) {
        if (lineLower.includes("hora") && lineLower.includes("sector")) {
          extractedInfo.keyInformation.scheduleFormat = "tabla_horarios";
        }

        const timePattern = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
        const times = [...lineLower.matchAll(timePattern)];

        if (times.length > 0) {
          extractedInfo.relevantSections.push(line.trim());

          const sectorPattern = /[A-Z][A-Za-záéíóúñ\s]+(?=\s*(?:\d|$))/;
          const sectorMatch = line.match(sectorPattern);
          if (sectorMatch) {
            extractedInfo.keyInformation.sectors =
              extractedInfo.keyInformation.sectors || [];
            extractedInfo.keyInformation.sectors.push({
              sector: sectorMatch[0].trim(),
              horarios: times.map((t) => `${t[1]} - ${t[2]}`),
            });
          }
        }
      }

      if (lineLower.includes("domingo") && lineLower.includes("recolección")) {
        extractedInfo.keyInformation.domingo = line.trim();
      }

      if (lineLower.includes("multa") || lineLower.includes("sancion")) {
        extractedInfo.keyInformation.sanciones =
          extractedInfo.keyInformation.sanciones || [];
        extractedInfo.keyInformation.sanciones.push(line.trim());
      }
    });

    return extractedInfo.relevantSections.length > 0 ? extractedInfo : null;
  }

  /**
   * Extrae información de contacto de un documento
   */
  private _extractContactInfo(content: string, departmentName: string): any {
    if (!content) return null;

    const conmutadorRegex = /conmutador[:\s]+(\d+)/i;
    const conmutadorMatch = content.match(conmutadorRegex);

    let extension: string | null = null;
    let lineaCompleta: string | null = null;

    const lines = content.split("\n");
    for (const line of lines) {
      if (line.toLowerCase().includes(departmentName.toLowerCase())) {
        const match = line.match(/(\d+)$/);
        if (match) {
          extension = match[1];
          lineaCompleta = line.trim();
          break;
        }
      }
    }

    if (conmutadorMatch?.[1] || extension) {
      return {
        conmutador: conmutadorMatch?.[1] || null,
        extension,
        departamento: departmentName,
        lineaCompleta,
      };
    }

    return null;
  }

  /**
   * Extrae respuestas directas para consultas muy específicas
   */
  private async _extractDirectAnswers(
    results: EnhancedResult[],
    processedQuery: ProcessedQuery,
  ): Promise<any | null> {
    // Consultas de contacto
    if (
      processedQuery.queryType === "contact_info" &&
      processedQuery.entities.departments?.length
    ) {
      const departmentName = processedQuery.entities.departments[0];

      for (const result of results) {
        if (
          result.extractedInfo?.conmutador &&
          result.extractedInfo?.extension
        ) {
          return {
            type: "contact_info",
            answer: `El número del conmutador es ${result.extractedInfo.conmutador} y la extensión de ${departmentName} es ${result.extractedInfo.extension}.`,
            source: result.topic,
            confidence: processedQuery.confidence,
            data: result.extractedInfo,
          };
        }
      }
    }

    // Consultas de servicios
    if (processedQuery.queryType === "service_info") {
      for (const result of results) {
        if (result.extractedInfo?.relevantSections) {
          const extracted = result.extractedInfo;

          if (extracted.service?.toLowerCase().includes("basura")) {
            let answer = `*Información sobre recolección de basura:*\n\n`;

            if (extracted.relevantSections.length > 0) {
              answer += `*Horarios de recolección:*\n`;
              extracted.relevantSections
                .slice(0, 3)
                .forEach((section: string) => {
                  answer += `${section}\n`;
                });
            }

            if (extracted.keyInformation.domingo) {
              answer += `\n${extracted.keyInformation.domingo}\n`;
            }

            if (extracted.keyInformation.sanciones) {
              answer += `\n*Importante:* ${extracted.keyInformation.sanciones[0]}`;
            }

            return {
              type: "service_info",
              answer,
              source: result.topic,
              confidence: processedQuery.confidence,
              data: extracted,
            };
          }
        }
      }
    }

    return null;
  }
}
