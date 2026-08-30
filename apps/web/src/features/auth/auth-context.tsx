import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hasPermission, type Permission, type SessionUser } from "@amiri/shared";
import { ApiError, api, setAccessToken, setUnauthenticatedHandler } from "@/lib/api";

/**
 * Authentication state.
 *
 * The access token lives in a module closure inside `lib/api`, not here and not in
 * localStorage. This context holds only the *user*, which is not a credential.
 *
 * On mount it attempts a silent refresh against the httpOnly cookie. That is what makes a
 * page reload keep the user signed in without ever persisting a token where a script
 * could read it.
 */

interface AuthState {
  user: SessionUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  /** Permission check, matching the server's `requirePermission` exactly. */
  can: (permission: Permission) => boolean;
  canAny: (...permissions: Permission[]) => boolean;
}

const AuthContext = React.createContext<AuthState | null>(null);

interface LoginResponse {
  user: SessionUser;
  accessToken: string;
  expiresIn: number;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [status, setStatus] = React.useState<AuthState["status"]>("loading");
  const queryClient = useQueryClient();

  const clearSession = React.useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus("unauthenticated");
    // Cached branch/user lists belong to the session that fetched them. Leaving them
    // would briefly show the previous user's data to the next one on a shared machine.
    queryClient.clear();
  }, [queryClient]);

  React.useEffect(() => {
    setUnauthenticatedHandler(clearSession);
    return () => setUnauthenticatedHandler(null);
  }, [clearSession]);

  // Silent restore on first load.
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      const refreshed = await api.refresh();
      if (cancelled) return;

      if (!refreshed) {
        setStatus("unauthenticated");
        return;
      }

      try {
        const me = await api.get<SessionUser>("/auth/me");
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch {
        if (!cancelled) setStatus("unauthenticated");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Proactive token refresh.
   *
   * The access token lives 15 minutes. Refreshing at 12 means a user working through a
   * long data-entry form never has a save fail with a 401 and lose their input — which is
   * the difference between a security control and a usability defect.
   */
  React.useEffect(() => {
    if (status !== "authenticated") return;
    const timer = setInterval(() => void api.refresh(), 12 * 60 * 1000);
    return () => clearInterval(timer);
  }, [status]);

  const login = React.useCallback(async (email: string, password: string) => {
    const result = await api.post<LoginResponse>("/auth/login", { email, password });
    setAccessToken(result.accessToken);
    setUser(result.user);
    setStatus("authenticated");
    return result.user;
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // Signing out must succeed locally even if the server call fails — otherwise a
      // network blip leaves a session open on a shared terminal.
    }
    clearSession();
  }, [clearSession]);

  const switchBranch = React.useCallback(
    async (branchId: string) => {
      const updated = await api.post<SessionUser>("/auth/switch-branch", { branchId });
      setUser(updated);
      // Every cached list is branch-scoped, so all of it is stale after a switch.
      await queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const refreshUser = React.useCallback(async () => {
    try {
      setUser(await api.get<SessionUser>("/auth/me"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) clearSession();
    }
  }, [clearSession]);

  const can = React.useCallback(
    (permission: Permission) => (user ? hasPermission(user.permissions, permission) : false),
    [user],
  );

  const canAny = React.useCallback(
    (...permissions: Permission[]) =>
      user ? permissions.some((p) => hasPermission(user.permissions, p)) : false,
    [user],
  );

  const value = React.useMemo<AuthState>(
    () => ({ user, status, login, logout, switchBranch, refreshUser, can, canAny }),
    [user, status, login, logout, switchBranch, refreshUser, can, canAny],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  return ctx;
}

/**
 * Conditional rendering by permission.
 *
 * This hides a control the user cannot use. It is NOT a security boundary — the server
 * enforces the same permission on the route. Hiding is purely so the interface does not
 * offer actions that will be refused.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : fallback}</>;
}
