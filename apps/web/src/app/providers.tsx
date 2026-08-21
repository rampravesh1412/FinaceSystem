import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionProvider } from "@/components/motion";
import { AuthProvider } from "@/features/auth/auth-context";
import { ApiError } from "@/lib/api";

/**
 * Query client configuration.
 *
 * The retry policy matters here: retrying a 401/403/404/422 is pointless and, on a
 * financial write, actively harmful — it turns one refused payment into four attempts in
 * the server log. Only genuine server and network faults are retried.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: {
        // A mutation is never retried automatically. A retried "create payment" that
        // actually succeeded the first time posts the money twice.
        retry: false,
      },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200} skipDelayDuration={300}>
        <MotionProvider>
          <AuthProvider>
            {children}
            <Toaster
              position="bottom-right"
              closeButton
              richColors
              toastOptions={{ classNames: { toast: "font-sans" } }}
            />
          </AuthProvider>
        </MotionProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
