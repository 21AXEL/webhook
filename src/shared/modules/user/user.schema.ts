/**
 * user.schema.ts
 * Schemas Mongoose para las colecciones 'users' y 'roles' del sistema principal.
 * NO se duplican datos — apuntan a las mismas colecciones via mismo MONGODB_URI.
 * strict: false → Mongoose lee todos los campos sin rechazar los que el sistema
 * principal gestiona (permisos, googleId, facebookId, etc.).
 */

import mongoose, { Schema, Document } from "mongoose";

// ─── Tokens de inyección ─────────────────────────────────────────────────────
/** modelo 'user'  →  colección 'users' */
export const USER_MODEL = "user";
/** modelo 'role'  →  colección 'roles' */
export const ROLE_MODEL = "role";

// ─── Tipos de documento ───────────────────────────────────────────────────────
export type UserDocument = Document & {
  name: string;
  last_name?: string;
  dni?: string;
  telf?: string;
  email: string;
  password?: string;
  verificado?: boolean;
  status?: boolean;
  role: any | null;
  photo?: string;
  verificationCode?: string;
  password_temp?: string;
  last_login?: Date;
  date_expedition?: string; // campo extra del flujo WhatsApp — no persiste en DB
  [key: string]: any;
};

export type RoleDocument = Document & {
  name?: string;
  permisos?: mongoose.Types.ObjectId[];
  [key: string]: any;
};

// ─── Schema de Usuario ────────────────────────────────────────────────────────
// Refleja el mismo userSchema del sistema principal.
// email NO se marca required aquí para que createUser pueda asignar un placeholder
// antes de guardar cuando el ciudadano no proporciona correo.
export const UserSchema = new Schema(
  {
    name: { type: String },
    last_name: { type: String },
    dni: { type: String, trim: true, lowercase: true, sparse: true },
    telf: { type: String },
    email: { type: String, trim: true, lowercase: true },
    password: { type: String },
    verificado: { type: Boolean, default: false },
    status: { type: Boolean, default: true },
    role: { type: Schema.Types.ObjectId, ref: ROLE_MODEL },
    photo: { type: String, default: null },
    verificationCode: { type: String },
    password_temp: { type: String },
    last_login: { type: Date },
  },
  {
    strict: false, // No rechazar campos extra del sistema principal
    timestamps: true,
  },
);

// ─── Schema de Rol ────────────────────────────────────────────────────────────
export const RoleSchema = new Schema(
  {
    name: { type: String },
    permisos: [{ type: Schema.Types.ObjectId, ref: "permission" }],
  },
  {
    strict: false,
    timestamps: true,
  },
);
