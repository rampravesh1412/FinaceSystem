/**
 * Import and notification contracts (§50, §52).
 *
 * Types only — both features are driven by endpoints whose request bodies are already
 * covered by `objectId` and plain row records, so there is nothing here to validate. What
 * matters is that the API and the web agree on the SHAPE of a preview, because the
 * import wizard's whole purpose is to show the operator exactly what a commit will do.
 */

/** A problem with one row of an import file. */
export interface ImportRowIssue {
  /** 1-based row number as it appears in the spreadsheet, header included. */
  row: number;
  field?: string;
  message: string;
  /**
   * `error` — the row cannot be imported.
   * `warning` — the row is valid but will be skipped, usually a duplicate. The operator
   * decides whether that is correct; the importer never overwrites an existing record.
   */
  severity: "error" | "warning";
}

export interface ImportPreview {
  kind: "PARTIES" | "OPENING_BALANCES";
  totalRows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  issues: ImportRowIssue[];
  /** The first rows as they would be created — what the operator actually checks. */
  sample: Array<Record<string, unknown>>;
}

export interface ImportResult extends ImportPreview {
  imported: number;
  skipped: number;
}

/* -------------------------------------------------------------------------- */
/* Notifications (§50)                                                        */
/* -------------------------------------------------------------------------- */

export interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  /** In-app route to the thing this is about, so a notification is actionable. */
  link?: string;
  amount?: number;
  read: boolean;
  createdAt: string;
}

export interface NotificationFeed {
  items: NotificationRow[];
  unread: number;
}
