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

export interface HuInfoData {
  id: number;
  /** `System.WorkItemType`: a User Story, a Product Backlog Item or a Bug. */
  type?: string;
  /** The direct parent's id, when the HU hangs from another work item. */
  parent?: number | null;
  title?: string;
  description?: string;
  criterioDeAceptacion?: string;
  state?: string;
  project?: string;
  assignedTo?: unknown;
  desarrollador?: unknown;
  iteration?: string;
}

export class HuInfo {
  readonly id!: number;
  readonly type?: string;
  readonly parent?: number | null;
  readonly title?: string;
  readonly description?: string;
  readonly criterioDeAceptacion?: string;
  readonly state?: string;
  readonly project?: string;
  readonly assignedTo?: unknown;
  readonly desarrollador?: unknown;
  readonly iteration?: string;

  constructor(data: HuInfoData) {
    Object.assign(this, data);
  }
}
