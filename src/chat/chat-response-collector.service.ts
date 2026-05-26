/**
 * chat-response-collector.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Servicio que captura las respuestas del bot para sesiones web.
 *
 * Problema: WhatsAppService.sendTextMessage() envía directamente a Meta.
 * Para sesiones web necesitamos interceptar esas respuestas y devolverlas
 * al cliente HTTP en lugar de llamar a Meta.
 *
 * Solución: antes de procesar un mensaje web, se registra el sessionId aquí.
 * WhatsAppService consulta este servicio: si el senderId es una sesión web,
 * acumula la respuesta en lugar de llamar a Meta.
 * El ChatController espera hasta que se complete el procesamiento y lee los mensajes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable } from "@nestjs/common";

// Reemplazar la interfaz WebMessage existente:
export interface WebMessage {
  type: "text" | "buttons" | "list" | "flow";
  text?: string;
  buttons?: Array<{ id: string; text: string }>;
  listSections?: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>;
  quickReplies?: string[];
  // ── Flows ──────────────────────────────────────────────────────────────────
  flowId?: string;
  flowJson?: any; // JSON completo del flow (screens[])
  screenId?: string; // pantalla inicial
  screenData?: any; // datos dinámicos para esa pantalla
}

@Injectable()
export class ChatResponseCollector {
  /** sessionId → lista de mensajes acumulados en esta vuelta */
  private readonly sessions = new Map<string, WebMessage[]>();

  /** Registra una sesión web antes de procesar su mensaje */
  startSession(sessionId: string): void {
    this.sessions.set(sessionId, []);
  }

  /** Verifica si un senderId corresponde a una sesión web activa */
  isWebSession(senderId: string): boolean {
    return this.sessions.has(senderId);
  }

  /** Acumula un mensaje de texto para una sesión web */
  pushText(sessionId: string, text: string): void {
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    msgs.push({ type: "text", text });
  }

  /** Acumula un mensaje de botones para una sesión web */
  pushButtons(
    sessionId: string,
    text: string,
    buttons: Array<{ id: string; text: string }>,
  ): void {
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    msgs.push({
      type: "buttons",
      text,
      buttons,
      quickReplies: buttons.map((b) => b.text),
    });
  }

  /** Acumula un mensaje de lista para una sesión web */
  pushList(
    sessionId: string,
    text: string,
    sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
  ): void {
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    // Aplanar las filas de la lista como quickReplies para el widget
    const quickReplies = sections
      .flatMap((s) => s.rows)
      .slice(0, 3)
      .map((r) => r.title.substring(0, 25));
    msgs.push({ type: "list", text, listSections: sections, quickReplies });
  }

  /** Recupera y limpia los mensajes acumulados de una sesión */
  flushSession(sessionId: string): WebMessage[] {
    const msgs = this.sessions.get(sessionId) ?? [];
    this.sessions.delete(sessionId);
    return msgs;
  }

  // Agregar este método dentro de la clase ChatResponseCollector:

  /** Acumula un mensaje de tipo Flow para sesiones web */
  pushFlow(
    sessionId: string,
    flow: { flowId: string; screenId: string; bodyText: string },
  ): void {
    const msgs = this.sessions.get(sessionId);
    if (!msgs) return;
    msgs.push({
      type: "flow",
      text: flow.bodyText,
      flowId: flow.flowId,
      screenId: flow.screenId,
      quickReplies: [],
    });
  }
}
