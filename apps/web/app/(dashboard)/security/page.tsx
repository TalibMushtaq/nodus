"use client";

import { useState } from "react";
import { Section } from "@repo/ui/primitives/section";
import { RecoveryKeyCard } from "@repo/ui/domain/recovery-key-card";
import { KeyEnvelopeTable } from "@repo/ui/domain/key-envelope-table";
import { DeviceRevocationList } from "@repo/ui/domain/device-revocation-list";
import { NetworkTopology } from "@repo/ui/domain/network-topology";
import { keyEnvelopes, revocationList } from "../../../lib/mock-data";

export default function SecurityPage() {
  const [revoked, setRevoked] = useState<string[]>([]);

  return (
    <div className="space-y-6 p-6">
      <Section title="Recovery seed">
        <RecoveryKeyCard />
      </Section>

      <Section title="Key envelopes">
        <KeyEnvelopeTable envelopes={keyEnvelopes} />
      </Section>

      <Section title="Paired devices">
        <DeviceRevocationList
          devices={revocationList.filter((d) => !revoked.includes(d.id))}
          onRevoke={(id) => setRevoked((prev) => [...prev, id])}
        />
      </Section>

      <Section title="Network topology">
        <NetworkTopology />
      </Section>
    </div>
  );
}