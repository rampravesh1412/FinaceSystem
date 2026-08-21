import { Router } from "express";
import { authRouter } from "./modules/auth/auth.routes.js";
import { branchRouter } from "./modules/branches/branch.routes.js";
import { userRouter } from "./modules/users/user.routes.js";
import { roleRouter } from "./modules/roles/role.routes.js";
import { bankRouter, bankAccountRouter, cashAccountRouter } from "./modules/banking/banking.routes.js";
import { partyRouter } from "./modules/parties/party.routes.js";
import { ledgerRouter } from "./modules/ledger/ledger.routes.js";
import {
  paymentInRouter, paymentOutRouter, transferRouter, expenseRouter,
  incomeRouter, chargeRouter, transactionRouter,
} from "./modules/transactions/transaction.routes.js";
import {
  khataRouter, creditRouter, savingsRouter, reconciliationRouter,
  settlementRouter, adjustmentRouter,
} from "./modules/khata/khata.routes.js";
import { reportRouter, dashboardRouter, tallyRouter } from "./modules/reports/report.routes.js";
import { approvalRouter, periodRouter, auditRouter } from "./modules/governance/governance.routes.js";
import { exportRouter } from "./modules/reports/export.routes.js";
import { importRouter, notificationRouter } from "./modules/imports/import.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";

/**
 * API surface.
 *
 * Phase 1 — identity and organisation.
 * Phase 2 — chart of accounts, banks, cash, parties, ledger reads.
 * Phase 3 — payments, transfers, expenses, income, charges, reversal.
 * Phase 4 — khata, credit aging, savings, settlements, reconciliation, adjustments.
 * Phase 5 — dashboards, daily cash tally, P&L, balance sheet, cash flow.
 * Phase 6 — approvals, financial periods, audit log.
 * Phase 7 — CSV / Excel / PDF export, import, notifications.
 * Phase 8 — organisation settings.
 *
 * Still to mount:
 */
export const apiRouter: Router = Router();

apiRouter.get("/", (_req, res) => {
  res.json({ success: true, data: { name: "AMIRI Finance API", version: "0.8.0", phase: 8 } });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/branches", branchRouter);
apiRouter.use("/users", userRouter);
apiRouter.use("/roles", roleRouter);

apiRouter.use("/banks", bankRouter);
apiRouter.use("/bank-accounts", bankAccountRouter);
apiRouter.use("/cash-accounts", cashAccountRouter);
apiRouter.use("/parties", partyRouter);
apiRouter.use("/ledger", ledgerRouter);

apiRouter.use("/payment-in", paymentInRouter);
apiRouter.use("/payment-out", paymentOutRouter);
apiRouter.use("/bank-transfers", transferRouter);
apiRouter.use("/expenses", expenseRouter);
apiRouter.use("/income", incomeRouter);
apiRouter.use("/charges", chargeRouter);
apiRouter.use("/transactions", transactionRouter);

apiRouter.use("/khata", khataRouter);
apiRouter.use("/credit", creditRouter);
apiRouter.use("/savings", savingsRouter);
apiRouter.use("/reconciliation", reconciliationRouter);
apiRouter.use("/settlements", settlementRouter);
apiRouter.use("/adjustments", adjustmentRouter);

apiRouter.use("/dashboard", dashboardRouter);
apiRouter.use("/reports", reportRouter);
apiRouter.use("/cash-tally", tallyRouter);

apiRouter.use("/approvals", approvalRouter);
apiRouter.use("/periods", periodRouter);
apiRouter.use("/audit-logs", auditRouter);
apiRouter.use("/export", exportRouter);
apiRouter.use("/import", importRouter);
apiRouter.use("/notifications", notificationRouter);
apiRouter.use("/settings", settingsRouter);
