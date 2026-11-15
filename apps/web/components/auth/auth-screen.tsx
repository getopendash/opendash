import type { ReactNode } from "react";
import { authSettings } from "@/lib/auth";
import { AuthHero } from "./auth-hero";
import { BrandLogo } from "./brand-logo";

/**
 * The shell every auth and onboarding screen shares (A–E): the hero on the left from lg up,
 * and the sheet with the logo, an optional line on the right, the form centred, and the footer. Below lg the sheet
 * runs full width.
 */
export async function AuthScreen({
  aside,
  hero = true,
  children,
}: {
  aside?: ReactNode;
  hero?: boolean;
  children: ReactNode;
}) {
  const settings = await authSettings();
  return (
    <div className="flex min-h-dvh bg-surface lg:h-dvh lg:gap-sheet-inset lg:bg-background lg:p-sheet-inset">
      {hero ? <AuthHero /> : null}
      <section
        className={`flex w-full flex-col px-4 py-5 lg:overflow-y-auto lg:rounded-sheet lg:border lg:border-border lg:bg-surface lg:px-6 ${
          hero ? "lg:w-120 lg:shrink-0 hd:w-auth-sheet" : ""
        }`}
      >
        <header className="flex items-center justify-between gap-4">
          <BrandLogo />
          {aside ? <div className="text-right text-body text-muted">{aside}</div> : null}
        </header>
        <main className="flex flex-1 items-start justify-center pt-12 pb-10 lg:items-center lg:py-12">
          <div className="w-full max-w-form">{children}</div>
        </main>
        <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-small text-muted">
          <nav className="flex flex-wrap gap-4">
            <span>© {new Date().getFullYear()} OpenDash</span>
            {settings.legal.map((l) => (
              <a key={l.label} href={l.href} className="hover:text-foreground">
                {l.label}
              </a>
            ))}
            {settings.help.map((h) => (
              <a key={h.id} href={h.href} className="hover:text-foreground">
                {h.label}
              </a>
            ))}
          </nav>
          {settings.edition === "community" ? <span>Community edition</span> : null}
        </footer>
      </section>
    </div>
  );
}
