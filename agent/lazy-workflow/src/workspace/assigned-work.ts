/** Read-only work inventory; delivery eligibility remains the coordinator's decision. */
export interface AssignedWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  url: string;
  /** Verified HU parent — a story, or a Bug planned on its own — never an HU inferred from a title. */
  hu: number | null;
}

export interface AssignedWork {
  tracker: "github" | "azure";
  scope: string;
  items: AssignedWorkItem[];
  truncated: boolean;
}
