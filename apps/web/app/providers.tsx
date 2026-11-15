"use client";

import { RouterProvider, Toast } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  // One query client per browser session (not per render): the typed API's cache.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } }));
  return (
    <ThemeProvider attribute={["class", "data-theme"]} defaultTheme="system" enableSystem disableTransitionOnChange>
      {/* react-aria links (table rows, menu items) navigate through Next's router instead of reloading the page. */}
      <QueryClientProvider client={queryClient}>
        <RouterProvider navigate={(href) => router.push(href)}>
          {children}
          <Toast.Provider placement="bottom end" />
        </RouterProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
