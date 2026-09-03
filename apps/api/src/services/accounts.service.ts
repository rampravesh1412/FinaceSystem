import { Types, type ClientSession } from "mongoose";
import { bankAccountLabel } from "@amiri/shared";
import { BankAccount, CashAccount, Party } from "../models/index.js";
import { InactiveAccountError, NotFoundError } from "../lib/errors.js";

/**
 * Resolving a settlement account or a party.
 *
 * Clients send the id of a BankAccount or a CashAccount — never a ledger account id. The
 * chart of accounts is internal structure, and letting an API caller name an arbitrary
 * ledger account would let them post directly against equity or suspense. This resolver is
 * the only bridge between the two.
 *
 * It no longer checks branch ownership, because there is nothing left to check: accounts
 * and parties are organisation-wide. Any counter may receive a payment into the company's
 * HDFC account or settle with a customer who walked in there — which is what actually
 * happens, and what the old per-branch masters forced operators to work around. Double
 * entry is unaffected: both legs of every posting are still stamped with the branch that
 * transacted, so each branch's books balance on their own.
 */

export interface ResolvedAccount {
  id: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  kind: "BANK" | "CASH";
  label: string;
}

export async function resolveAccount(
  accountId: string | Types.ObjectId,
  session?: ClientSession,
): Promise<ResolvedAccount> {
  const id = new Types.ObjectId(String(accountId));

  const bank = await BankAccount.findById(id)
    .populate<{ bankId: { name: string; shortName?: string } }>("bankId", "name shortName")
    .session(session ?? null);

  if (bank) {
    assertUsable(bank.status, bank.accountName);
    return {
      id: bank._id,
      ledgerAccountId: bank.ledgerAccountId,
      kind: "BANK",
      // Masked label. A voucher printed for a clerk should not carry the full number.
      label: bankAccountLabel(bank.bankId.shortName ?? bank.bankId.name, bank.accountNumber),
    };
  }

  const cash = await CashAccount.findById(id).session(session ?? null);
  if (cash) {
    assertUsable(cash.status, cash.name);
    return {
      id: cash._id,
      ledgerAccountId: cash.ledgerAccountId,
      kind: "CASH",
      label: `Cash — ${cash.name}`,
    };
  }

  throw new NotFoundError("Account", String(accountId));
}

function assertUsable(status: string, label: string): void {
  if (status !== "ACTIVE") throw new InactiveAccountError(label);
}

export interface ResolvedParty {
  id: Types.ObjectId;
  ledgerAccountId: Types.ObjectId;
  name: string;
  code: string;
  type: string;
  creditLimit: number;
}

export async function resolveParty(
  partyId: string | Types.ObjectId,
  session?: ClientSession,
): Promise<ResolvedParty> {
  const party = await Party.findById(partyId).session(session ?? null);
  if (!party) throw new NotFoundError("Party", String(partyId));
  if (party.status !== "ACTIVE") throw new InactiveAccountError(party.name);

  return {
    id: party._id,
    ledgerAccountId: party.ledgerAccountId,
    name: party.name,
    code: party.code,
    type: party.type,
    creditLimit: party.creditLimit,
  };
}
