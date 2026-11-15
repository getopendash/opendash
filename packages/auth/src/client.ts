// Browser client for the web app: sign-in, email links, two-factor, organizations and API keys.
import { apiKeyClient } from "@better-auth/api-key/client";
import { magicLinkClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    organizationClient({ teams: { enabled: true } }),
    apiKeyClient(),
    magicLinkClient(),
    // Two-factor sign-in; the sign-in form sends a password that needs the code to the code page.
    twoFactorClient(),
  ],
});
