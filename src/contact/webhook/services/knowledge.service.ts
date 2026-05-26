import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import * as path from "path";
import {
  KNOWLEDGE_MODEL,
  KnowledgeDocument,
} from "../../../shared/schemas/knowledge.schema";
import { AiService } from "./ai.service";

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    @InjectModel(KNOWLEDGE_MODEL)
    private readonly knowledgeModel: Model<KnowledgeDocument>,
    private readonly aiService: AiService,
  ) {}

  async createProcessingRecord(
    filePath: string,
    userId: string,
    metadata: Record<string, any> = {},
  ): Promise<any> {
    try {
      const documentData = {
        topic: metadata.topic || "Documento en procesamiento",
        content: metadata.content || "",
        summary: metadata.summary || "",
        keywords: metadata.keywords || [],
        creator: userId,
        approved: false,
        isActive: true,
        source: "upload",
        fileUrl: filePath,
        originalFilename: metadata.fileName || path.basename(filePath),
        file: {
          path: filePath,
          type: metadata.fileType || "unknown",
          name: metadata.fileName || path.basename(filePath),
        },
        processingStatus: { status: "processing", startedAt: new Date() },
      };
      const newDocument = await this.create(documentData);
      this.logger.log(
        `✅ Document registered for processing: ${newDocument._id}`,
      );
      return newDocument;
    } catch (error) {
      this.logger.error(`❌ Error registering document: ${error}`);
      throw error;
    }
  }

  async updateDocument(
    documentId: string,
    updateData: Record<string, any>,
  ): Promise<any> {
    try {
      return await this.update(documentId, updateData);
    } catch (error) {
      this.logger.error(`❌ Error actualizando documento: ${error}`);
      throw error;
    }
  }

  async updateProcessingRecord(
    id: string,
    processedData: Record<string, any>,
    userId: string,
  ): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findById(id);
      if (!knowledge)
        throw new Error("Registro de procesamiento no encontrado");
      // Si hay contenido previo, guardarlo como versión anterior
      if (knowledge.content && knowledge.content !== processedData.content) {
        knowledge.previousVersions.push({
          content: knowledge.content,
          updatedBy: new Types.ObjectId(userId),
          updatedAt: new Date(),
        });
        knowledge.version += 1;
      }
      // Actualizar con los datos procesados
      knowledge.topic = processedData.topic || knowledge.topic;
      knowledge.content = processedData.content || knowledge.content;
      knowledge.keywords = processedData.keywords || knowledge.keywords;
      // Actualizar el estado de procesamiento
      knowledge.processingStatus = {
        status: "completed",
        completedAt: new Date(),
        progress: 100,
      };
      await knowledge.save();
      return knowledge;
    } catch (error) {
      this.logger.error("Error updating processing record:", error);
      throw error;
    }
  }

  async updateProcessingProgress(
    id: string,
    progress: number,
    statusMessage: string | null = null,
  ): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findByIdAndUpdate(
        id,
        {
          "processingStatus.progress": progress,
          "processingStatus.statusMessage": statusMessage,
          "processingStatus.updatedAt": new Date(),
        },
        { new: true },
      );
      if (!knowledge)
        throw new Error("Registro de procesamiento no encontrado");
      return knowledge;
    } catch (error) {
      this.logger.error("Error updating processing progress:", error);
      throw error;
    }
  }

  async findByFilePath(filePath: string): Promise<any> {
    try {
      const record = await this.knowledgeModel.findOne({ fileUrl: filePath });
      return record; // Retorna el registro o null si no existe
    } catch (error) {
      this.logger.error("Error finding record by file path:", error);
      throw error;
    }
  }

  private _determineDocumentType(filename: string): string {
    const extension = filename.split(".").pop()?.toLowerCase();
    if (!extension) return "other";

    if (extension === "pdf") return "pdf";
    if (["txt", "doc", "docx", "rtf", "md"].includes(extension)) return "text";
    return "other";
  }

  async create(knowledgeData: Record<string, any>): Promise<any> {
    try {
      const knowledge = new this.knowledgeModel(knowledgeData);
      await knowledge.save();
      return knowledge;
    } catch (error) {
      this.logger.error("Error creating knowledge:", error);
      throw error;
    }
  }

  async getById(id: string | undefined): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findById(id);
      if (!knowledge) throw new Error("Registro no encontrado");
      return knowledge;
    } catch (error) {
      this.logger.error("Error getting knowledge by ID:", error);
      throw error;
    }
  }

  async getAll(options: Record<string, any> = {}): Promise<any> {
    try {
      const {
        page = 1,
        limit = 10,
        filter = {},
        sort = { createdAt: -1 },
      } = options;
      const skip = (page - 1) * limit;
      const knowledgeList = await this.knowledgeModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit);
      const total = await this.knowledgeModel.countDocuments(filter);
      return {
        data: knowledgeList,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error("Error getting all knowledge:", error);
      throw error;
    }
  }

  async update(
    id: string,
    updateData: Record<string, any>,
    userId?: string,
  ): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findById(id);
      if (!knowledge) throw new Error("Registro no encontrado");
      // Guardar versión anterior si hay cambios en el contenido
      if (updateData.content && updateData.content !== knowledge.content) {
        knowledge.previousVersions.push({
          content: knowledge.content,
          updatedBy: new Types.ObjectId(userId),
          updatedAt: new Date(),
        });
        knowledge.version += 1;
      }
      // Actualizar campos
      Object.keys(updateData).forEach((key) => {
        knowledge[key] = updateData[key];
      });
      await knowledge.save();
      return knowledge;
    } catch (error) {
      this.logger.error("Error updating knowledge:", error);
      throw error;
    }
  }

  async delete(id: string): Promise<any> {
    try {
      const result = await this.knowledgeModel.findByIdAndUpdate(
        id,
        { isActive: false },
        { new: true },
      );
      if (!result) throw new Error("Registro no encontrado");
      return { success: true, message: "Registro eliminado correctamente" };
    } catch (error) {
      this.logger.error("Error deleting knowledge:", error);
      throw error;
    }
  }

  async hardDelete(id: string): Promise<any> {
    try {
      const result = await this.knowledgeModel.findByIdAndDelete(id);
      if (!result) throw new Error("Registro no encontrado");
      return { success: true, message: "Registro eliminado permanentemente" };
    } catch (error) {
      this.logger.error("Error hard deleting knowledge:", error);
      throw error;
    }
  }

  async approve(id: string, userId: string | undefined): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findByIdAndUpdate(
        id,
        { approved: true, approvedBy: userId },
        { new: true },
      );
      if (!knowledge) throw new Error("Registro no encontrado");
      return knowledge;
    } catch (error) {
      this.logger.error("Error approving knowledge:", error);
      throw error;
    }
  }

  async search(query: string, options: Record<string, any> = {}): Promise<any> {
    try {
      const {
        page = 1,
        limit = 10,
        onlyApproved = true,
        onlyActive = true,
        searchTerms = null,
        minMatchTerms = 1,
        matchPercentage = null,
        includeDrafts = false,
      } = options;

      const skip = (page - 1) * limit;

      // Si includeDrafts es true, ignorar onlyApproved
      const shouldFilterApproved = onlyApproved && !includeDrafts;

      // Manejar query undefined o vacía
      const normalizedQuery = query?.trim?.()?.toLowerCase() || "";

      let queryTerms: string[];
      if (searchTerms) {
        queryTerms = searchTerms
          .map((t: string) => t?.toLowerCase?.()?.trim?.() || "")
          .filter((t: string) => t.length > 2);
      } else if (normalizedQuery) {
        queryTerms = normalizedQuery
          .split(/\s+/)
          .filter((t: string) => t.length > 2);
      } else {
        queryTerms = [];
      }

      // Si no hay términos de búsqueda, devolver resultados según filtros
      if (queryTerms.length === 0) {
        // Construir filtro para búsqueda vacía
        const emptyFilter: Record<string, any> = {};
        if (shouldFilterApproved) emptyFilter.approved = true;
        if (onlyActive) emptyFilter.isActive = true;

        try {
          const emptyResults = await this.knowledgeModel
            .find(emptyFilter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

          const total = await this.knowledgeModel.countDocuments(emptyFilter);

          return {
            data: emptyResults,
            pagination: {
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            },
            searchInfo: {
              queryTerms: [],
              totalTerms: 0,
              minMatchTerms: 0,
              resultsBeforeFilter: total,
              resultsAfterFilter: total,
            },
          };
        } catch (error: any) {
          return {
            data: [],
            pagination: { total: 0, page, limit, totalPages: 0 },
            error: error.message,
          };
        }
      }

      // Calcular coincidencias requeridas
      let requiredMatches = minMatchTerms;
      if (matchPercentage !== null) {
        requiredMatches = Math.max(
          1,
          Math.ceil(queryTerms.length * matchPercentage),
        );
      }
      requiredMatches = Math.min(requiredMatches, queryTerms.length);

      // Construir filtro base
      const filter: Record<string, any> = {};
      if (shouldFilterApproved) filter.approved = true;
      if (onlyActive) filter.isActive = true;

      // Construir condiciones de búsqueda por términos
      const termConditions = queryTerms.map((term: string) => ({
        $or: [
          { topic: { $regex: term, $options: "i" } },
          { content: { $regex: term, $options: "i" } },
          { keywords: { $regex: term, $options: "i" } },
          { summary: { $regex: term, $options: "i" } },
        ],
      }));

      if (termConditions.length > 0) {
        filter.$or = termConditions.map((tc: any) => tc.$or).flat();
      }

      const projection = {
        topic: 1,
        content: 1,
        summary: 1,
        keywords: 1,
        documentType: 1,
        createdAt: 1,
        fileUrl: 1,
        originalFilename: 1,
        approved: 1, // Incluir approved para mostrar estado
        processingStatus: 1, // Incluir estado de procesamiento
      };

      let knowledgeList: any[] = [];
      try {
        knowledgeList = await this.knowledgeModel
          .find(filter)
          .select(projection)
          .lean();
      } catch (queryError: any) {
        this.logger.error(`Error en búsqueda MongoDB: ${queryError.message}`);
        return {
          data: [],
          pagination: { total: 0, page, limit, totalPages: 0 },
          error: queryError.message,
        };
      }

      // Mejorar resultados con puntuación de relevancia
      const enhancedResults = knowledgeList.map((doc: any) => {
        let relevanceScore = 0;
        const matchedTerms = new Set<string>();
        const matchDetails = {
          topic: [] as string[],
          content: [] as string[],
          keywords: [] as string[],
          summary: [] as string[],
        };

        for (const term of queryTerms) {
          let termMatched = false;
          const termLower = term.toLowerCase();

          if (doc.topic?.toLowerCase().includes(termLower)) {
            relevanceScore += 5;
            matchDetails.topic.push(term);
            termMatched = true;
          }

          if (
            doc.keywords?.some((kw: string) =>
              kw.toLowerCase().includes(termLower),
            )
          ) {
            relevanceScore += 3;
            matchDetails.keywords.push(term);
            termMatched = true;
          }

          if (doc.summary?.toLowerCase().includes(termLower)) {
            relevanceScore += 2;
            matchDetails.summary.push(term);
            termMatched = true;
          }

          if (doc.content) {
            const contentLower = doc.content.toLowerCase();
            let matches = 0;
            let pos = -1;
            while ((pos = contentLower.indexOf(termLower, pos + 1)) !== -1) {
              matches++;
              if (matches >= 10) break;
            }
            if (matches > 0) {
              relevanceScore += Math.min(matches * 0.5, 5);
              matchDetails.content.push(term);
              termMatched = true;
            }
          }

          if (termMatched) matchedTerms.add(term);
        }

        // Agregar metadatos adicionales para drafts
        const result: any = {
          ...doc,
          relevanceScore,
          matchedTermsCount: matchedTerms.size,
          matchedTerms: Array.from(matchedTerms),
          matchDetails,
          matchPercentage: (matchedTerms.size / queryTerms.length) * 100,
        };

        // Si includeDrafts es true, agregar información de estado
        if (includeDrafts) {
          result.isDraft = !doc.approved;
          result.processingStatus = doc.processingStatus;
        }

        return result;
      });

      // Filtrar por coincidencias requeridas
      let filteredResults = enhancedResults.filter(
        (doc: any) => doc.matchedTermsCount >= requiredMatches,
      );

      // Ordenar por relevancia
      filteredResults.sort((a: any, b: any) => {
        if (b.matchedTermsCount !== a.matchedTermsCount) {
          return b.matchedTermsCount - a.matchedTermsCount;
        }
        return b.relevanceScore - a.relevanceScore;
      });

      // Paginar resultados
      const paginatedResults = filteredResults.slice(skip, skip + limit);

      return {
        data: paginatedResults,
        pagination: {
          total: filteredResults.length,
          page,
          limit,
          totalPages: Math.ceil(filteredResults.length / limit),
        },
        searchInfo: {
          queryTerms,
          totalTerms: queryTerms.length,
          minMatchTerms: requiredMatches,
          resultsBeforeFilter: knowledgeList.length,
          resultsAfterFilter: filteredResults.length,
          includeDrafts, // Informar si se incluyeron borradores
        },
      };
    } catch (error: any) {
      this.logger.error(`Error buscando en knowledge: ${error.message}`);
      return {
        data: [],
        pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
        error: error.message,
      };
    }
  }

  async findSimilarDocuments(documentId: string, limit = 5): Promise<any[]> {
    try {
      const document = await this.knowledgeModel.findById(documentId);
      if (!document) throw new NotFoundException("Documento no encontrado");
      const keywords = document.keywords || [];
      const titleTerms = document.topic
        .toLowerCase()
        .split(/\s+/)
        .filter((term: string) => term.length > 3)
        .slice(0, 5);
      const searchTerms = [...new Set([...keywords, ...titleTerms])];
      if (searchTerms.length === 0) return [];
      const similarDocuments = await this.knowledgeModel
        .find({
          _id: { $ne: documentId },
          $or: [
            { keywords: { $in: searchTerms } },
            { topic: { $regex: searchTerms.join("|"), $options: "i" } },
          ],
          approved: true,
          isActive: true,
        })
        .select("topic summary content keywords createdAt")
        .limit(limit);
      const scoredResults = similarDocuments.map((doc: any) => {
        const docObj = doc.toObject();
        let similarityScore = 0;
        const commonKeywords = keywords.filter(
          (kw: string) => doc.keywords && doc.keywords.includes(kw),
        );
        similarityScore += commonKeywords.length * 2;
        titleTerms.forEach((term: string) => {
          if (doc.topic.toLowerCase().includes(term)) similarityScore += 1;
        });
        docObj.similarityScore = similarityScore;
        return docObj;
      });
      return scoredResults
        .sort((a: any, b: any) => b.similarityScore - a.similarityScore)
        .filter((doc: any) => doc.similarityScore > 0);
    } catch (error) {
      this.logger.error("Error buscando documentos similares:", error);
      throw error;
    }
  }

  extractKeywords(text: string, maxKeywords = 10): string[] {
    if (!text || typeof text !== "string") return [];
    const stopwords = [
      "a",
      "al",
      "algo",
      "algunas",
      "algunos",
      "ante",
      "antes",
      "como",
      "con",
      "contra",
      "cual",
      "cuando",
      "de",
      "del",
      "desde",
      "donde",
      "durante",
      "e",
      "el",
      "ella",
      "ellas",
      "ellos",
      "en",
      "entre",
      "era",
      "es",
      "esa",
      "esas",
      "ese",
      "eso",
      "esos",
      "esta",
      "este",
      "esto",
      "estos",
      "estoy",
      "fue",
      "ha",
      "han",
      "has",
      "hasta",
      "hay",
      "la",
      "las",
      "le",
      "les",
      "lo",
      "los",
      "me",
      "mi",
      "mis",
      "mucho",
      "muy",
      "más",
      "nada",
      "ni",
      "no",
      "nos",
      "nosotros",
      "nuestra",
      "nuestro",
      "o",
      "os",
      "otra",
      "otras",
      "otro",
      "otros",
      "para",
      "pero",
      "poco",
      "por",
      "porque",
      "que",
      "quien",
      "se",
      "si",
      "sido",
      "sin",
      "sobre",
      "son",
      "soy",
      "su",
      "sus",
      "también",
      "tanto",
      "te",
      "ti",
      "tiene",
      "tienen",
      "todo",
      "todos",
      "tu",
      "tus",
      "un",
      "una",
      "uno",
      "unos",
      "y",
      "ya",
      "yo",
    ];
    const normalizedText = text
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = normalizedText
      .split(" ")
      .filter(
        (word: string) =>
          word.length > 3 && !stopwords.includes(word) && !parseInt(word),
      );
    const wordFrequency: Record<string, number> = {};
    words.forEach((word: string) => {
      wordFrequency[word] = (wordFrequency[word] || 0) + 1;
    });
    const phrases: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      if (!stopwords.includes(words[i]) && !stopwords.includes(words[i + 1]))
        phrases.push(`${words[i]} ${words[i + 1]}`);
      if (
        i < words.length - 2 &&
        !stopwords.includes(words[i]) &&
        !stopwords.includes(words[i + 2])
      )
        phrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    const phraseFrequency: Record<string, number> = {};
    phrases.forEach((phrase: string) => {
      phraseFrequency[phrase] = (phraseFrequency[phrase] || 0) + 1;
    });
    const combined = [
      ...Object.entries(wordFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.floor(maxKeywords * 0.7))
        .map(([w]) => w),
      ...Object.entries(phraseFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.floor(maxKeywords * 0.3))
        .map(([p]) => p),
    ];
    return [...new Set(combined)].slice(0, maxKeywords);
  }

  async processDocumentWithAI(documentId: string): Promise<any> {
    try {
      const document = await this.knowledgeModel.findById(documentId);
      if (!document) throw new NotFoundException("Documento no encontrado");
      if (!this.aiService) {
        this.logger.warn(
          "Servicio de IA no disponible para procesamiento avanzado",
        );
        return document;
      }
      const contentForProcessing =
        document.content.length > 8000
          ? document.content.substring(0, 8000) + "..."
          : document.content;
      const messages = [
        {
          role: "system",
          content: `Eres un asistente especializado en procesamiento y organización de documentos municipales.\nAnaliza el documento y genera en formato JSON:\n{\n  "summary": "resumen de 2-3 párrafos",\n  "keywords": ["palabra1"],\n  "documentType": "tipo",\n  "importance": "alta|media|baja",\n  "suggestedTags": ["tag1"],\n  "relatedTopics": ["tema1"]\n}`,
        },
        {
          role: "user",
          content: `Título: ${document.topic}\n\nContenido:\n\n${contentForProcessing}`,
        },
      ];
      const response = await this.aiService.generateResponse(
        messages[1].content,
        [messages[0]],
      );
      let aiMetadata: any;
      try {
        aiMetadata =
          typeof response === "string" ? JSON.parse(response) : response;
      } catch {
        this.logger.error("Error al parsear respuesta de IA");
        return document;
      }
      const updateData: Record<string, any> = {};
      if (aiMetadata.summary) updateData.summary = aiMetadata.summary;
      if (Array.isArray(aiMetadata.keywords))
        updateData.keywords = [
          ...new Set([...(document.keywords || []), ...aiMetadata.keywords]),
        ];
      if (aiMetadata.documentType)
        updateData.aiClassification = aiMetadata.documentType;
      if (
        aiMetadata.importance ||
        aiMetadata.suggestedTags ||
        aiMetadata.relatedTopics
      ) {
        updateData.aiMetadata = {
          importance: aiMetadata.importance,
          suggestedTags: aiMetadata.suggestedTags,
          relatedTopics: aiMetadata.relatedTopics,
          processedAt: new Date(),
        };
      }
      const updatedDoc = await this.knowledgeModel.findByIdAndUpdate(
        documentId,
        { $set: updateData },
        { new: true },
      );
      this.logger.log(`Documento ${documentId} procesado con IA`);
      return updatedDoc;
    } catch (error) {
      this.logger.error("Error procesando documento con IA:", error);
      throw error;
    }
  }

  async generateAIResponse(
    query: string,
    documents: any | any[],
    options: Record<string, any> = {},
  ): Promise<string> {
    try {
      const { formatType = "text", includeSourceInfo = true } = options;
      if (!this.aiService) throw new Error("Servicio de IA no disponible");
      const docsArray = Array.isArray(documents) ? documents : [documents];
      if (docsArray.length === 0)
        return "No se encontró información relevante para responder a esta consulta.";
      let context = "";
      docsArray.forEach((doc: any, index: number) => {
        context += `Documento ${index + 1}:\nTítulo: ${doc.topic || "Sin título"}\n`;
        if (doc.summary) context += `Resumen: ${doc.summary}\n`;
        if (doc.content) context += `Contenido: ${doc.content}\n`;
        if (doc.keywords?.length)
          context += `Palabras clave: ${doc.keywords.join(", ")}\n`;
        context += "\n---\n\n";
      });
      let formatInstructions = "";
      if (formatType === "whatsapp")
        formatInstructions =
          "Formatea para WhatsApp: *negrita*, _cursiva_, ~tachado_, párrafos con líneas en blanco.";
      else if (formatType === "html")
        formatInstructions =
          "Formatea en HTML básico: <b>, <i>, <ul>, <li>, <h3>. Sin imágenes ni scripts.";
      const systemPrompt = `Eres el asistente virtual del Municipio de Esmeraldas.\nResponde consultas ciudadanas con precisión y claridad.\nINSTRUCCIONES:\n1. Usa ÚINICAMENTE la información del contexto.\n2. Si no está en el contexto, indica "No dispongo de información específica sobre..." y sugiere alternativas.\n3. NO inventes información ni procedimientos.\n4. Respuestas concisas de 2-4 párrafos máximo.\n${includeSourceInfo ? "5. Cita brevemente la fuente al final." : ""}\n${formatInstructions}`;
      const response = await this.aiService.generateResponse(
        `Consulta del ciudadano: "${query}"\n\nInformación disponible:\n\n${context}`,
        [{ role: "system", content: systemPrompt }],
      );
      return (
        response.content || "Lo siento, no pude generar una respuesta adecuada."
      );
    } catch (error) {
      this.logger.error("Error generando respuesta con IA:", error);
      return "Lo siento, ocurrió un error al procesar tu consulta. Por favor, intenta nuevamente o reformula tu pregunta.";
    }
  }

  async suggestRelatedQueries(
    query: string,
    results: any[] = [],
  ): Promise<string[]> {
    try {
      if (!this.aiService)
        return this._generateBasicRelatedQueries(query, results);
      let resultsContext =
        results?.length > 0
          ? "Resultados encontrados para la consulta original:\n" +
            results
              .slice(0, 3)
              .map(
                (r: any, i: number) =>
                  `${i + 1}. ${r.topic || "Sin título"}${r.keywords?.length ? "\n   Keywords: " + r.keywords.join(", ") : ""}`,
              )
              .join("\n")
          : "No se encontraron resultados para la consulta original.";
      const systemPrompt = `Eres un asistente especializado en sugerir consultas alternativas para búsquedas municipales.\nGenera 3-5 consultas alternativas breves (máximo 6-8 palabras), relacionadas con servicios municipales, diferentes entre sí.\nDevuelve solo JSON: {"suggestions": ["sugerencia 1", "sugerencia 2", "sugerencia 3"]}`;
      const response = await this.aiService.generateResponse(
        `Consulta original: "${query}"\n\n${resultsContext}`,
        [{ role: "system", content: systemPrompt }],
      );
      try {
        const parsed =
          typeof response === "string" ? JSON.parse(response) : response;
        if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0)
          return parsed.suggestions.slice(0, 5);
      } catch {
        this.logger.error("Error al procesar sugerencias de IA");
      }
      return this._generateBasicRelatedQueries(query, results);
    } catch (error) {
      this.logger.error("Error generando consultas relacionadas:", error);
      return [];
    }
  }

  private _generateBasicRelatedQueries(
    query: string,
    results: any[] = [],
  ): string[] {
    const keywords = new Set<string>();
    if (results?.length > 0)
      results.forEach((result: any) => {
        result.keywords?.forEach((kw: string) => keywords.add(kw));
      });
    if (keywords.size === 0) {
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length > 3)
        .forEach((t: string) => keywords.add(t));
      if (query.includes("trámite") || query.includes("tramite")) {
        keywords.add("requisitos");
        keywords.add("documentos");
        keywords.add("pasos");
      }
      if (query.includes("impuesto") || query.includes("predial")) {
        keywords.add("pago");
        keywords.add("fecha");
        keywords.add("descuento");
      }
    }
    const keywordsArray = Array.from(keywords).slice(0, 5);
    const suggestions: string[] = [];
    if (
      !query.toLowerCase().startsWith("cómo") &&
      !query.toLowerCase().startsWith("como")
    )
      suggestions.push(`Cómo ${query.toLowerCase()}`);
    if (!query.toLowerCase().includes("requisito"))
      suggestions.push(`Requisitos para ${query.toLowerCase()}`);
    keywordsArray.forEach((keyword: string) => {
      if (!query.toLowerCase().includes(keyword))
        suggestions.push(`${query} ${keyword}`);
    });
    return suggestions.slice(0, 5);
  }

  // ─────────────────────────────────────────────────────────────
  // Grupo 8: advancedSearch · findByKeywords · getVersionHistory · restoreVersion · getPendingDocuments
  // ─────────────────────────────────────────────────────────────

  async advancedSearch(
    criteria: Record<string, any>,
    options: Record<string, any> = {},
  ): Promise<any> {
    try {
      const { page = 1, limit = 10, sort = { createdAt: -1 } } = options;
      const skip = (page - 1) * limit;
      const query: Record<string, any> = {};

      if (criteria.textSearch) query.$text = { $search: criteria.textSearch };
      if (criteria.topic)
        query.topic = { $regex: criteria.topic, $options: "i" };
      if (criteria.keywords?.length)
        query.keywords = { $in: criteria.keywords };
      if (criteria.documentType) query.documentType = criteria.documentType;
      if (criteria.creator) query.creator = criteria.creator;
      if (criteria.approved !== undefined) query.approved = criteria.approved;
      if (criteria.isActive !== undefined) query.isActive = criteria.isActive;

      if (criteria.createdFrom || criteria.createdTo) {
        query.createdAt = {};
        if (criteria.createdFrom)
          query.createdAt.$gte = new Date(criteria.createdFrom);
        if (criteria.createdTo)
          query.createdAt.$lte = new Date(criteria.createdTo);
      }

      const knowledgeList = await this.knowledgeModel
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit);
      const total = await this.knowledgeModel.countDocuments(query);

      return {
        data: knowledgeList,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error("Error en búsqueda avanzada:", error);
      throw error;
    }
  }

  async findByKeywords(
    keywords: string[],
    options: Record<string, any> = {},
  ): Promise<any> {
    try {
      const {
        page = 1,
        limit = 10,
        matchAll = false,
        onlyApproved = true,
        onlyActive = true,
      } = options;
      const skip = (page - 1) * limit;

      const filter: Record<string, any> = {};
      filter.keywords = matchAll ? { $all: keywords } : { $in: keywords };
      if (onlyApproved) filter.approved = true;
      if (onlyActive) filter.isActive = true;

      const knowledgeList = await this.knowledgeModel
        .find(filter)
        .skip(skip)
        .limit(limit);
      const total = await this.knowledgeModel.countDocuments(filter);

      return {
        data: knowledgeList,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error("Error buscando por keywords:", error);
      throw error;
    }
  }

  async getVersionHistory(id: string): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel
        .findById(id)
        .select("version previousVersions")
        .populate("previousVersions.updatedBy", "name email");

      if (!knowledge) throw new NotFoundException("Registro no encontrado");

      return {
        currentVersion: knowledge.version,
        versions: knowledge.previousVersions,
      };
    } catch (error) {
      this.logger.error("Error obteniendo historial de versiones:", error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // restoreVersion · getPendingDocuments pendientes
  // ─────────────────────────────────────────────────────────────

  async restoreVersion(
    id: string,
    versionIndex: number,
    userId: string,
  ): Promise<any> {
    try {
      const knowledge = await this.knowledgeModel.findById(id);
      if (!knowledge) throw new NotFoundException("Registro no encontrado");

      if (
        !knowledge.previousVersions ||
        !knowledge.previousVersions[versionIndex]
      ) {
        throw new NotFoundException("Versión no encontrada");
      }

      // Guardar versión actual como versión anterior ANTES de restaurar
      knowledge.previousVersions.push({
        content: knowledge.content,
        updatedBy: userId as any,
        updatedAt: new Date(),
      });

      // Restaurar contenido de la versión antigua
      knowledge.content = knowledge.previousVersions[versionIndex].content;

      // Incrementar número de versión
      knowledge.version += 1;

      await knowledge.save();
      return knowledge;
    } catch (error) {
      this.logger.error("Error restaurando versión:", error);
      throw error;
    }
  }

  async getPendingDocuments(options: { all?: boolean } = {}): Promise<any[]> {
    try {
      const query = this.knowledgeModel
        .find({
          "processingStatus.status": "pending",
        })
        .sort({ createdAt: -1 });

      if (!options.all) {
        query.limit(5);
      }

      return query.exec();
    } catch (error) {
      this.logger.error("Error obteniendo documentos pendientes:", error);
      throw error;
    }
  }
}
