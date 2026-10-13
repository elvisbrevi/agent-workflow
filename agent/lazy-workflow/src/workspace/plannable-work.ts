/**
 * Work a plan slices, read at the tracker instead of in a repository: where it
 * is planned is chosen afterwards (ADR-0049). Read-only; publishing the plan
 * stays the coordinator's.
 */
export interface PlannableItem {
  id: number;
  title: string;
  /** `User Story`, `Product Backlog Item` or `Bug` in Azure; `Epic` on GitHub. */
  type: string;
  state: string;
  url: string;
  /** The Azure project, or the GitHub repository `owner/name`, the item belongs to. */
  scope: string;
}

export interface PlannableWork {
  tracker: "github" | "azure";
  items: PlannableItem[];
  truncated: boolean;
}

/** A repository a plan can be downloaded from or created in. */
export interface RemoteRepository {
  name: string;
  /** Azure project or GitHub owner. */
  scope: string;
  url: string;
  defaultBranch: string | null;
}

/** What `repo-clone` and `repo-create` leave behind: a checkout ready to be registered and planned in. */
export interface ProvisionedRepository {
  tracker: "github" | "azure";
  /** Azure project or GitHub owner. */
  scope: string;
  repository: string;
  destination: string;
  remote: string;
  created: boolean;
}
