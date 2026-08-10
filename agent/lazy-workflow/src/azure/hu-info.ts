export interface HuInfoData {
  id: number;
  title?: string;
  description?: string;
  criterioDeAceptacion?: string;
  state?: string;
  project?: string;
  assignedTo?: unknown;
  desarrollador?: string;
}

export class HuInfo {
  readonly id!: number;
  readonly title?: string;
  readonly description?: string;
  readonly criterioDeAceptacion?: string;
  readonly state?: string;
  readonly project?: string;
  readonly assignedTo?: unknown;
  readonly desarrollador?: string;

  constructor(data: HuInfoData) {
    Object.assign(this, data);
  }
}
