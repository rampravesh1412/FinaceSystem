import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render, type RenderOptions } from "@testing-library/react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MotionProvider } from "@/components/motion";

/**
 * The provider stack a screen expects, minus the network.
 *
 * `AuthProvider` is deliberately NOT included — it performs a silent refresh on mount,
 * which every test would have to wait out. Tests that need a signed-in user mock the
 * `useAuth` hook instead, which is both faster and explicit about what identity is being
 * assumed.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // No retries in tests: a deliberate 4xx should fail the assertion immediately rather
      // than after three backoffs.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MotionProvider>
          <TooltipProvider>
            <MemoryRouter>{children}</MemoryRouter>
          </TooltipProvider>
        </MotionProvider>
      </QueryClientProvider>
    );
  }

  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}

/* ── Fake identity ───────────────────────────────────────────────────────── */

/**
 * Ids are real 24-character hex, not "b1".
 *
 * Every id crossing the wire is validated against an ObjectId pattern by the shared
 * schemas, so a fixture using a short placeholder fails validation before the request is
 * built — and the failure surfaces as a form that silently refuses to submit rather than
 * as anything resembling "bad test data". Realistic fixtures are not pedantry here; the
 * contract genuinely rejects the alternative.
 */
export const ID = {
  user: "6501aa000000000000000001",
  role: "6501aa000000000000000002",
  branch: "6501aa000000000000000003",
  branchB: "6501aa000000000000000004",
  party: "6501aa000000000000000005",
  account: "6501aa000000000000000006",
  head: "6501aa000000000000000007",
} as const;

export const TEST_USER = {
  id: ID.user,
  name: "Test Operator",
  email: "test@amiri.co",
  role: { id: ID.role, name: "SUPER_ADMIN", label: "Super Admin" },
  permissions: ["*"],
  branchIds: [ID.branch],
  branches: [{ id: ID.branch, name: "Head Office", code: "101" }],
  activeBranchId: ID.branch,
  isSuperAdmin: true,
  mustChangePassword: false,
  lastLoginAt: null,
};

/**
 * Auth is mocked PER TEST FILE, not by a helper here.
 *
 * `vi.mock` is hoisted above every other statement in a module, so it cannot close over a
 * helper's arguments — a `mockAuth(overrides)` function looks reasonable and throws
 * `overrides is not defined` at runtime. Each test file declares its own
 * `vi.mock("@/features/auth/auth-context", ...)` at module scope, which is also more
 * honest: the identity a test assumes is visible in the test.
 *
 * Permission gating is exercised by the API suite, where it is actually enforced. A
 * component test re-checking it would be testing the courtesy, not the control.
 */

/* ── Fake API ────────────────────────────────────────────────────────────── */

export interface ApiStub {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

/**
 * A stub for `@/lib/api`.
 *
 * Routes are matched by a substring of the path, which keeps the setup readable — a test
 * says `{"/parties": [...]}` rather than reconstructing the exact query string the
 * component happens to build. An unmatched path REJECTS rather than returning empty: a
 * silent `undefined` is how a test passes while the component is asking for the wrong
 * thing.
 */
export function stubApi(routes: Record<string, unknown>): ApiStub {
  const resolve = (path: string) => {
    const match = Object.keys(routes).find((key) => path.startsWith(key) || path.includes(key));
    if (match === undefined) {
      return Promise.reject(new Error(`No stub for ${path} — add one, or the test is lying`));
    }
    return Promise.resolve(routes[match]);
  };

  return {
    get: vi.fn((path: string) => resolve(path)),
    list: vi.fn((path: string) =>
      resolve(path).then((data) => ({
        items: Array.isArray(data) ? data : [],
        meta: { page: 1, limit: 25, total: Array.isArray(data) ? data.length : 0, totalPages: 1, hasNext: false, hasPrev: false },
      })),
    ),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  };
}
