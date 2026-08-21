/**
 * Sensitive-field masking (§7, §40).
 *
 * Masking happens on the SERVER, in the serialiser, before the value is put on the wire.
 * These helpers are exported to shared only so the web app can render a masked value it
 * holds locally (e.g. in a form the user just typed) with identical formatting — the
 * client must never receive a full account number and mask it for display, because
 * anything that reaches the browser is readable in devtools.
 */

/**
 * `123456789012` -> `XXXX XXXX 9012`
 *
 * Keeps the last 4 digits, which is what a human needs to recognise the account, and
 * pads to a consistent visual width so a column of masked numbers stays aligned.
 */
export function maskAccountNumber(accountNumber: string | null | undefined): string {
  if (!accountNumber) return "—";
  const digits = accountNumber.replace(/\D/g, "");
  if (digits.length <= 4) return digits.padStart(4, "X");
  return `XXXX XXXX ${digits.slice(-4)}`;
}

/** `9876543210` -> `98XXXXXX10` */
export function maskMobile(mobile: string | null | undefined): string {
  if (!mobile) return "—";
  const digits = mobile.replace(/\D/g, "");
  if (digits.length < 6) return "X".repeat(digits.length);
  return `${digits.slice(0, 2)}${"X".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/** `accountant@amiri.co` -> `acc•••••••@amiri.co` */
export function maskEmail(value: string | null | undefined): string {
  if (!value) return "—";
  const [local, domain] = value.split("@");
  if (!local || !domain) return value;
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${"•".repeat(Math.max(3, local.length - head.length))}@${domain}`;
}

/** `ABCDE1234F` -> `ABCXXXX34F` */
export function maskPan(value: string | null | undefined): string {
  if (!value || value.length !== 10) return value ? "XXXXXXXXXX" : "—";
  return `${value.slice(0, 3)}XXXX${value.slice(-3)}`;
}

/**
 * A display label for a bank account that is safe to show anywhere.
 * `HDFC Bank ••1234`
 */
export function bankAccountLabel(
  bankName: string,
  accountNumber: string | null | undefined,
  masked = true,
): string {
  if (!accountNumber) return bankName;
  const digits = accountNumber.replace(/\D/g, "");
  const tail = digits.slice(-4);
  return masked ? `${bankName} ••${tail}` : `${bankName} ${accountNumber}`;
}
