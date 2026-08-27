/**
 * La frontera de cola que un test de planificacion necesita.
 *
 * Un `plan` GitHub lee la numeracion de Issues antes de abrir la sesion y
 * aplica `ready-for-agent` a lo que la sesion publique. Un test que solo mira
 * el prompt, el Reportador o la entrevista no quiere `gh` real: inyecta esta
 * frontera, que responde una marca fija y registra lo que se etiquetaria.
 */
import type {
  GitHubManagedQueueAdapter,
  ManagedQueueOutcome,
  ManagedQueueWatermark,
} from "../../src/github/managed-queue-service.ts";

export interface PlanTriageQueue extends GitHubManagedQueueAdapter {
  /** Los directorios sobre los que se aplico el rol, en orden. */
  applied: string[];
}

export function planTriageQueue(latestIssue = 0, labeled: number[] = []): PlanTriageQueue {
  const applied: string[] = [];
  return {
    applied,
    async selectAndClaimEligibleIssue(): Promise<ManagedQueueOutcome> {
      throw new Error("un plan no selecciona trabajo de la cola");
    },
    async readQueueWatermark(): Promise<ManagedQueueWatermark> {
      return { latestIssue };
    },
    async applyReadyForAgentRole(_watermark, workingDirectory): Promise<number[]> {
      applied.push(workingDirectory);
      return labeled;
    },
  };
}
