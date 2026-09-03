import { transactionPermissionFor, type Permission, type PermissionAction } from "@amiri/shared";
import { Transaction } from "../../models/index.js";

/**
 * The permission needed to take `action` on this transaction.
 *
 * The type-to-module map lives in @amiri/shared so the guard here and the button in the
 * transaction drawer cannot disagree — a button the server then refuses is worse than no
 * button at all.
 *
 * Returns `null` when the row does not exist, so the handler behind the guard raises the
 * NotFoundError: a permission denial here would let a caller probe for valid ids.
 */
export async function transactionPermission(
  transactionId: string,
  action: PermissionAction,
): Promise<Permission | null> {
  const txn = await Transaction.findById(transactionId).select("type").lean();
  if (!txn) return null;
  return transactionPermissionFor(txn.type, action);
}
