import { Types, type FilterQuery } from "mongoose";
import type { CreateBranchInput, UpdateBranchInput } from "@amiri/shared";
import { Branch, User, type BranchDoc } from "../../models/index.js";
import { ConflictError, NotFoundError, translateDuplicate } from "../../lib/errors.js";
import { escapeRegex, type Paging } from "../../lib/http.js";
import * as audit from "../../services/audit.service.js";
import { withTransaction } from "../../lib/unitOfWork.js";

/**
 * Branch master data.
 *
 * Opening balances submitted with a branch are NOT written to a field here. Phase 3 posts
 * them as a dated OPENING_BALANCE transaction against the equity account, which is why
 * this service records them on the audit row and leaves the ledger to the ledger engine.
 * Storing `openingCash` on the branch would create a second source of truth that drifts.
 */

export interface BranchListFilters {
  q?: string;
  status?: string;
  /** From `req.scope.filter`, remapped: a Branch's own id is what a scope constrains. */
  scopeIds?: Types.ObjectId[] | null;
}

function buildFilter(filters: BranchListFilters): FilterQuery<BranchDoc> {
  const filter: FilterQuery<BranchDoc> = {};

  if (filters.status) filter.status = filters.status;

  // A scoped user sees only their assigned branches in the branch list itself. Without
  // this, a branch admin could enumerate the whole organisation's structure from the
  // branch picker even though they cannot read any of its financial data.
  if (filters.scopeIds) filter._id = { $in: filters.scopeIds };

  if (filters.q?.trim()) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), "i");
    filter.$or = [{ name: rx }, { code: rx }, { city: rx }, { state: rx }];
  }

  return filter;
}

export async function list(filters: BranchListFilters, page: Paging) {
  const filter = buildFilter(filters);

  const [items, total] = await Promise.all([
    Branch.find(filter)
      .sort(page.sort)
      .skip(page.skip)
      .limit(page.limit)
      .populate<{ managerId: { _id: Types.ObjectId; name: string } | null }>("managerId", "name")
      .lean(),
    Branch.countDocuments(filter),
  ]);

  // One grouped count instead of N queries — the list view shows a user count per branch
  // and a per-row lookup would be a classic N+1 on a screen that loads 50 rows.
  const ids = items.map((b) => b._id);
  const counts = await User.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { branchIds: { $in: ids }, status: "ACTIVE" } },
    { $unwind: "$branchIds" },
    { $match: { branchIds: { $in: ids } } },
    { $group: { _id: "$branchIds", count: { $sum: 1 } } },
  ]);
  const countByBranch = new Map(counts.map((c) => [String(c._id), c.count]));

  return {
    items: items.map((b) => ({
      id: String(b._id),
      name: b.name,
      code: b.code,
      address: b.address,
      city: b.city,
      state: b.state,
      pincode: b.pincode,
      phone: b.phone,
      email: b.email,
      status: b.status,
      notes: b.notes,
      manager: b.managerId ? { id: String(b.managerId._id), name: b.managerId.name } : undefined,
      userCount: countByBranch.get(String(b._id)) ?? 0,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    })),
    total,
  };
}

export async function getById(id: string, scopeIds: Types.ObjectId[] | null) {
  const filter: FilterQuery<BranchDoc> = { _id: id };
  if (scopeIds) filter._id = { $in: scopeIds.filter((s) => String(s) === id) };

  const branch = await Branch.findOne(filter)
    .populate<{ managerId: { _id: Types.ObjectId; name: string; email: string } | null }>(
      "managerId",
      "name email",
    )
    .lean();

  if (!branch) throw new NotFoundError("Branch", id);
  return branch;
}

export async function create(
  input: CreateBranchInput,
  ctx: audit.AuditContext,
): Promise<BranchDoc> {
  return withTransaction(async (session) => {
    try {
      const [branch] = await Branch.create(
        [
          {
            name: input.name,
            code: input.code,
            address: input.address,
            city: input.city,
            state: input.state,
            pincode: input.pincode,
            phone: input.phone,
            email: input.email,
            managerId: input.managerId,
            status: input.status,
            notes: input.notes,
            booksFromDate: input.openingDate ?? new Date(),
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      if (!branch) throw new Error("Branch creation returned no document");

      await audit.record(
        { ...ctx, branchId: String(branch._id) },
        {
          action: "CREATE",
          entity: "Branch",
          entityId: String(branch._id),
          entityLabel: `${branch.code} — ${branch.name}`,
          newValue: {
            ...branch.toObject(),
            // Recorded on the audit row so the intent is preserved even though the
            // figures become ledger postings rather than fields.
            requestedOpeningCash: input.openingCash,
            requestedOpeningBank: input.openingBankBalance,
          },
        },
        session,
      );

      return branch;
    } catch (err) {
      const duplicate = translateDuplicate(err, "branch");
      if (duplicate) throw duplicate;
      throw err;
    }
  }, { label: "branch.create" });
}

export async function update(
  id: string,
  input: UpdateBranchInput,
  ctx: audit.AuditContext,
): Promise<BranchDoc> {
  return withTransaction(async (session) => {
    const existing = await Branch.findById(id).session(session);
    if (!existing) throw new NotFoundError("Branch", id);

    const before = existing.toObject();
    Object.assign(existing, input, { updatedBy: ctx.userId });
    await existing.save({ session });

    await audit.record(
      { ...ctx, branchId: id },
      {
        action: "UPDATE",
        entity: "Branch",
        entityId: id,
        entityLabel: `${existing.code} — ${existing.name}`,
        oldValue: before,
        newValue: existing.toObject(),
      },
      session,
    );

    return existing;
  }, { label: "branch.update" });
}

/**
 * Disable a branch.
 *
 * A branch is never deleted. Its ledger entries, transactions and audit history have to
 * remain readable and reconcilable forever, and a foreign key pointing at a missing
 * branch would break every historical report. Disabling stops new postings and hides it
 * from pickers, which is what "close a branch" actually means in accounting terms.
 */
export async function setStatus(
  id: string,
  status: "ACTIVE" | "INACTIVE" | "BLOCKED",
  reason: string,
  ctx: audit.AuditContext,
): Promise<BranchDoc> {
  return withTransaction(async (session) => {
    const branch = await Branch.findById(id).session(session);
    if (!branch) throw new NotFoundError("Branch", id);

    if (branch.status === status) {
      throw new ConflictError(`This branch is already ${status.toLowerCase()}`);
    }

    const before = branch.toObject();
    branch.status = status;
    branch.updatedBy = ctx.userId ? new Types.ObjectId(ctx.userId) : undefined;
    await branch.save({ session });

    await audit.record(
      { ...ctx, branchId: id },
      {
        action: "UPDATE",
        entity: "Branch",
        entityId: id,
        entityLabel: `${branch.code} — ${branch.name}`,
        oldValue: { status: before.status },
        newValue: { status },
        reason,
      },
      session,
    );

    return branch;
  }, { label: "branch.setStatus" });
}
