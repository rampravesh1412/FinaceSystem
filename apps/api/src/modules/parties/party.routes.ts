import { Router } from "express";
import { z } from "zod";
import {
  createPartySchema,
  objectId,
  partyQuerySchema,
  updatePartySchema,
  type CreatePartyInput,
  type PartyQuery,
  type UpdatePartyInput,
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import {
  assertBranchInScope,
  requireAuth,
  requireBranchAccess,
  requirePermission,
  scopeOf,
} from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as service from "./party.service.js";

export const partyRouter: Router = Router();

partyRouter.use(requireAuth);

const idParam = z.object({ id: objectId });

partyRouter.get(
  "/",
  requirePermission("finance.party.view"),
  requireBranchAccess({ optional: true }),
  validate({ query: partyQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as PartyQuery;
    const page = paging(query, { name: 1 }, ["name", "code", "balance", "createdAt"]);

    const { items, total, totals } = await service.listParties(
      {
        q: query.q,
        type: query.type,
        status: query.status,
        balance: query.balance,
        overLimit: query.overLimit,
        scopeFilter: scopeOf(req),
      },
      page,
    );

    // Receivable and payable totals across the whole filtered set, so the header figures
    // describe the query rather than just the visible page.
    return paginated(res, items, total, page.page, page.limit, {
      totalReceivable: totals.lena,
      totalPayable: totals.dena,
    });
  }),
);

partyRouter.get(
  "/:id",
  requirePermission("finance.party.view"),
  requireBranchAccess({ optional: true }),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    return ok(res, await service.getPartyProfile(id, scopeOf(req)));
  }),
);

partyRouter.post(
  "/",
  requirePermission("finance.party.create"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ body: createPartySchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreatePartyInput;
    assertBranchInScope(req, input.branchId);
    const party = await service.createParty(input, auditContextFrom(req));
    // The same shape the list returns, including the posted opening balance.
    return created(res, await service.getPartySummary(String(party._id)), `${party.name} added`);
  }),
);

partyRouter.patch(
  "/:id",
  requirePermission("finance.party.edit"),
  requireBranchAccess({ optional: true }),
  mutationLimiter,
  validate({ params: idParam, body: updatePartySchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const party = await service.updateParty(
      id,
      req.valid.body as UpdatePartyInput,
      scopeOf(req),
      auditContextFrom(req),
    );
    return ok(res, party, "Party updated");
  }),
);
