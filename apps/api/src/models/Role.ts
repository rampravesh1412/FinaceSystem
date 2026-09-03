import { Schema, model, type Document, type Types } from "mongoose";
import { ALL_PERMISSIONS } from "@amiri/shared";
import { actorField, baseSchemaOptions } from "./fields.js";

export interface RoleDoc extends Document<Types.ObjectId> {
  name: string;
  label: string;
  description?: string;
  permissions: string[];
  isSuperAdmin: boolean;
  isSystem: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDoc>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 40,
      immutable: true,
    },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300 },

    /**
     * The granted permission strings.
     *
     * Validated against the catalogue in @amiri/shared so a typo like
     * "finance.payment.aprove" cannot be saved — it would silently grant nothing and the
     * mistake would only surface as a confusing "permission denied" months later.
     * The wildcards `*` and `<prefix>.*` are accepted for the SuperAdmin role.
     */
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: (perms: string[]) =>
          perms.every(
            (p) =>
              p === "*" ||
              p.endsWith(".*") ||
              (ALL_PERMISSIONS as readonly string[]).includes(p),
          ),
        message: (props: { value: string[] }) => {
          const unknown = props.value.filter(
            (p) =>
              p !== "*" && !p.endsWith(".*") && !(ALL_PERMISSIONS as readonly string[]).includes(p),
          );
          return `Unknown permission(s): ${unknown.join(", ")}`;
        },
      },
    },

    /**
     * Marks a role as a super admin.
     *
     * This is the single most dangerous flag in the system — it is what makes a
     * SuperAdmin a SuperAdmin. The role service refuses to set it unless the acting user
     * is themselves a super admin, so a lesser role cannot mint one and escalate.
     */
    isSuperAdmin: { type: Boolean, default: false },

    /** Seeded roles: permissions stay editable, but the role cannot be renamed or deleted. */
    isSystem: { type: Boolean, default: false },

    createdBy: actorField(),
    updatedBy: actorField(),
  },
  baseSchemaOptions(),
);

roleSchema.index({ isSystem: 1, name: 1 });

export const Role = model<RoleDoc>("Role", roleSchema);
