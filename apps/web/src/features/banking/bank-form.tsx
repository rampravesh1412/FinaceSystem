import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus, TriangleAlert } from "lucide-react";
import { createBankSchema, type BankSummary, type CreateBankInput } from "@amiri/shared";
import { ApiError, api } from "@/lib/api";
import { NotesField, TextField, applyServerErrors } from "@/components/form";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Add a bank (§7).
 *
 * A bank is an institution, not an account — HDFC, not "HDFC Current 7890". Nothing here
 * touches the ledger; the ledger account is created per bank ACCOUNT, which is why this
 * form has no opening balance and the account form does.
 */
export function NewBankButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Plus />
        Add bank
      </Button>
      <BankDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function BankDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<CreateBankInput>({
    resolver: zodResolver(createBankSchema),
    defaultValues: {
      name: "", shortName: "", ifscPrefix: "",
      contactPerson: "", phone: "", email: "",
      status: "ACTIVE", notes: "",
    } as never,
  });

  const mutation = useMutation({
    mutationFn: (values: CreateBankInput) => api.post<BankSummary>("/banks", values),
    onSuccess: async (bank) => {
      toast.success(`${bank.name} added`, {
        description: "Open an account under it to start recording transactions.",
      });
      await queryClient.invalidateQueries({ queryKey: ["banks"] });
      form.reset();
      onOpenChange(false);
    },
    onError: (error) => {
      setFormError(applyServerErrors(form, error));
      toast.error(error instanceof ApiError ? error.message : "Could not add the bank.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a bank</DialogTitle>
          <DialogDescription>
            The institution itself. Accounts, balances and transactions hang off it.
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
          <TextField form={form} name="name" label="Bank name" required placeholder="HDFC Bank" />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="shortName"
              label="Short name"
              hint="Used wherever space is tight — statements, tiles, exports."
              placeholder="HDFC"
              className="uppercase"
            />
            <TextField
              form={form}
              name="ifscPrefix"
              label="IFSC prefix"
              hint="The first four letters. Validates account IFSCs against the right bank."
              placeholder="HDFC"
              maxLength={4}
              className="font-mono uppercase"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="contactPerson" label="Relationship manager" />
            <TextField form={form} name="phone" label="Phone" inputMode="numeric" />
          </div>

          <TextField form={form} name="email" label="Email" type="email" />
          <NotesField form={form} name="notes" label="Notes" />

          {formError ? <FormError message={formError} /> : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={mutation.isPending}>
              Add bank
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FormError({ message }: { message: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
      <span>{message}</span>
    </p>
  );
}
