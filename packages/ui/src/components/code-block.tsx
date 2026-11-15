"use client";

import { Button } from "@heroui/react";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * Read-only code with a copy button (Code Block): SQL to run, a query behind a figure. `wrap`
 * wraps long lines instead of scrolling them, for narrow places like the Sources panel.
 */
export function CodeBlock({ code, label = "Copy", wrap = false }: { code: string; label?: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-xl border border-border bg-surface-secondary">
      <pre
        className={`py-2.5 pr-10 pl-3 font-mono text-small leading-relaxed text-foreground ${wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto"}`}
      >
        <code>{code}</code>
      </pre>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={copied ? "Copied" : label}
        className="absolute top-1.5 right-1.5"
        onPress={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard refused (permissions, insecure context): the text is still selectable.
          }
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy className="text-muted" />}
      </Button>
    </div>
  );
}
