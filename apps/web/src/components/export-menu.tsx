import * as React from "react";
import { toast } from "sonner";
import { Download, FileSpreadsheet, FileText, Sheet } from "lucide-react";
import { getAccessToken, qs } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Export menu (§53, §54).
 *
 * Downloads via `fetch` + blob rather than a plain `<a href>`, for one reason: the access
 * token lives in memory and is sent as an Authorization header. A bare link would carry no
 * header and get a 401, and putting the token in the URL instead would leak it into
 * browser history, the referrer and any proxy log in between.
 */
export function ExportMenu({
  path,
  params = {},
  label = "Export",
  size = "sm",
}: {
  /** API path without /api/v1, e.g. "/export/daybook". */
  path: string;
  params?: Record<string, string | number | undefined>;
  label?: string;
  size?: "sm" | "default";
}) {
  const [busy, setBusy] = React.useState<string | null>(null);

  const download = async (format: "csv" | "xlsx" | "pdf") => {
    setBusy(format);
    try {
      const res = await fetch(`/api/v1${path}${qs({ ...params, format })}`, {
        headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
        credentials: "same-origin",
      });

      if (!res.ok) {
        // The server sends a JSON error envelope even on an export route, so the message
        // is worth surfacing rather than showing "download failed".
        let message = `Export failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          /* non-JSON body; the status is all we have */
        }
        toast.error(message);
        return;
      }

      const blob = await res.blob();

      // Prefer the server's filename — it carries the date stamp the header set.
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `export.${format}`;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Released on the next tick; revoking synchronously can cancel the download in
      // some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast.success(`${filename} downloaded`);
    } catch {
      toast.error("Could not reach the server for that export.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size} loading={Boolean(busy)} className="screen-only">
          <Download />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Download as</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void download("xlsx")}>
          <FileSpreadsheet />
          Excel (.xlsx)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("csv")}>
          <Sheet />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("pdf")}>
          <FileText />
          PDF
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-2xs text-muted-foreground">
          Every file carries the period, branch and who generated it. Exports are recorded
          in the audit log.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
