import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { AiService } from "../../services/ai.service";
import { _extractMessageText } from "@shared/utils/extractor-message";
import { FileTypes } from "@shared/utils/file-type";
import { EnhancedKnowledgeService } from "@contact/webhook/services/enhanced-knowledge.service";
import { KnowledgeService } from "@contact/webhook/services/knowledge.service";

@Injectable()
export class KnowledgeQueryUseCase {
  private readonly logger = new Logger(KnowledgeQueryUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
    private readonly knowledgeService: KnowledgeService,
    private readonly enhancedKnowledgeService: EnhancedKnowledgeService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      if (!conversation || !message) {
        throw new Error("Conversación o mensaje no válidos");
      }

      const conversationId = conversation._id;
      const senderId = conversation.senderId;
      const query = _extractMessageText(message);

      if (!query || query.trim().length < 3) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Para realizar una consulta, por favor envía una pregunta más específica (mínimo 3 caracteres).",
        );
        return {
          success: false,
          error: "Consulta demasiado corta",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "knowledge_query_processing",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "🔍 Estoy buscando información sobre tu consulta. Dame un momento...",
      );

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastSearch: query,
        status: "processing",
        timestamp: new Date(),
      });

      const searchResults = await this._searchKnowledge(query);

      await this.conversationService.updateKnowledgeData(conversationId, {
        searchResults: searchResults.results
          ? searchResults.results.map((r: any) => r._id)
          : [],
        totalResults: searchResults.results ? searchResults.results.length : 0,
        processedQuery: searchResults.processedQuery || null,
        status: "completed",
      });

      if (searchResults.directAnswers) {
        const directAnswer = searchResults.directAnswers.answer;

        await this.conversationService.updateConversationHistory(
          conversationId,
          directAnswer,
        );
        await this.whatsAppService.sendTextMessage(senderId, directAnswer);

        if (searchResults.directAnswers.source) {
          await this.whatsAppService.sendTextMessage(
            senderId,
            `*Fuente:* ${searchResults.directAnswers.source}`,
          );
        }

        await this.conversationService.updateState(
          conversationId,
          "initial",
          "knowledge_query_processing",
        );

        return {
          success: true,
          query,
          resultsCount: searchResults.results
            ? searchResults.results.length
            : 0,
          directAnswer: true,
          response: directAnswer,
        };
      }

      const response = await this._generateResponse(
        query,
        searchResults.results || [],
      );

      await this.conversationService.updateConversationHistory(
        conversationId,
        response,
      );
      await this.whatsAppService.sendTextMessage(senderId, response);

      if (searchResults.results && searchResults.results.length > 1) {
        await this._offerFollowupOptions(senderId, searchResults.results);
      } else if (!searchResults.results || searchResults.results.length === 0) {
        await this._offerGeneralSearch(senderId, query);
      }

      await this.conversationService.updateState(
        conversationId,
        "initial",
        "knowledge_query_processing",
      );

      return {
        success: true,
        query,
        resultsCount: searchResults.results ? searchResults.results.length : 0,
        response,
      };
    } catch (error) {
      this.logger.error("Error en KnowledgeQueryUseCase:", error);

      try {
        const friendlyMessage =
          "Lo siento, tuve un problema al procesar tu consulta. Por favor, intenta nuevamente o reformula tu pregunta.";

        if (conversation && conversation.senderId) {
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            friendlyMessage,
          );
        }

        if (conversation && conversation._id) {
          await this.conversationService.updateState(
            conversation._id,
            "initial",
            conversation.state,
          );
        }
      } catch (e) {
        this.logger.error("Error enviando mensaje de error:", e);
      }

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _searchKnowledge(query: string): Promise<any> {
    try {
      const results = await this.enhancedKnowledgeService.searchWithAI(query, {
        limit: 5,
        onlyApproved: true,
        onlyActive: true,
      });

      this.logger.log(`✅ Búsqueda completada para: "${query}"`);

      if (results && results.results) {
        this.logger.log(
          "📄 Documentos encontrados:",
          results.results.map((r: any) => ({
            id: r._id,
            topic: r.topic,
            hasContent: !!r.content,
            contentLength: r.content ? r.content.length : 0,
            keywords: r.keywords,
          })),
        );
      }

      return {
        results: results.results || [],
        processedQuery: results.processedQuery || null,
        directAnswers: results.directAnswers || null,
        pagination: results.pagination || {
          total: 0,
          page: 1,
          limit: 5,
          totalPages: 0,
        },
      };
    } catch (error) {
      this.logger.error("Error en búsqueda avanzada:", error);
      this.logger.log(
        "⚠️ Utilizando método de búsqueda tradicional como respaldo",
      );

      try {
        const fallbackResults = await this.knowledgeService.search(
          query.trim().toLowerCase(),
          {
            limit: 5,
            onlyApproved: true,
            onlyActive: true,
            fuzzySearch: false,
            simplifiedSearch: true,
            matchPercentage: 0.75,
          },
        );

        return {
          results: fallbackResults.data || [],
          pagination: fallbackResults.pagination || {
            total: 0,
            page: 1,
            limit: 5,
            totalPages: 0,
          },
        };
      } catch (fallbackError) {
        this.logger.error(
          "Error también en búsqueda de respaldo:",
          fallbackError,
        );
        return {
          results: [],
          pagination: { total: 0, page: 1, limit: 5, totalPages: 0 },
        };
      }
    }
  }

  private async _generateResponse(
    query: string,
    results: any[],
  ): Promise<string> {
    try {
      const faqResponse = await this._checkAndRespondToFAQ(query, results);
      if (faqResponse) {
        return faqResponse;
      }

      if (this.knowledgeService.generateAIResponse) {
        const aiResponse = await this.knowledgeService.generateAIResponse(
          query,
          results || [],
          {
            maxLength: 800,
            formatType: "whatsapp",
            includeSourceInfo: true,
            temperature: 0.4,
          },
        );

        if (aiResponse && aiResponse.length > 20) {
          return aiResponse;
        }
      }

      if (this.aiService) {
        try {
          let context = "";

          if (results && results.length > 0) {
            results.forEach((result, index) => {
              context += `Documento ${index + 1}:\n`;
              context += `Título: ${result.topic || "Sin título"}\n`;
              if (result.summary) context += `Resumen: ${result.summary}\n`;
              if (result.content) {
                const contentLimit = results.length > 2 ? 1000 : 3000;
                const contentToInclude =
                  result.content.length > contentLimit
                    ? result.content.substring(0, contentLimit) + "..."
                    : result.content;
                context += `Contenido: ${contentToInclude}\n`;
              }
              if (result.keywords && result.keywords.length > 0) {
                context += `Palabras clave: ${result.keywords.join(", ")}\n`;
              }
              if (result.extractedInfo) {
                context += `Información extraída: ${JSON.stringify(result.extractedInfo)}\n`;
              }
              context += "\n---\n\n";
            });
          } else {
            context =
              "No se encontraron documentos que coincidan exactamente con la consulta.";
          }

          const messages = [
            {
              role: "system",
              content: `Eres *CIOCE Asistente Virtual*, el asistente oficial del Municipio de Esmeraldas (Ecuador).
              Tu tarea es responder preguntas ciudadanas sobre trámites, servicios y recolección de residuos.

              📍 CONTEXTO LOCAL:
              - El municipio se encuentra en el *Edificio Municipal, Av. 9 de Octubre y Av. Simón Bolívar, frente al Banco Pichincha*.
              - Sitio web oficial: https://esmeraldas.gob.ec/
              - No hay recolección de basura los domingos.

              ⚙️ INSTRUCCIONES DE RESPUESTA:
              1. Usa la información del contexto y los resultados de búsqueda para elaborar la respuesta.
              2. Si el barrio no aparece en la lista, identifica el *sector geográfico más cercano* (Norte, Centro o Sur).
              3. En caso de duda, ofrece una *respuesta razonada y útil*, no digas "no tengo información".
              4. Si la pregunta es sobre *recolección de basura*:
                - Indica los *días* y *turno (diurno o nocturno)* de la ruta más cercana.
                - Recomienda sacar la basura *antes de las 7:00 a.m.* (diurno) o *7:00 p.m.* (nocturno).
                - Menciona que *no hay servicio los domingos*.
                - No inventes horas exactas.
              5. Si la pregunta es sobre *trámites o atención ciudadana*:
                - Menciona que generalmente se requiere *cédula de identidad*.
                - Si debe acudir personalmente, incluye la dirección municipal actual.
              6. Usa un tono cercano, directo y claro, como un funcionario municipal.
              7. Formatea siempre para WhatsApp:
                - *Asteriscos* → texto en negrita
                - _Guiones bajos_ → cursiva
                - Saltos de línea entre párrafos
                - Listas numeradas o con emojis para pasos o consejos

              💡 RECUERDA:
              - Nunca respondas "no sé".
              - Siempre da una orientación clara basada en la información más probable de Esmeraldas.
              - Mantén las respuestas entre 80 y 180 palabras.

              Fuentes sugeridas:
              - Guía de Rutas de Recolección de Residuos del Municipio de Esmeraldas
              - Página oficial: https://esmeraldas.gob.ec/
              - Trámites ciudadanos: https://tramites.esmeraldas.gob.ec/login.jsp
              - Consulta predial: https://consulta.esmeraldas.gob.ec/`,
            },
            {
              role: "user",
              content: `Consulta del ciudadano: "${query}"\n\nInformación disponible:\n\n${context}`,
            },
          ];

          const aiResponse = await this.aiService.query(messages, {
            temperature: 0.4,
            maxTokens: 800,
          });

          return aiResponse.content;
        } catch (error) {
          this.logger.error("Error generando respuesta con IA:", error);
        }
      }

      return this._generateImprovedBasicResponse(query, results);
    } catch (error) {
      this.logger.error("Error generando respuesta:", error);
      return this._generateImprovedBasicResponse(query, results);
    }
  }

  private async _checkAndRespondToFAQ(
    query: string,
    results: any[],
  ): Promise<string | null> {
    if (!results || results.length === 0) return null;

    const normalizedQuery = query.toLowerCase().trim();

    for (const document of results) {
      if (
        document.aiMetadata &&
        document.aiMetadata.faq &&
        Array.isArray(document.aiMetadata.faq)
      ) {
        for (const faqItem of document.aiMetadata.faq) {
          if (faqItem.question && faqItem.answer) {
            const normalizedQuestion = faqItem.question.toLowerCase().trim();

            if (this._isSimilarQuestion(normalizedQuery, normalizedQuestion)) {
              let response = `*${faqItem.question}*\n\n${faqItem.answer}`;
              response += `\n\n*Fuente:* ${document.topic || "Base de conocimiento municipal"}`;
              return response;
            }
          }
        }
      }
    }

    return null;
  }

  private _isSimilarQuestion(query1: string, query2: string): boolean {
    if (
      query1 === query2 ||
      query1.includes(query2) ||
      query2.includes(query1)
    ) {
      return true;
    }

    const words1 = query1.split(/\s+/).filter((w) => w.length > 3);
    const words2 = query2.split(/\s+/).filter((w) => w.length > 3);

    let commonWords = 0;
    words1.forEach((word) => {
      if (words2.includes(word)) commonWords++;
    });

    const totalUniqueWords = new Set([...words1, ...words2]).size;
    const similarity =
      totalUniqueWords > 0 ? commonWords / totalUniqueWords : 0;

    return similarity >= 0.6;
  }

  private _generateImprovedBasicResponse(
    query: string,
    results: any[],
  ): string {
    if (!results || results.length === 0) {
      return (
        `*Sobre tu consulta: "${query}"*\n\n` +
        `Para información sobre este tema, te recomendamos:\n\n` +
        `1. Visitar nuestras oficinas municipales en Plaza Cívica, Juan Montalvo y Av. Pedro Vicente Maldonado.\n\n` +
        `2. Consultar nuestra página web oficial: https://esmeraldas.gob.ec/\n\n` +
        `3. Llamar a nuestra línea de atención ciudadana para asistencia inmediata.\n\n` +
        `Para la mayoría de trámites, necesitarás tener a mano tu cédula de identidad y estar al día en tus obligaciones municipales.`
      );
    }

    const mostRelevant = results[0];
    let response = `*Sobre tu consulta: "${query}"*\n\n`;

    if (mostRelevant.summary) {
      response += mostRelevant.summary;
    } else if (mostRelevant.content) {
      let content = mostRelevant.content;
      const relevantSections = this._findRelevantSections(content, query);

      if (relevantSections) {
        content = relevantSections;
      } else if (content.length > 300) {
        const cutPoint = content.indexOf(".", 200);
        if (cutPoint > 0 && cutPoint < 400) {
          content = content.substring(0, cutPoint + 1);
        } else {
          content = content.substring(0, 300) + "...";
        }
      }

      response += content;
    }

    response += `\n\n*Fuente:* ${mostRelevant.topic || "Base de conocimiento municipal"}`;

    if (results.length > 1) {
      response +=
        "\n\nEncontré más información relacionada. Te enviaré opciones para ver más detalles.";
    }

    response += "\n\n¿Necesitas alguna aclaración adicional sobre este tema?";

    return response;
  }

  private _findRelevantSections(content: string, query: string): string | null {
    const normalizedQuery = query.toLowerCase();
    const queryTerms = normalizedQuery
      .split(/\s+/)
      .filter((term) => term.length > 3);

    if (queryTerms.length === 0) return null;

    const paragraphs = content.split(/\n\n+/);

    const scoredParagraphs = paragraphs.map((paragraph) => {
      const normalizedParagraph = paragraph.toLowerCase();
      let score = 0;

      queryTerms.forEach((term) => {
        if (normalizedParagraph.includes(term)) score += 2;
      });

      if (normalizedParagraph.includes(normalizedQuery)) score += 5;

      const keyIndicators = [
        "requisito",
        "procedimiento",
        "paso",
        "trámite",
        "costo",
        "horario",
        "documento",
      ];
      keyIndicators.forEach((indicator) => {
        if (normalizedParagraph.includes(indicator)) score += 1;
      });

      return { paragraph, score };
    });

    const relevantParagraphs = scoredParagraphs
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.paragraph);

    if (relevantParagraphs.length > 0) {
      return relevantParagraphs.slice(0, 2).join("\n\n");
    }

    return null;
  }

  private async _offerFollowupOptions(
    senderId: string,
    results: any[],
  ): Promise<void> {
    try {
      const limitedResults = results.slice(0, 3);

      const options = limitedResults.map((result, index) => ({
        id: `kquc_knowledge_result_${index}`,
        title: this._truncateTitle(result.topic || `Resultado ${index + 1}`),
        description: result.summary
          ? this._truncateText(result.summary, 60)
          : result.keywords && result.keywords.length > 0
            ? `Palabras clave: ${result.keywords.slice(0, 3).join(", ")}`
            : "Ver más información",
      }));

      await this.whatsAppService.sendListMessage(senderId, {
        bodyText:
          "Encontré varios resultados que podrían interesarte. ¿Sobre cuál te gustaría más información?",
        headerText: "Resultados relacionados",
        buttonText: "Ver resultados",
        sections: [
          {
            title: "Resultados de búsqueda",
            rows: options,
          },
        ],
      });
    } catch (error) {
      this.logger.error("Error ofreciendo opciones de seguimiento:", error);
    }
  }

  private async _offerGeneralSearch(
    senderId: string,
    query: string,
  ): Promise<void> {
    try {
      const queryKeywords = this._extractKeywordsFromQuery(query);

      if (queryKeywords.length > 0) {
        const relatedDocs = await this.knowledgeService.findByKeywords(
          queryKeywords,
          {
            limit: 3,
            onlyApproved: true,
          },
        );

        if (relatedDocs.data && relatedDocs.data.length > 0) {
          const options = relatedDocs.data.map((doc: any, index: number) => ({
            id: `kquc_related_doc_${index}`,
            title: this._truncateTitle(
              doc.topic || `Tema relacionado ${index + 1}`,
            ),
            description: doc.summary
              ? this._truncateText(doc.summary, 60)
              : "Información que podría interesarte",
          }));

          await this.whatsAppService.sendListMessage(senderId, {
            bodyText:
              "Encontré estos temas relacionados que podrían interesarte:",
            headerText: "Temas recomendados",
            buttonText: "Ver recomendaciones",
            sections: [
              {
                title: "Temas recomendados",
                rows: options,
              },
            ],
          });
          return;
        }
      }

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Más opciones de ayuda",
        bodyText:
          "Aunque no tengo información específica sobre tu consulta actual, puedo ayudarte de otras formas:",
        footerText: "Municipio de Esmeraldas a tu servicio",
        buttons: [
          { id: "kquc_search_general_yes", text: "Buscar en todas" },
          { id: "kquc_browse_categories", text: "Ver categorías" },
        ],
      });
    } catch (error) {
      this.logger.error("Error ofreciendo alternativas:", error);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Para asistencia más detallada sobre este tema, puedes visitar nuestras oficinas municipales o llamar a nuestra línea de atención al ciudadano.",
      );
    }
  }

  private _extractKeywordsFromQuery(query: string): string[] {
    if (!query) return [];

    const stopwords = [
      "el",
      "la",
      "los",
      "las",
      "un",
      "una",
      "unos",
      "unas",
      "y",
      "o",
      "a",
      "ante",
      "bajo",
      "con",
      "de",
      "desde",
      "en",
      "entre",
      "hacia",
      "hasta",
      "para",
      "por",
      "según",
      "sin",
      "sobre",
      "tras",
      "que",
      "como",
      "cuando",
      "donde",
      "cuyo",
      "quien",
      "quienes",
    ];

    const words = query
      .toLowerCase()
      .replace(/[^\wáéíóúüñ ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stopwords.includes(word));

    return [...new Set(words)].slice(0, 5);
  }

  private _truncateTitle(title: string, maxLength = 24): string {
    if (!title) return "Sin título";
    if (title.length <= maxLength) return title;

    const cutPoint = title.lastIndexOf(" ", maxLength - 3);
    if (cutPoint > maxLength * 0.6) {
      return title.substring(0, cutPoint) + "...";
    }
    return title.substring(0, maxLength - 3) + "...";
  }

  private _truncateText(text: string, maxLength = 100): string {
    if (!text) return "";
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  async processResultSelection(
    conversationId: string,
    resultIndex: any,
  ): Promise<any> {
    const conversation = await this.conversationService.getById(conversationId);

    try {
      if (
        typeof resultIndex === "string" &&
        resultIndex.startsWith("kquc_knowledge_result_")
      ) {
        resultIndex = parseInt(
          resultIndex.replace("kquc_knowledge_result_", ""),
          10,
        );
      }

      const senderId = conversation.senderId;
      const searchResultIds = conversation.knowledgeData?.searchResults || [];

      if (!searchResultIds.length || resultIndex >= searchResultIds.length) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, el resultado seleccionado ya no está disponible. Por favor, realiza una nueva consulta.",
        );
        return {
          success: false,
          error: "Resultado no encontrado",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "knowledge_result_processing",
        conversation.state,
      );

      const selectedResultId = searchResultIds[resultIndex];
      const selectedResult =
        await this.knowledgeService.getById(selectedResultId);

      if (!selectedResult) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no pude recuperar la información solicitada. Por favor, intenta con otra consulta.",
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          "knowledge_result_processing",
        );
        return {
          success: false,
          error: "No se pudo recuperar el resultado",
        };
      }

      let detailedResponse: string;

      if (this.aiService) {
        try {
          const messages = [
            {
              role: "system",
              content: `Eres el asistente virtual del Municipio de Esmeraldas.
              Debes presentar la información detallada del documento seleccionado.
              Usa ÚNICAMENTE la información proporcionada en el documento.
              Estructura la información de manera clara y organizada.
              Destaca puntos clave y resume el contenido extenso.
              Mantén un tono formal pero amigable.
              
              Formatea tu respuesta para WhatsApp:
              - Usa *asteriscos* para texto en negrita
              - Usa _guiones bajos_ para texto en cursiva
              - Separa párrafos con líneas en blanco
              - Usa listas numeradas para pasos o requisitos`,
            },
            {
              role: "user",
              content: `Documento seleccionado:
              Título: ${selectedResult.topic || "Sin título"}
              Contenido: ${selectedResult.content || ""}
              ${selectedResult.summary ? `Resumen: ${selectedResult.summary}` : ""}
              ${selectedResult.keywords && selectedResult.keywords.length > 0 ? `Palabras clave: ${selectedResult.keywords.join(", ")}` : ""}`,
            },
          ];

          const aiResponse = await this.aiService.query(messages, {
            temperature: 0.3,
            maxTokens: 1000,
          });
          detailedResponse = aiResponse.content;
        } catch (error) {
          this.logger.error(
            "Error generando respuesta detallada con IA:",
            error,
          );
          detailedResponse = this._generateDetailedResponse(selectedResult);
        }
      } else {
        detailedResponse = this._generateDetailedResponse(selectedResult);
      }

      await this.conversationService.updateConversationHistory(
        conversationId,
        detailedResponse,
      );
      await this.whatsAppService.sendTextMessage(senderId, detailedResponse);

      if (selectedResult.fileUrl) {
        await this._offerFileDownload(conversationId, senderId, selectedResult);
      } else {
        await this.conversationService.updateState(
          conversationId,
          "initial",
          "knowledge_result_processing",
        );
      }

      return {
        success: true,
        resultId: selectedResultId,
        response: detailedResponse,
      };
    } catch (error) {
      this.logger.error("Error procesando selección de resultado:", error);
      try {
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation?.state || "knowledge_result_processing",
        );
        if (conversation?.senderId) {
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            "Lo siento, ocurrió un problema al mostrar el resultado. Por favor, intenta nuevamente o reformula tu consulta.",
          );
        }
      } catch (e) {
        this.logger.error("Error adicional al manejar error:", e);
      }
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private _generateDetailedResponse(result: any): string {
    let detailedResponse = `*${result.topic || "Información detallada"}*\n\n`;

    if (result.content) {
      if (result.content.length > 1200) {
        const firstPart = result.content.substring(0, 1200);
        const lastParagraph = firstPart.lastIndexOf("\n\n");
        const cutPoint = lastParagraph > 800 ? lastParagraph : 1200;
        detailedResponse += result.content.substring(0, cutPoint) + "...\n\n";
        detailedResponse +=
          "Para consultar el documento completo, puedes visitar nuestras oficinas o el portal web municipal: https://esmeraldas.gob.ec/";
      } else {
        detailedResponse += result.content;
      }
    } else if (result.summary) {
      detailedResponse += result.summary;
    } else {
      detailedResponse +=
        "La información completa está disponible en nuestras oficinas municipales o a través del portal web.";
    }

    if (
      result.aiMetadata &&
      result.aiMetadata.requirements &&
      result.aiMetadata.requirements.length > 0
    ) {
      detailedResponse += "\n\n*Requisitos:*\n";
      result.aiMetadata.requirements.forEach((req: string, idx: number) => {
        detailedResponse += `${idx + 1}. ${req}\n`;
      });
    }

    if (result.keywords && result.keywords.length) {
      detailedResponse += `\n\n*Temas relacionados:* ${result.keywords.join(", ")}`;
    }

    detailedResponse +=
      "\n\n¿Necesitas alguna información adicional sobre este tema?";

    return detailedResponse;
  }

  private async _offerFileDownload(
    conversationId: string,
    senderId: string,
    result: any,
  ): Promise<void> {
    try {
      const fileType = FileTypes.getTypeFromExtension(
        result.originalFilename || "",
      );
      const fileTypeText =
        fileType !== "unknown"
          ? `Tipo: ${fileType.toUpperCase()}`
          : "Archivo adjunto";

      await this.conversationService.updateKnowledgeData(conversationId, {
        lastDocumentId: result._id,
      });
      await this.conversationService.updateState(
        conversationId,
        "knowledge_file_request",
        "knowledge_result_processing",
      );

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Documento Original",
        bodyText: `Este documento tiene un archivo adjunto. ¿Deseas recibir el archivo original?`,
        footerText: `${result.originalFilename || "Archivo"} - ${fileTypeText}`,
        buttons: [
          { id: "kquc_knowledge_file_yes", text: "Sí, enviar archivo" },
          { id: "kquc_knowledge_file_no", text: "No, gracias" },
        ],
      });
    } catch (error) {
      this.logger.error("Error ofreciendo descarga de archivo:", error);
      await this.conversationService.updateState(
        conversationId,
        "initial",
        "knowledge_result_processing",
      );
    }
  }

  async processFileRequest(
    conversationId: string,
    response: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      const wantsFile =
        response === "yes" ||
        response === "knowledge_file_yes" ||
        response === "kquc_knowledge_file_yes";

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );

      if (!wantsFile) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "De acuerdo. ¿Hay algo más en lo que pueda ayudarte?",
        );
        return {
          success: true,
          message: "Solicitud de archivo rechazada",
        };
      }

      const documentId = conversation.knowledgeData?.lastDocumentId;

      if (!documentId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, no se pudo encontrar el archivo solicitado.",
        );
        return {
          success: false,
          message: "Referencia de documento no encontrada",
        };
      }

      const document = await this.knowledgeService.getById(documentId);

      if (!document || !document.fileUrl) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, el archivo original no está disponible.",
        );
        return {
          success: false,
          message: "Archivo no disponible",
        };
      }

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Enviando el archivo solicitado...",
      );
      await this.whatsAppService.sendFileMessage(
        senderId,
        document.fileUrl,
        document.originalFilename || document.topic || "Archivo del Municipio",
      );
      await this.conversationService.updateConversationHistory(
        conversationId,
        `Archivo enviado: ${document.originalFilename || document.topic}`,
      );

      return {
        success: true,
        message: "Archivo enviado",
        fileUrl: document.fileUrl,
      };
    } catch (error) {
      this.logger.error("Error procesando solicitud de archivo:", error);
      try {
        const conversation =
          await this.conversationService.getById(conversationId);
        if (conversation?.senderId) {
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            "Lo siento, hubo un problema al enviar el archivo. Por favor, intenta nuevamente más tarde.",
          );
        }
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation?.state || "",
        );
      } catch (e) {
        this.logger.error("Error adicional al manejar error:", e);
      }
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async startGeneralSearch(
    conversationId: string,
    query: string,
  ): Promise<any> {
    try {
      if (
        query &&
        typeof query === "string" &&
        query === "kquc_search_general_yes"
      ) {
        const conversation =
          await this.conversationService.getById(conversationId);
        if (conversation?.knowledgeData?.lastSearch) {
          query = conversation.knowledgeData.lastSearch;
        }
      }

      const knowledgeSearchUseCase = {} as any;

      if (!knowledgeSearchUseCase) {
        throw new Error("KnowledgeSearchUseCase no disponible");
      }

      await this.conversationService.updateKnowledgeData(conversationId, {
        originalQuery: query,
      });
      return await knowledgeSearchUseCase.execute(conversationId);
    } catch (error) {
      this.logger.error("Error iniciando búsqueda general:", error);
      try {
        const conversation =
          await this.conversationService.getById(conversationId);
        if (conversation?.senderId) {
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            "Lo siento, no pude iniciar la búsqueda general. Puedes intentar con otra consulta específica.",
          );
        }
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation?.state || "",
        );
      } catch (e) {
        this.logger.error("Error adicional al manejar error:", e);
      }
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processCategorySelection(
    conversationId: string,
    categoryId: string,
  ): Promise<any> {
    try {
      if (
        categoryId &&
        typeof categoryId === "string" &&
        categoryId.startsWith("kquc_")
      ) {
        categoryId = categoryId.replace("kquc_", "");
      }

      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      const categories: Record<string, { name: string; keywords: string[] }> = {
        cat_tramites: {
          name: "Trámites municipales",
          keywords: ["trámite", "documento", "certificado", "permiso"],
        },
        cat_impuestos: {
          name: "Impuestos y pagos",
          keywords: ["impuesto", "predial", "pago", "tributo"],
        },
        cat_servicios: {
          name: "Servicios públicos",
          keywords: ["servicio", "agua", "basura", "alumbrado"],
        },
        cat_turismo: {
          name: "Turismo y cultura",
          keywords: ["turismo", "cultura", "evento", "festival"],
        },
        browse_categories: {
          name: "Categorías principales",
          keywords: ["trámite", "impuesto", "servicio", "turismo"],
        },
      };

      const selectedCategory = categories[categoryId];

      if (!selectedCategory) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Categoría no encontrada. Por favor, selecciona una de las opciones disponibles.",
        );
        return { success: false, error: "Categoría no válida" };
      }

      if (categoryId === "browse_categories") {
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Categorías principales",
          bodyText: "Selecciona una categoría para ver información:",
          footerText: "Municipio de Esmeraldas a tu servicio",
          buttons: [
            { id: "kquc_cat_tramites", text: "Trámites municipales" },
            { id: "kquc_cat_impuestos", text: "Impuestos y pagos" },
            { id: "kquc_cat_servicios", text: "Servicios públicos" },
          ],
        });
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Más categorías",
          bodyText: "Otras categorías disponibles:",
          footerText: "Municipio de Esmeraldas a tu servicio",
          buttons: [
            { id: "kquc_cat_turismo", text: "Turismo y cultura" },
            { id: "kquc_back_to_menu", text: "Volver al menú principal" },
          ],
        });
        return { success: true, message: "Categorías mostradas" };
      }

      const results = await this.knowledgeService.findByKeywords(
        selectedCategory.keywords,
        {
          limit: 5,
          onlyApproved: true,
          matchAll: false,
        },
      );

      await this.conversationService.updateKnowledgeData(conversationId, {
        searchResults: results.data.map((r: any) => r._id),
        totalResults: results.data.length,
        lastCategory: categoryId,
        status: "completed",
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        `*${selectedCategory.name}*\n\nAquí encontrarás información sobre los principales temas relacionados con ${selectedCategory.name.toLowerCase()} en el Municipio de Esmeraldas.`,
      );

      if (results.data.length > 0) {
        await this._offerFollowupOptions(senderId, results.data);
      } else {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se encontraron documentos específicos para esta categoría. Te recomendamos visitar nuestra página web o acudir a nuestras oficinas para información detallada sobre ${selectedCategory.name.toLowerCase()}.`,
        );
      }

      return {
        success: true,
        message: "Categoría procesada",
        category: selectedCategory.name,
        resultsCount: results.data.length,
      };
    } catch (error) {
      this.logger.error("Error procesando selección de categoría:", error);
      return { success: false, error: (error as Error).message };
    }
  }
}
