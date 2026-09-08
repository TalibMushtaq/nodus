"use client";

import { useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { Section } from "@repo/ui/primitives/section";
import { EmptyState } from "@repo/ui/primitives/empty-state";
import { PairingModal } from "@repo/ui/domain/pairing-modal";
import { NodeRow } from "@repo/ui/domain/node-row";
import { DeviceRow } from "@repo/ui/domain/device-row";
import { nodes, devices } from "../../../lib/mock-data";

export default function DevicesPage() {
  const [showPairModal, setShowPairModal] = useState(false);

  return (
    <div className="space-y-6 p-6">
      {/* Storage Nodes */}
      <Section title="Storage nodes" action={<Button variant="secondary" size="sm">Manage all</Button>}>
        <div className="border border-border rounded-xl overflow-hidden bg-card">
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} onManage={() => {}} />
          ))}
        </div>
      </Section>

      {/* Client Devices */}
      <Section
        title="Client devices"
        action={<Button variant="secondary" size="sm" onClick={() => setShowPairModal(true)}>+ Pair new</Button>}
      >
        {devices.length === 0 ? (
          <EmptyState title="No paired devices" description="Pair your first device to sync files across your network." action={<Button variant="primary" size="sm" onClick={() => setShowPairModal(true)}>Pair a device</Button>} />
        ) : (
          <div className="border border-border rounded-xl overflow-hidden bg-card">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} onRevoke={() => {}} />
            ))}
          </div>
        )}
      </Section>

      {showPairModal && <PairingModal onClose={() => setShowPairModal(false)} />}
    </div>
  );
}