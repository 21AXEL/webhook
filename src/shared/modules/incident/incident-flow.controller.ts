/**
 * incident-flow.controller.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint de intercambio de datos (data exchange) para el WhatsApp Flow
 * de registro de incidentes ciudadanos.
 *
 * Meta llama a este endpoint cada vez que el ciudadano avanza de pantalla
 * dentro del Flow, y también para verificar que el servidor está activo (ping).
 *
 * Ruta: POST /whatsapp/flows/incidents
 *
 * NOTA SOBRE ENCRIPTACIÓN:
 *   En producción, Meta encripta el body del request. Para habilitar encriptación:
 *   1. Configurar en Meta Business Manager → WhatsApp Flows → Endpoint → Enable Encryption
 *   2. Agregar la clave privada en .env: FLOW_PRIVATE_KEY=<base64 PEM>
 *   3. Descifrar con: @whatsapp-flows/node o implementación manual AES-GCM + RSA-OAEP
 *   Por ahora se opera sin encriptación (modo desarrollo).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Controller,
  Post,
  Body,
  HttpCode,
  Logger,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { IncidentFlowExchangeService } from "./incident-flow-exchange.service";
import type { FlowExchangeRequest } from "./incident-flow-exchange.service";

@Controller("whatsapp/flows")
export class IncidentFlowController {
  private readonly logger = new Logger(IncidentFlowController.name);

  constructor(
    private readonly incidentFlowExchangeService: IncidentFlowExchangeService,
  ) {}

  /**
   * POST /whatsapp/flows/incidents
   *
   * Maneja tres tipos de action:
   *   ping          → health-check de Meta durante publicación del Flow
   *   init          → el ciudadano abrió el Flow
   *   data_exchange → el ciudadano avanzó de pantalla
   */
  @Post("incidents")
  @HttpCode(200)
  async handleFlowExchange(@Body() body: FlowExchangeRequest): Promise<any> {
    try {
      this.logger.log(
        `Flow exchange recibido — action: ${body.action}, screen: ${body.screen ?? "N/A"}`,
      );

      const response = await this.incidentFlowExchangeService.handle(body);

      this.logger.debug(
        `Flow exchange respuesta: ${JSON.stringify(response).slice(0, 200)}`,
      );

      return response;
    } catch (err: any) {
      this.logger.error(`Error en flow exchange: ${err.message}`, err.stack);
      // Meta espera siempre 200 — devolvemos un error estructurado en el body
      throw new HttpException(
        { error: "internal_error", message: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
