#!/usr/bin/env node
/**
 * scripts/send-consent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Script de gestión del consentimiento de agentes TIS — modo pruebas/terminal.
 * Llama a los endpoints de AdminController del servidor local.
 *
 * Comandos:
 *   node send-consent.js list                  → Listar todo el personal TIS con estado
 *   node send-consent.js list pending          → Filtrar por estado (pending|accepted|declined|no_record)
 *   node send-consent.js send-all              → Enviar a todos los que no han aceptado
 *   node send-consent.js send-all --force      → Enviar a TODOS (incluso aceptados)
 *   node send-consent.js send <cedula>         → Enviar a un agente específico
 *   node send-consent.js send <c1> <c2> ...    → Enviar a varios agentes
 *
 * Variables de entorno:
 *   ADMIN_API_SECRET   (requerido) — del .env del proyecto
 *   BASE_URL           (opcional)  — default: http://localhost:3000/api
 *
 * Uso típico en desarrollo:
 *   ADMIN_API_SECRET=xxx node scripts/send-consent.js list
 *   ADMIN_API_SECRET=xxx node scripts/send-consent.js send 0803768530
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000/api";
const ADMIN_SECRET = process.env.ADMIN_API_SECRET;

if (!ADMIN_SECRET) {
  console.error("❌ ADMIN_API_SECRET no definido en .env");
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_SECRET}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

// ─── Formateo de tabla ────────────────────────────────────────────────────────

const STATUS_ICON = {
  ACCEPTED: "✅",
  DECLINED: "❌",
  PENDING: "⏳",
  NO_RECORD: "🆕",
};

function printAgentTable(agents) {
  console.log("📋 Agentes TIS:", agents[0]);
  if (!agents.length) {
    console.log("  (sin resultados)");
    return;
  }

  const COL = { ci: 12, nombre: 34, depto: 36, tel: 16, status: 12 };
  const sep = "─".repeat(Object.values(COL).reduce((a, b) => a + b + 3, 0));

  const pad = (s, n) =>
    String(s ?? "—")
      .substring(0, n)
      .padEnd(n);

  console.log(sep);
  console.log(
    pad("Cédula", COL.ci) +
      " │ " +
      pad("Nombre", COL.nombre) +
      " │ " +
      pad("Unidad", COL.depto) +
      " │ " +
      pad("Teléfono", COL.tel) +
      " │ " +
      "Estado",
  );
  console.log(sep);

  for (const a of agents) {
    const icon = STATUS_ICON[a.consentStatus] ?? "?";
    console.log(
      pad(a.citizenId, COL.ci) +
        " │ " +
        pad(a.fullName, COL.nombre) +
        " │ " +
        pad(a.department, COL.depto) +
        " │ " +
        pad(a.waPhone ?? a.rawPhone, COL.tel) +
        " │ " +
        `${icon} ${a.consentStatus}`,
    );
  }

  console.log(sep);
}

function printSendResult(result) {
  console.log(`\n  ✅ Enviados:  ${result.sent}`);
  console.log(`  ⚠️  Omitidos: ${result.skipped}\n`);

  for (const d of result.details ?? []) {
    const icon = d.status === "sent" ? "✅" : "⚠️";
    const reason = d.reason ? `  ← ${d.reason}` : "";
    console.log(`  ${icon} ${d.name} (${d.citizenId})${reason}`);
  }
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

async function cmdList(statusFilter) {
  const path = statusFilter
    ? `/admin/consent?status=${statusFilter.toUpperCase()}`
    : "/admin/consent";

  console.log(
    `\n📋 Personal TIS${statusFilter ? ` (filtro: ${statusFilter.toUpperCase()})` : ""}\n`,
  );

  const { ok, data } = await api("GET", path);

  if (!ok) {
    console.error("❌ Error:", data);
    return;
  }

  console.log(`  Total: ${data.total}`);
  if (data.summary) {
    const parts = Object.entries(data.summary)
      .map(([k, v]) => `${STATUS_ICON[k] ?? "?"} ${k}: ${v}`)
      .join("   ");
    console.log(`  ${parts}\n`);
  }

  printAgentTable(data.agents ?? []);
}

async function cmdSendAll(force) {
  console.log(
    `\n📤 Enviando aviso de consentimiento${force ? " (FORCE — incluye aceptados)" : ""}...\n`,
  );

  const body = force ? { force: true } : {};
  const { ok, data } = await api("POST", "/admin/consent/send", body);

  if (!ok) {
    console.error("❌ Error:", data);
    return;
  }

  printSendResult(data);
}

async function cmdSend(cedulas) {
  if (!cedulas.length) {
    console.error(
      "❌ Indica al menos una cédula. Ej: node send-consent.js send 0803768530",
    );
    process.exit(1);
  }

  if (cedulas.length === 1) {
    console.log(`\n📤 Enviando aviso a cédula ${cedulas[0]}...\n`);
    const { ok, data } = await api("POST", `/admin/consent/send/${cedulas[0]}`);
    if (!ok) {
      console.error("❌ Error:", data);
      return;
    }
    printSendResult(data);
  } else {
    console.log(
      `\n📤 Enviando aviso a ${cedulas.length} cédulas: ${cedulas.join(", ")}...\n`,
    );
    const { ok, data } = await api("POST", "/admin/consent/send", { cedulas });
    if (!ok) {
      console.error("❌ Error:", data);
      return;
    }
    printSendResult(data);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

const HELP = `
Uso: node scripts/send-consent.js <comando> [opciones]

Comandos:
  list [pending|accepted|declined|no_record]  Listar personal TIS con estado de consentimiento
  send-all [--force]                          Enviar aviso a todos los pendientes (--force: incluye aceptados)
  send <cedula> [cedula2 ...]                 Enviar a uno o varios agentes específicos

Ejemplos:
  node scripts/send-consent.js list
  node scripts/send-consent.js list no_record
  node scripts/send-consent.js send-all
  node scripts/send-consent.js send-all --force
  node scripts/send-consent.js send 0803768530
  node scripts/send-consent.js send 0803768530 0802305581

Variables de entorno:
  ADMIN_API_SECRET   (requerido)
  BASE_URL           default: http://localhost:3000/api
`;

(async () => {
  try {
    switch (cmd) {
      case "list":
        await cmdList(args[0]);
        break;

      case "send-all":
        await cmdSendAll(args.includes("--force"));
        break;

      case "send":
        await cmdSend(args.filter((a) => !a.startsWith("--")));
        break;

      default:
        console.log(HELP);
        break;
    }
  } catch (err) {
    console.error("❌ Error inesperado:", err.message);
    process.exit(1);
  }
})();
