import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Lock, MoreHorizontal, Pencil, TriangleAlert } from "lucide-react";
import {
  formatINR,
  updatePartySchema,
  type PartySummary,
  type UpdatePartyInput,
} from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/features/auth/auth-context";
import { AmountField, NotesField, SelectField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Edit a party (§8, §25).
 *
 * Two fields are deliberately absent, and the form says why rather than silently dropping
 * them:
 *
 *   - **Branch.** Moving a party between branches would move their historical ledger
 *     entries out from under the branch that posted them, breaking that branch's trial
 *     balance.
 *   - **Opening balance.** It is a posted transaction, not a field. Correcting it means
 *     posting an Adjustment, which leaves both the original and the correction on the
 *     record.
 *
 * Everything else — contact details, credit terms, status — is ordinary editable data.
 */
export function PartyRowActions({ party }: { party: PartySummary }) {
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);

  if (!can("parties.edit")) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${party.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil />
            Edit details
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editing ? <EditPartyDialog party={party} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function EditPartyDialog({ party, onClose }: { party: PartySummary; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<UpdatePartyInput>({
    resolver: zodResolver(updatePartySchema),
    defaultValues: {
      name: party.name,
      code: party.code,
      type: party.type as never,
      mobile: party.mobile ?? "",
      email: party.email ?? "",
      city: party.city ?? "",
      gstin: party.gstin ?? "",
      creditLimit: party.creditLimit,
      status: party.status as never,
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: UpdatePartyInput) => api.patch<PartySummary>(`/parties/${party.id}`, values),
    onSuccess: async () => {
      toast.success(`${party.name} updated`);
      await queryClient.invalidateQueries({ queryKey: ["parties"] });
      await queryClient.invalidateQueries({ queryKey: ["khata"] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not update the party.");
    },
  });

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {party.name}</DialogTitle>
          <DialogDescription>
            Their ledger account and everything posted against it are untouched by this.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((values) => {
            setFormError(null);
            mutation.mutate(values);
          })}
          className="space-y-4"
          noValidate
        >
          <Tabs defaultValue="identity">
            <TabsList>
              <TabsTrigger value="identity">Identity</TabsTrigger>
              <TabsTrigger value="contact">Contact</TabsTrigger>
              <TabsTrigger value="terms">Credit</TabsTrigger>
            </TabsList>

            <TabsContent value="identity" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="name" label="Party name" required />
                <TextField form={form} name="code" label="Code" className="font-mono" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField
                  form={form}
                  name="type"
                  label="Type"
                  options={[
                    { value: "CUSTOMER", label: "Customer" },
                    { value: "VENDOR", label: "Vendor" },
                    { value: "DISTRIBUTOR", label: "Distributor" },
                    { value: "AGENT", label: "Agent" },
                    { value: "EMPLOYEE", label: "Employee" },
                    { value: "OTHER", label: "Other" },
                  ]}
                />
                <SelectField
                  form={form}
                  name="status"
                  label="Status"
                  hint="An inactive party cannot be selected for new transactions."
                  options={[
                    { value: "ACTIVE", label: "Active" },
                    { value: "INACTIVE", label: "Inactive" },
                    { value: "BLOCKED", label: "Blocked" },
                  ]}
                />
              </div>

              <TextField form={form} name="gstin" label="GSTIN" className="uppercase" />
            </TabsContent>

            <TabsContent value="contact" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField form={form} name="mobile" label="Mobile" inputMode="numeric" />
                <TextField form={form} name="email" label="Email" type="email" />
              </div>
              <TextField form={form} name="city" label="City" />
              <NotesField form={form} name="notes" label="Notes" />
            </TabsContent>

            <TabsContent value="terms" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <AmountField
                  form={form}
                  name="creditLimit"
                  label="Credit limit"
                  hint="0 means no limit."
                />
                <TextField
                  form={form}
                  name="creditDays"
                  label="Credit days"
                  inputMode="numeric"
                  registerOptions={{ valueAsNumber: true }}
                />
              </div>

              <Separator />

              {/* Stated, not silently omitted. An operator looking for the opening balance
                  field needs to know where it went and what to do instead (§25, §62). */}
              <div className="space-y-2 rounded-md border border-border bg-surface-muted/40 p-3 text-xs">
                <p className="flex items-start gap-2">
                  <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">Branch</span> and{" "}
                    <span className="font-medium text-foreground">opening balance</span> cannot be
                    changed here.
                  </span>
                </p>
                <p className="pl-5 text-muted-foreground">
                  Moving them to another branch would take their posted entries out from under
                  the branch that recorded them. The opening balance is a real transaction —
                  their balance is currently{" "}
                  <span className="font-medium text-foreground">
                    {formatINR(Math.abs(party.balance))} {party.direction}
                  </span>
                  ; correct it with an Adjustment, which leaves both the original and the
                  correction on the record.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {formError ? (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
              <span>{formError}</span>
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
