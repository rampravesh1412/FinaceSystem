import { Types, type ClientSession } from "mongoose";
import { bankAccountLabel } from "@amiri/shared";
import { BankAccount, CashAccount, Party } from "../models/index.js";
import { BadRequestError, InactiveAccountError, NotFoundError } from "../lib/errors.js";

/**
 * Resolving a settlement account.
 *
 * Clients send the id of a BankAccount or a CashAccount — never a ledger account id. The
 * chart of accounts is internal structure, and letting an API caller name an arbitrary
 * ledger account would let them post directly against equity, suspense or another
 * branch's bank. This resolver is the only bridge between the two, and it enforces
 * branch ownership on the way across.
 */

export interface ResolvedAccount {
  id: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  kind: "BANK" | "CASH";
  label: string;
  branchId: Types.ObjectId;
}

export async function resolveAccount(
  accountId: string | Types.ObjectId,
  expectedBranchId: string | Types.ObjectId,
  session?: ClientSession,
): Promise<ResolvedAccount> {
  const id = new Types.ObjectId(String(accountId));

  const bank = await BankAccount.findById(id)
    .populate<{ bankId: { name: string; shortName?: string } }>("bankId", "name shortName")
    .session(session ?? null);

  if (bank) {
    assertUsable(bank.status, bank.accountName);
    assertBranch(bank.branchId, expectedBranchId, bank.accountName);
    return {
      id: bank._id,
      ledgerAccountId: bank.ledgerAccountId,
      kind: "BANK",
      // Masked label. A voucher printed for a clerk should not carry the full number.
      label: bankAccountLabel(bank.bankId.shortName ?? bank.bankId.name, bank.accountNumber),
      branchId: bank.branchId,
    };
  }

  const cash = await CashAccount.findById(id).session(session ?? null);
  if (cash) {
    assertUsable(cash.status, cash.name);
    assertBranch(cash.branchId, expectedBranchId, cash.name);
    return {
      id: cash._id,
      ledgerAccountId: cash.ledgerAccountId,
      kind: "CASH",
      label: `Cash — ${cash.name}`,
      branchId: cash.branchId,
    };
  }

  throw new NotFoundError("Account", String(accountId));
}

function assertUsable(status: string, label: string): void {
  if (status !== "ACTIVE") throw new InactiveAccountError(label);
}

/**
 * An account must belong to the branch the transaction is being posted in.
 *
 * Without this, a user assigned to two branches could pay branch 105's expense out of
 * branch 107's bank account — both branches are "theirs", but the books would no longer
 * reconcile per branch, which is the entire point of branch-owned accounts.
 */
function assertBranch(
  accountBranch: Types.ObjectId,
  expected: string | Types.ObjectId,
  label: string,
): void {
  if (!accountBranch.equals(new Types.ObjectId(String(expected)))) {
    throw new BadRequestError(
      `${label} belongs to a different branch and cannot be used for this transaction`,
      "accountId",
    );
  }
}

export interface ResolvedParty {
  id: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  name: string;
  code: string;
  type: string;
  creditLimit: number;
  branchId: Types.ObjectId;
}

/**
 * `allowCrossBranch` — settle with a party whose home branch is not the posting branch.
 *
 * Off by default, and deliberately opt-in per call site rather than removed outright. Only
 * receipts and payments (§14) pass it: a customer may walk into whichever office is nearest
 * and hand over cash, and refusing that forces the operator to either misfile the receipt
 * under the wrong party or not record it at all.
 *
 * What it does NOT relax is double entry. Both legs of the transaction are still stamped
 * with the posting branch, so each branch's books balance on their own; what changes is
 * that the party's receivable is no longer confined to one branch. Their total is the sum
 * across branches, which means a branch-scoped user now sees only the portion of that
 * balance booked in their own branch. That is the real cost of this flag, and it is why an
 * expense, a settlement and a khata adjustment still refuse — those are reconciliation
 * instruments, and a partial view of a balance is precisely what they must not have.
 */
export async function resolveParty(
  partyId: string | Types.ObjectId,
  expectedBranchId: string | Types.ObjectId,
  session?: ClientSession,
  options: { allowCrossBranch?: boolean } = {},
): Promise<ResolvedParty> {
  const party = await Party.findById(partyId).session(session ?? null);
  if (!party) throw new NotFoundError("Party", String(partyId));
  if (party.status !== "ACTIVE") throw new InactiveAccountError(party.name);

  if (
    !options.allowCrossBranch &&
    !party.branchId.equals(new Types.ObjectId(String(expectedBranchId)))
  ) {
    throw new BadRequestError(
      `${party.name} belongs to a different branch`,
      "partyId",
    );
  }

  return {
    id: party._id,
    ledgerAccountId: party.ledgerAccountId,
    name: party.name,
    code: party.code,
    type: party.type,
    creditLimit: party.creditLimit,
    branchId: party.branchId,
  };
}
