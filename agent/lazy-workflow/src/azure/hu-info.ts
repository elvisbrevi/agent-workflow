/**
 * The work item types a plan slices into delivery Tasks and Bugs, and a
 * `code --hu` drains: a User Story or Product Backlog Item, or a Bug that is
 * not itself the delivery ticket of one (ADR-0047). The run vocabulary keeps
 * calling all of them the HU.
 */
export const HU_WORK_ITEM_TYPES: ReadonlySet<string> = new Set(["User Story", "Product Backlog Item", "Bug"]);

/** The types a Bug's own parent must not have for the Bug to be planned: it would be that HU's ticket. */
export const STORY_WORK_ITEM_TYPES: ReadonlySet<string> = new Set(["User Story", "Product Backlog Item"]);

/**
 * The state an HU reaches once no delivery child is left open: the story's
 * `Desarrollo Terminado`, or `En revisión` for a Bug, whose own workflow has
 * no development-finished state of its own and stops short of `Done` so a
 * person verifies the fix.
 */
export function developedState(type: string | null | undefined): string {
  return type === "Bug" ? "En revisión" : "Desarrollo Terminado";
}

/** One comment of the work item's discussion, as a person wrote it. */
export interface HuComment {
  author?: string;
  date?: string;
  /** Azure stores it as HTML or Markdown, like the description. */
  text: string;
}

export interface HuInfoData {
  id: number;
  /** `System.WorkItemType`: a User Story, a Product Backlog Item or a Bug. */
  type?: string;
  /** The direct parent's id, when the HU hangs from another work item. */
  parent?: number | null;
  title?: string;
  description?: string;
  criterioDeAceptacion?: string;
  /** A Bug's own description fields: where a Bug says what is wrong, often instead of its description. */
  reproSteps?: string;
  systemInfo?: string;
  state?: string;
  project?: string;
  assignedTo?: unknown;
  desarrollador?: unknown;
  iteration?: string;
  /**
   * The discussion, oldest first. A plan session cannot read Azure, so what it
   * is not handed here — a correction asked for in a later comment — it never
   * learns.
   */
  comments?: HuComment[];
}

export class HuInfo {
  readonly id!: number;
  readonly type?: string;
  readonly parent?: number | null;
  readonly title?: string;
  readonly description?: string;
  readonly criterioDeAceptacion?: string;
  readonly reproSteps?: string;
  readonly systemInfo?: string;
  readonly state?: string;
  readonly project?: string;
  readonly assignedTo?: unknown;
  readonly desarrollador?: unknown;
  readonly iteration?: string;
  readonly comments?: HuComment[];

  constructor(data: HuInfoData) {
    Object.assign(this, data);
  }
}
