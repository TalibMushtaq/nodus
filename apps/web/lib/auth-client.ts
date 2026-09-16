// Client-side auth gateway, now a thin binding over @repo/sdk.
//
// The session itself lives in the HttpOnly cookie managed server-side; the SDK
// adapter targets the /api/auth/* BFF proxies, so no token ever reaches the
// browser JS context. Kept as named exports so existing callers (AuthProvider,
// recovery flow) are unchanged.

import { createAuthClient, type AuthResult, type SessionInfo } from "@repo/sdk";

import { createWebRelayHttp } from "./adapters";

const client = createAuthClient(createWebRelayHttp());

export type { AuthResult, SessionInfo };

export const login = client.login;
export const register = client.register;
export const logout = client.logout;
export const fetchSession = client.fetchSession;
export const changePassword = client.changePassword;
export const logoutAll = client.logoutAll;
