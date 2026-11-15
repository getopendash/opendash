"use client";

import { Button, Description, Input, Label, Modal, TextField, toast } from "@heroui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Info, Lock } from "lucide-react";
import { useState } from "react";
import { api, apiQueries } from "@/lib/api";
import { mcpMessage } from "./shared";

/**
 * Adding or replacing an API key: a person's own, or (an admin) the one everyone uses. The key is
 * tested first (its tools listed, nothing called) and kept only if the server takes it; only its last four show after.
 */
export function KeyDialog({
  server,
  shared,
  replacing,
  onClose,
  onSaved,
}: {
  server: { id: string; name: string; keyHint: string | null };
  /** The one key everyone uses (admins), rather than the person's own. */
  shared: boolean;
  replacing: boolean;
  onClose: () => void;
  /** After a key was tested and kept. */
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = `${replacing ? "Replace" : "Add"} ${shared ? "the key everyone uses for" : "your"} ${server.name}${shared ? "" : " key"}`;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const put = await api.mcp.putKey({ serverId: server.id, key: key.trim() });
      await queryClient.invalidateQueries({ queryKey: apiQueries.mcp.key() });
      toast.success(`${server.name}: key ${put.label} works (${put.tools} tools).`);
      onClose();
      onSaved?.();
    } catch (e) {
      setError(mcpMessage(e, "That key couldn't be tested. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
        <Modal.Container size="md">
          <Modal.Dialog aria-label={title}>
            <Modal.CloseTrigger />
            <Modal.Header className="border-b border-border pb-3">
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 pt-3">
              <p className="text-small text-muted">
                {shared
                  ? `Everyone's calls to ${server.name} use this key. Use a read-only key if the service has them.`
                  : `${server.name} needs a key. Yours is used only when you ask something, and only for you.`}
              </p>
              {server.keyHint ? (
                <div className="flex items-start gap-2.5 rounded-xl bg-surface-secondary px-3.5 py-2.5">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-small font-medium">Where to find it</span>
                    <span className="text-small text-muted">{server.keyHint}</span>
                  </span>
                </div>
              ) : null}
              <TextField className="w-full" value={key} onChange={setKey} isDisabled={busy}>
                <Label>{shared ? "Header value" : "Your header value"}</Label>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-small"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !busy && key.trim().length > 0) void save();
                  }}
                />
                <Description>Tested before it's kept: its tools are listed and nothing is called.</Description>
              </TextField>
              {error ? <p className="text-small text-danger wrap-anywhere">{error}</p> : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center gap-2 border-t border-border pt-3">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-micro text-muted-tertiary">
                <Lock className="size-3" aria-hidden />
                Stored encrypted. {shared ? "Replace or remove it on the server's page." : "Remove it any time."}
              </span>
              <Button size="sm" variant="ghost" onPress={onClose}>
                Cancel
              </Button>
              <Button size="sm" isDisabled={key.trim().length === 0} isPending={busy} onPress={() => void save()}>
                Test and save
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
