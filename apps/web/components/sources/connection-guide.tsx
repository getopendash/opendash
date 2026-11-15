"use client";

import { Button, Modal } from "@heroui/react";
import { CodeBlock } from "@opendash/ui";
import { BookOpen } from "lucide-react";
import { type ConnectKind, readOnlyUserSql } from "./read-only-sql";

/** "Connection guide" in the connect steps' top bar: what to prepare on the database side before connecting. */
export function ConnectionGuide({ egress, kind = "postgres" }: { egress: string[]; kind?: ConnectKind }) {
  return (
    <Modal>
      <Button size="sm" variant="ghost" className="gap-1.5">
        <BookOpen className="size-3.5" aria-hidden />
        Connection guide
      </Button>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Connection guide</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5 text-body">
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">1. Create a read-only user</h3>
                <p className="text-muted">
                  {kind === "postgres"
                    ? "OpenDash only reads. Run this as an admin, then grant SELECT on any other schemas you want to ask about."
                    : "OpenDash only reads. Run this as an admin, then grant SELECT on any other databases you want to ask about."}
                </p>
                <CodeBlock code={readOnlyUserSql(kind)} label="Copy SQL" />
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">2. Let OpenDash reach the database</h3>
                <p className="text-muted">
                  {egress.length
                    ? `Allow ${egress.join(" and ")} on your firewall or IP allowlist. OpenDash Cloud always connects from these addresses.`
                    : "OpenDash connects from the server it runs on. Make sure that server can reach the database's host and port."}
                </p>
              </section>
              <section className="flex flex-col gap-2">
                <h3 className="font-medium">3. Choose an SSL mode</h3>
                {kind === "clickhouse" ? (
                  <ul className="flex flex-col gap-1 text-muted">
                    <li>
                      <span className="font-medium text-foreground">verify-full</span>: HTTPS with the certificate
                      checked against the host name. The default, and what ClickHouse Cloud needs (port 8443).
                    </li>
                    <li>
                      <span className="font-medium text-foreground">require</span>: HTTPS without checking the
                      certificate.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">disable</span>: plain HTTP (usually port 8123). Only
                      on a private network.
                    </li>
                  </ul>
                ) : (
                  <ul className="flex flex-col gap-1 text-muted">
                    <li>
                      <span className="font-medium text-foreground">require</span>: encrypted. The default, and what
                      most managed databases need.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">verify-full</span>: encrypted, and the certificate
                      is checked against the host name. Needs a publicly trusted certificate.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">disable</span>: no encryption. Only on a private
                      network.
                    </li>
                  </ul>
                )}
              </section>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="outline">
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
