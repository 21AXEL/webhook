// Endpoint web para calificación de tickets por correo.
// El funcionario recibe un link en el email y al hacer clic
// queda calificado el ticket directamente, sin abrir WhatsApp.
//
// GET /tickets/rate/:token?v=good|bad|false

import { Controller, Get, Param, Query, Res, Logger } from "@nestjs/common";
import type { Response } from "express";
import { TicketService } from "./ticket.service";
import { RatingValue } from "./ticket.constants";

const VALUE_MAP: Record<string, RatingValue> = {
  good: RatingValue.Good,
  bad: RatingValue.Bad,
  false: RatingValue.False,
};

@Controller("tickets")
export class TicketRateController {
  private readonly logger = new Logger(TicketRateController.name);

  constructor(private readonly ticketService: TicketService) {}

  @Get("rate/:token")
  async rate(
    @Param("token") token: string,
    @Query("v") v: string,
    @Res() res: Response,
  ): Promise<void> {
    const ratingValue = VALUE_MAP[v?.toLowerCase()];

    if (!ratingValue) {
      res
        .status(400)
        .send(
          this._page(
            "Enlace inválido",
            "El enlace de calificación no es válido. Por favor usa los botones del correo que recibiste.",
            "⚠️",
            "#b91c1c",
          ),
        );
      return;
    }

    try {
      await this.ticketService.rateByToken(token, { value: ratingValue });

      const messages: Record<RatingValue, string> = {
        [RatingValue.Good]:
          "¡Gracias por tu calificación! Nos alegra que el problema fue resuelto satisfactoriamente.",
        [RatingValue.Bad]:
          "Gracias por tu calificación. Tomaremos nota para mejorar la calidad del servicio.",
        [RatingValue.False]:
          "Entendido. El ticket ha sido registrado como no real.",
        [RatingValue.Comment]: "¡Gracias por tu comentario!",
      };

      const icons: Record<RatingValue, string> = {
        [RatingValue.Good]: "👍",
        [RatingValue.Bad]: "👎",
        [RatingValue.False]: "🚫",
        [RatingValue.Comment]: "💬",
      };

      res.send(
        this._page(
          "Calificación registrada",
          messages[ratingValue],
          icons[ratingValue],
          "#15803d",
        ),
      );
    } catch (err: any) {
      this.logger.warn(`Error al calificar vía token: ${err.message}`);

      const isExpired = err.message?.toLowerCase().includes("expirado");
      const isAlready =
        err.message?.toLowerCase().includes("calificado") ||
        err.message?.toLowerCase().includes("estado actual");

      const msg = isExpired
        ? "El enlace de calificación ha expirado (válido por 7 días). Puedes calificar tu ticket desde WhatsApp."
        : isAlready
          ? "Este ticket ya fue calificado anteriormente. ¡Gracias!"
          : "No pudimos procesar tu calificación. Por favor intenta desde WhatsApp o comunícate con TIS.";

      res
        .status(isAlready ? 200 : 410)
        .send(this._page("Enlace no disponible", msg, "ℹ️", "#d97706"));
    }
  }

  // ─── HTML mínimo de respuesta ─────────────────────────────────────────────────

  private _page(
    title: string,
    message: string,
    icon: string,
    color: string,
  ): string {
    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title} — Helpdesk TIS</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;
             display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="background:#fff;border-radius:12px;padding:40px 36px;max-width:420px;
              width:90%;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.1);">
    <div style="font-size:52px;margin-bottom:16px;">${icon}</div>
    <h1 style="margin:0 0 12px;font-size:20px;color:#111827;">${title}</h1>
    <p style="margin:0 0 28px;color:#6b7280;font-size:14px;line-height:1.6;">${message}</p>
    <div style="width:48px;height:4px;background:${color};border-radius:2px;margin:0 auto;"></div>
    <p style="margin:28px 0 0;font-size:12px;color:#9ca3af;">
      Municipio de Esmeraldas · Dirección de TIS
    </p>
  </div>
</body>
</html>`;
  }
}
