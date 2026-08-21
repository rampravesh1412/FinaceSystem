/* Identity & organisation */
export { Branch, type BranchDoc } from "./Branch.js";
export { Role, type RoleDoc } from "./Role.js";
export { User, type UserDoc, type UserModel } from "./User.js";
export { Session, type SessionDoc } from "./Session.js";
export { AuditLog, type AuditLogDoc } from "./AuditLog.js";
export { Counter, nextSequence, peekSequence, type CounterDoc } from "./Counter.js";

/* Ledger core */
export {
  LedgerAccount,
  SYSTEM_ACCOUNTS,
  type LedgerAccountDoc,
  type SystemAccountKey,
} from "./LedgerAccount.js";
export { LedgerEntry, type LedgerEntryDoc } from "./LedgerEntry.js";
export { Transaction, type TransactionDoc } from "./Transaction.js";

/* Masters */
export { Bank, type BankDoc } from "./Bank.js";
export { BankAccount, type BankAccountDoc } from "./BankAccount.js";
export { CashAccount, type CashAccountDoc } from "./CashAccount.js";
export { Party, type PartyDoc } from "./Party.js";
export { ChargeRule, type ChargeRuleDoc } from "./ChargeRule.js";
export { ExpenseCategory, IncomeHead, type AccountHeadDoc } from "./ExpenseCategory.js";
export { SavingsAccount, type SavingsAccountDoc } from "./SavingsAccount.js";
export { Settlement, type SettlementDoc } from "./Settlement.js";
export { DailyCashTally, type DailyCashTallyDoc } from "./DailyCashTally.js";
export { FinancialPeriod, type FinancialPeriodDoc } from "./FinancialPeriod.js";
export { Notification, type NotificationDoc } from "./Notification.js";
export { SystemSetting, type SystemSettingDoc } from "./SystemSetting.js";
export {
  Reconciliation, ReconciliationLine,
  type ReconciliationDoc, type ReconciliationLineDoc,
} from "./Reconciliation.js";

/* Transaction discriminators. Importing this registers them with the base model, which
   must happen before any query runs or Mongoose will not apply the right schema. */
export {
  PaymentIn, PaymentOut, BankTransfer, Expense, Income, Adjustment, OpeningBalance,
  type PaymentDoc, type BankTransferDoc, type ExpenseDoc, type IncomeDoc, type AdjustmentDoc,
} from "./discriminators.js";
