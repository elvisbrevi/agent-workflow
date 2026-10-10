/** Read-only work inventory; delivery eligibility remains the coordinator's decision. */
export interface AssignedWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  /** Verified User Story parent, never an inferred HU from a title. */
  hu: number | null;
}

export interface AssignedWork {
  tracker: "github" | "azure";
  scope: string;
  items: AssignedWorkItem[];
  truncated: boolean;
}
