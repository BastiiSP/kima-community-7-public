"use client";

import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { authFetch } from "@/lib/community-client";

export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
  fetchOptions: { customFetchImpl: authFetch, retry: 0 },
});
