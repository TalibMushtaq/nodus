"use client";

import { useState } from "react";
import { FilterChips } from "@repo/ui/primitives/filter-chips";
import { ActivityTable } from "@repo/ui/domain/activity-table";
import { recentActivity, activityFilters } from "../../../lib/mock-data";

export default function ActivityPage() {
  const [activeFilter, setActiveFilter] = useState("Uploads");

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
        <FilterChips options={activityFilters} value={activeFilter} onChange={setActiveFilter} />
      </div>
      <ActivityTable events={recentActivity} activeFilter={activeFilter} />
    </div>
  );
}