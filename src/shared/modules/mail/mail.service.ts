// Servicio de correo transaccional para notificaciones del helpdesk.
// Usa nodemailer con el SMTP configurado en configuration.ts.
// Todas las operaciones son fire-and-forget: los errores se logean
// pero no bloquean el flujo principal.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface TicketCreatedMailParams {
  to: string; // correo institucional del beneficiario
  recipientName: string; // nombre completo
  ticketNumber: string; // ej: TKT-2026-00001
  category: string; // label legible de la categoría
  description: string; // descripción del problema
  location: string; // ubicación física
  createdByAgentName?: string | null; // agente TIS que lo creó (si aplica)
}

// ─── Interfaces adicionales ───────────────────────────────────────────────────

export interface TicketInProgressMailParams {
  to: string;
  recipientName: string;
  ticketNumber: string;
  agentName: string;
  description: string;
  location: string;
}

export interface TicketResolvedMailParams {
  to: string;
  recipientName: string;
  ticketNumber: string;
  description: string;
  agentName: string | null;
  ratingToken: string; // para construir los links de calificación
}

export interface TicketFalseMailParams {
  to: string;
  recipientName: string;
  ticketNumber: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly botWaPhone: string; // número del bot sin + ni espacios (ej: 593995767887)

  constructor(private readonly configService: ConfigService) {
    this.from =
      configService.get<string>("mail.from") ?? "helpdesk@esmeraldas.gob.ec";
    this.botWaPhone = configService.get<string>("whatsapp.botPhone") ?? "";

    this.transporter = nodemailer.createTransport({
      host: configService.get<string>("mail.host"),
      port: configService.get<number>("mail.port"),
      secure: configService.get<boolean>("mail.secure") ?? false,
      auth: {
        user: configService.get<string>("mail.user"),
        pass: configService.get<string>("mail.password"),
      },
    });
  }

  // ─── API pública ─────────────────────────────────────────────────────────────

  /**
   * Notifica al funcionario que se abrió un ticket en su nombre.
   * Fire-and-forget: nunca lanza, solo logea en caso de error.
   */
  async sendTicketCreated(params: TicketCreatedMailParams): Promise<void> {
    const waLink = this.botWaPhone
      ? `https://wa.me/${this.botWaPhone}?text=mis%20tickets`
      : null;

    const html = this._buildTicketCreatedHtml({ ...params, waLink });

    try {
      await this.transporter.sendMail({
        from: `"Helpdesk TIS - Municipio de Esmeraldas" <${this.from}>`,
        to: params.to,
        subject: `🎫 Ticket ${params.ticketNumber} abierto a tu nombre`,
        html,
      });
      this.logger.log(
        `📧 Notificación de ticket enviada a ${params.to} (${params.ticketNumber})`,
      );
    } catch (err: any) {
      this.logger.warn(
        `No se pudo enviar correo a ${params.to}: ${err.message}`,
      );
    }
  }

  // ─── Ticket en atención ───────────────────────────────────────────────────────

  async sendTicketInProgress(
    params: TicketInProgressMailParams,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"Helpdesk TIS - Municipio de Esmeraldas" <${this.from}>`,
        to: params.to,
        subject: `🔧 Ticket ${params.ticketNumber} en atención`,
        html: this._buildInProgressHtml(params),
      });
      this.logger.log(`📧 Correo "en atención" enviado a ${params.to}`);
    } catch (err: any) {
      this.logger.warn(
        `No se pudo enviar correo "en atención" a ${params.to}: ${err.message}`,
      );
    }
  }

  // ─── Ticket resuelto + encuesta ───────────────────────────────────────────────

  async sendTicketResolved(params: TicketResolvedMailParams): Promise<void> {
    const baseUrl = this.configService.get<string>("mail.baseUrl") ?? "";
    const token = params.ratingToken;

    const ratingLinks = {
      good: `${baseUrl}/tickets/rate/${token}?v=good`,
      bad: `${baseUrl}/tickets/rate/${token}?v=bad`,
      false: `${baseUrl}/tickets/rate/${token}?v=false`,
    };

    const waLink = this.botWaPhone ? `https://wa.me/${this.botWaPhone}` : null;

    try {
      await this.transporter.sendMail({
        from: `"Helpdesk TIS - Municipio de Esmeraldas" <${this.from}>`,
        to: params.to,
        subject: `✅ Ticket ${params.ticketNumber} resuelto — Califica el servicio`,
        html: this._buildResolvedHtml({ ...params, ratingLinks, waLink }),
      });
      this.logger.log(`📧 Correo "resuelto + encuesta" enviado a ${params.to}`);
    } catch (err: any) {
      this.logger.warn(
        `No se pudo enviar correo "resuelto" a ${params.to}: ${err.message}`,
      );
    }
  }

  // ─── Ticket falso ─────────────────────────────────────────────────────────────

  async sendTicketFalse(params: TicketFalseMailParams): Promise<void> {
    const waLink = this.botWaPhone ? `https://wa.me/${this.botWaPhone}` : null;

    try {
      await this.transporter.sendMail({
        from: `"Helpdesk TIS - Municipio de Esmeraldas" <${this.from}>`,
        to: params.to,
        subject: `⚠️ Ticket ${params.ticketNumber} marcado como no válido`,
        html: this._buildFalseHtml({ ...params, waLink }),
      });
      this.logger.log(`📧 Correo "ticket falso" enviado a ${params.to}`);
    } catch (err: any) {
      this.logger.warn(
        `No se pudo enviar correo "falso" a ${params.to}: ${err.message}`,
      );
    }
  }

  // ─── Plantilla HTML ──────────────────────────────────────────────────────────

  private _buildTicketCreatedHtml(
    params: TicketCreatedMailParams & { waLink: string | null },
  ): string {
    const {
      recipientName,
      ticketNumber,
      category,
      description,
      location,
      createdByAgentName,
      waLink,
    } = params;

    const firstName = recipientName.split(" ")[0];
    const createdByRow = createdByAgentName
      ? `<tr>
           <td style="padding:6px 0;color:#6b7280;font-size:13px;">Registrado por</td>
           <td style="padding:6px 0;font-size:13px;">${createdByAgentName} (TIS)</td>
         </tr>`
      : "";

    const waButton = waLink
      ? `<div style="text-align:center;margin-top:28px;">
           <a href="${waLink}"
              style="background:#25d366;color:#fff;text-decoration:none;
                     padding:12px 28px;border-radius:8px;font-size:15px;
                     font-weight:600;display:inline-block;">
             💬 Seguimiento por WhatsApp
           </a>
         </div>
         <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:10px;">
           Toca el botón para abrir el chat y consultar el estado de tu ticket.
         </p>`
      : "";

    return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:12px;overflow:hidden;
                    box-shadow:0 1px 4px rgba(0,0,0,.08);">

        <!-- Cabecera -->
        <tr>
          <td style="background:#1e40af;padding:24px 32px;">
            <p style="margin:0;color:#93c5fd;font-size:12px;text-transform:uppercase;
                      letter-spacing:.08em;">Municipio de Esmeraldas</p>
            <h1 style="margin:4px 0 0;color:#fff;font-size:20px;">
              Helpdesk — Dirección de TIS
            </h1>
          </td>
        </tr>

        <!-- Cuerpo -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 16px;font-size:16px;color:#111827;">
              Hola <strong>${firstName}</strong>,
            </p>
            <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
              Se ha registrado un ticket de soporte técnico a tu nombre.
              El equipo de TIS atenderá tu solicitud a la brevedad.
            </p>

            <!-- Tarjeta del ticket -->
            <div style="background:#f9fafb;border:1px solid #e5e7eb;
                        border-radius:8px;padding:20px 24px;margin-bottom:24px;">
              <p style="margin:0 0 14px;font-size:18px;font-weight:700;
                        color:#1e40af;">🎫 ${ticketNumber}</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;width:140px;">Categoría</td>
                  <td style="padding:6px 0;font-size:13px;">${category}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">Descripción</td>
                  <td style="padding:6px 0;font-size:13px;">${description}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#6b7280;font-size:13px;">Ubicación</td>
                  <td style="padding:6px 0;font-size:13px;">${location}</td>
                </tr>
                ${createdByRow}
              </table>
            </div>

            ${waButton}
          </td>
        </tr>

        <!-- Pie -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;
                     padding:16px 32px;text-align:center;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              Dirección de Tecnologías de la Información •
              GAD Municipal del Cantón Esmeraldas
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private _buildInProgressHtml(p: TicketInProgressMailParams): string {
    const firstName = p.recipientName.split(" ")[0];
    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr><td style="background:#d97706;padding:24px 32px;">
        <p style="margin:0;color:#fef3c7;font-size:12px;text-transform:uppercase;">Municipio de Esmeraldas</p>
        <h1 style="margin:4px 0 0;color:#fff;font-size:20px;">🔧 Tu ticket está siendo atendido</h1>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px;font-size:16px;color:#111827;">Hola <strong>${firstName}</strong>,</p>
        <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
          El técnico <strong>${p.agentName}</strong> ha aceptado tu solicitud
          y ya está en camino para atenderte.
        </p>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:20px 24px;">
          <p style="margin:0 0 8px;font-weight:700;color:#92400e;">🎫 ${p.ticketNumber}</p>
          <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">📍 Ubicación: <span style="color:#111827;">${p.location}</span></p>
          <p style="margin:0;font-size:13px;color:#6b7280;">🔍 Problema: <span style="color:#111827;">${p.description}</span></p>
        </div>
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          Dirección de Tecnologías de la Información • GAD Municipal del Cantón Esmeraldas
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }

  private _buildResolvedHtml(
    p: TicketResolvedMailParams & {
      ratingLinks: { good: string; bad: string; false: string };
      waLink: string | null;
    },
  ): string {
    const firstName = p.recipientName.split(" ")[0];
    const agentRow = p.agentName
      ? `<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">👷 Atendido por: <span style="color:#111827;">${p.agentName}</span></p>`
      : "";
    const nuevoTicket = p.waLink
      ? `<div style="text-align:center;margin-top:16px;">
           <a href="${p.waLink}" style="background:#6b7280;color:#fff;text-decoration:none;
              padding:10px 22px;border-radius:8px;font-size:14px;display:inline-block;">
             📩 Abrir nuevo ticket
           </a>
         </div>`
      : "";

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr><td style="background:#15803d;padding:24px 32px;">
        <p style="margin:0;color:#bbf7d0;font-size:12px;text-transform:uppercase;">Municipio de Esmeraldas</p>
        <h1 style="margin:4px 0 0;color:#fff;font-size:20px;">✅ Tu ticket fue resuelto</h1>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px;font-size:16px;color:#111827;">Hola <strong>${firstName}</strong>,</p>
        <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
          El equipo de TIS marcó tu solicitud como resuelta. Tómate un momento
          para contarnos cómo fue la atención recibida.
        </p>

        <!-- Detalle del ticket -->
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
          <p style="margin:0 0 8px;font-weight:700;color:#15803d;">🎫 ${p.ticketNumber}</p>
          <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">🔍 Problema: <span style="color:#111827;">${p.description}</span></p>
          ${agentRow}
        </div>

        <!-- Encuesta -->
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;text-align:center;">
          ¿Cómo fue el servicio recibido?
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
          <tr>
            <td align="center" style="padding:0 6px;">
              <a href="${p.ratingLinks.good}"
                 style="background:#16a34a;color:#fff;text-decoration:none;
                        padding:14px 0;border-radius:8px;font-size:16px;
                        font-weight:700;display:block;width:100%;text-align:center;">
                👍 Bueno
              </a>
            </td>
            <td align="center" style="padding:0 6px;">
              <a href="${p.ratingLinks.bad}"
                 style="background:#dc2626;color:#fff;text-decoration:none;
                        padding:14px 0;border-radius:8px;font-size:16px;
                        font-weight:700;display:block;width:100%;text-align:center;">
                👎 Malo
              </a>
            </td>
            <td align="center" style="padding:0 6px;">
              <a href="${p.ratingLinks.false}"
                 style="background:#6b7280;color:#fff;text-decoration:none;
                        padding:14px 0;border-radius:8px;font-size:16px;
                        font-weight:700;display:block;width:100%;text-align:center;">
                🚫 No fue real
              </a>
            </td>
          </tr>
        </table>
        <p style="text-align:center;color:#9ca3af;font-size:11px;margin:8px 0 0;">
          Los links expiran en 7 días. Si ya calificaste por WhatsApp, ignora este correo.
        </p>

        ${nuevoTicket}
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          Dirección de Tecnologías de la Información • GAD Municipal del Cantón Esmeraldas
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }

  private _buildFalseHtml(
    p: TicketFalseMailParams & { waLink: string | null },
  ): string {
    const firstName = p.recipientName.split(" ")[0];
    const nuevoTicket = p.waLink
      ? `<div style="text-align:center;margin-top:24px;">
           <a href="${p.waLink}" style="background:#1e40af;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
             📩 Abrir nuevo ticket por WhatsApp
           </a>
         </div>`
      : "";

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
      <tr><td style="background:#b91c1c;padding:24px 32px;">
        <p style="margin:0;color:#fecaca;font-size:12px;text-transform:uppercase;">Municipio de Esmeraldas</p>
        <h1 style="margin:4px 0 0;color:#fff;font-size:20px;">⚠️ Ticket marcado como no válido</h1>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 16px;font-size:16px;color:#111827;">Hola <strong>${firstName}</strong>,</p>
        <p style="margin:0 0 16px;color:#374151;font-size:14px;line-height:1.6;">
          El equipo de TIS revisó tu solicitud <strong>${p.ticketNumber}</strong> y la
          marcó como <strong>ticket no válido</strong>.
        </p>
        <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
          Si crees que esto es un error o necesitas reportar un nuevo problema,
          puedes abrir un nuevo ticket desde WhatsApp.
        </p>
        ${nuevoTicket}
      </td></tr>
      <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;text-align:center;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          Dirección de Tecnologías de la Información • GAD Municipal del Cantón Esmeraldas
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }
}
