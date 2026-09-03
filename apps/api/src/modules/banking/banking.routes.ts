import { Router } from "express";
import { z } from "zod";
import {
  bankAccountQuerySchema,
  createBankAccountSchema,
  createBankSchema,
  createCashAccountSchema,
  hasPermission,
  listQuery,
  objectId,
  updateBankAccountSchema,
  updateBankSchema,
  updateCashAccountSchema,
  type BankAccountQuery,
  type CreateBankAccountInput,
  type CreateBankInput,
  type CreateCashAccountInput,
  type UpdateBankAccountInput,
  type UpdateBankInput,
  type UpdateCashAccountInput,
} from "@amiri/shared";
import { asyncHandler, created, ok, paginated, paging } from "../../lib/http.js";
import { validate } from "../../middleware/validate.js";
import { requireAuth, requirePermission } from "../../middleware/auth.js";
import { mutationLimiter } from "../../middleware/security.js";
import { auditContextFrom } from "../../services/audit.service.js";
import * as service from "./banking.service.js";

/**
 * Access here is governed by the `finance.bank.*` and `finance.cash.*` permissions, and
 * `finance.bank.viewFull` decides whether the account digits leave the server at all.
 */
export const bankRouter: Router = Router();
export const bankAccountRouter: Router = Router();
export const cashAccountRouter: Router = Router();

bankRouter.use(requireAuth);
bankAccountRouter.use(requireAuth);
cashAccountRouter.use(requireAuth);

const idParam = z.object({ id: objectId });

/* ── Banks ───────────────────────────────────────────────────────────────── */

bankRouter.get(
  "/",
  requirePermission("finance.bank.view"),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as z.infer<typeof listQuery>;
    const page = paging(query, { name: 1 }, ["name", "createdAt"]);
    const { items, total } = await service.listBanks({ q: query.q }, page);
    return paginated(res, items, total, page.page, page.limit);
  }),
);

bankRouter.post(
  "/",
  requirePermission("finance.bank.create"),
  mutationLimiter,
  validate({ body: createBankSchema }),
  asyncHandler(async (req, res) => {
    const bank = await service.createBank(req.valid.body as CreateBankInput, auditContextFrom(req));
    return created(res, bank, `${bank.name} added`);
  }),
);

/* ── Bank accounts ───────────────────────────────────────────────────────── */

bankRouter.patch(
  "/:id",
  requirePermission("finance.bank.edit"),
  mutationLimiter,
  validate({ params: idParam, body: updateBankSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const bank = await service.updateBank(id, req.valid.body as UpdateBankInput, auditContextFrom(req));
    return ok(res, bank, `${bank.name} updated`);
  }),
);

/* ── Bank accounts ───────────────────────────────────────────────────────── */

bankAccountRouter.get(
  "/",
  requirePermission("finance.bank.view"),
  validate({ query: bankAccountQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as BankAccountQuery;
    const page = paging(query, { createdAt: -1 }, ["accountName", "createdAt", "accountType"]);

    const { items, total, totalBalance } = await service.listBankAccounts(
      {
        q: query.q,
        bankId: query.bankId,
        accountType: query.accountType,
        status: query.status,
      },
      page,
      // Full account numbers require their own permission; everyone else gets
      // XXXX XXXX 1234 and the digits never leave the server.
      hasPermission(req.auth!.permissions, "finance.bank.viewFull"),
    );

    return paginated(res, items, total, page.page, page.limit, { totalBalance });
  }),
);

bankAccountRouter.post(
  "/",
  requirePermission("finance.bank.create"),
  mutationLimiter,
  validate({ body: createBankAccountSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateBankAccountInput;
    const account = await service.createBankAccount(input, auditContextFrom(req));
    // The list's shape, so the caller gets the posted opening balance back — and the
    // account number masked unless they hold `finance.bank.viewFull`.
    return created(
      res,
      await service.getBankAccountSummary(String(account._id), hasPermission(req.auth!.permissions, "finance.bank.viewFull")),
      `${account.accountName} added`,
    );
  }),
);

bankAccountRouter.patch(
  "/:id",
  requirePermission("finance.bank.edit"),
  mutationLimiter,
  validate({ params: idParam, body: updateBankAccountSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const account = await service.updateBankAccount(
      id,
      req.valid.body as UpdateBankAccountInput,
      auditContextFrom(req),
    );
    return ok(res, account, "Bank account updated");
  }),
);

/* ── Cash accounts ───────────────────────────────────────────────────────── */

cashAccountRouter.get(
  "/",
  requirePermission("finance.cash.view"),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const query = req.valid.query as z.infer<typeof listQuery>;
    const page = paging(query, { name: 1 }, ["name", "createdAt"]);
    const { items, total, totalBalance } = await service.listCashAccounts(page);
    return paginated(res, items, total, page.page, page.limit, { totalBalance });
  }),
);

cashAccountRouter.post(
  "/",
  requirePermission("finance.cash.manage"),
  mutationLimiter,
  validate({ body: createCashAccountSchema }),
  asyncHandler(async (req, res) => {
    const input = req.valid.body as CreateCashAccountInput;
    const account = await service.createCashAccount(input, auditContextFrom(req));
    return created(
      res,
      await service.getCashAccountSummary(String(account._id)),
      `${account.name} added`,
    );
  }),
);

cashAccountRouter.patch(
  "/:id",
  requirePermission("finance.bank.edit"),
  mutationLimiter,
  validate({ params: idParam, body: updateCashAccountSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params as z.infer<typeof idParam>;
    const account = await service.updateCashAccount(
      id,
      req.valid.body as UpdateCashAccountInput,
      auditContextFrom(req),
    );
    return ok(res, await service.getCashAccountSummary(String(account._id)), `${account.name} updated`);
  }),
);
