export const MODES = ["all-global", "claude-global", "claude-local", "global", "local", "opencode", "both", "codex"] as const;
export type Mode = typeof MODES[number];
export interface Options {
  mode?: Mode;
  target: string;
  ref: string;
  dryRun: boolean;
  force: boolean;
  uninstall: boolean;
  noGui: boolean;
  help: boolean;
}

export const USAGE = `Uso: install.sh / install.ps1 [OPCIONES]

Instala las skills, agentes, CLI y GUI de agent-workflow.
  --all-global       Todas las integraciones globales, CLI y GUI
  --claude-global    Skills, agentes Claude, CLI y GUI globales
  --claude-local     Skills, agentes Claude y CLI en el proyecto
  --global           ~/.agents/skills y ~/.agents/agents
  --local            .agents/ del proyecto
  --opencode         .opencode/ del proyecto
  --both             .agents/ y .opencode/ del proyecto
  --codex            Skills en CODEX_HOME (default: ~/.codex)
  --target D         Proyecto (default: cwd)
  --ref REF          Rama o tag (default: main)
  --dry-run          Muestra lo que haria sin cambiar la instalacion ni el cache
  --force            Reemplaza rutas existentes sin preguntar
  --uninstall        Retira las entradas gestionadas del modo elegido
  --no-gui           Omite la GUI
  -h, --help         Muestra esta ayuda`;

export function parseOptions(args: string[], cwd: string): Options {
  const options: Options = { target: cwd, ref: "main", dryRun: false, force: false, uninstall: false, noGui: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (MODES.includes(arg.slice(2) as Mode) && arg.startsWith("--")) options.mode = arg.slice(2) as Mode;
    else if (arg === "--target" || arg === "--ref") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requiere un valor`);
      options[arg === "--target" ? "target" : "ref"] = value;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--no-gui") options.noGui = true;
    else if (arg === "--help" || arg === "-h") { options.help = true; break; }
    else throw new Error(`Opcion desconocida: ${arg}. Usa --help para ver la ayuda.`);
  }
  return options;
}

export type Destination = { kind: "skills" | "agents" | "claude-agents" | "runners"; path: string };
