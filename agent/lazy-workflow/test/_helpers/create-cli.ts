/**
 * El único sitio que conoce el orden de las fronteras del `LazyWorkflowCli`.
 *
 * El CLI recibe sus 23 fronteras por posición, así que un test que solo quiere
 * sustituir el coordinador de la cola tenía que contar las trece anteriores y
 * escribirlas como `undefined`. Ese conteo no dice nada sobre lo que el test
 * verifica y se rehace en cada sitio de construcción, de modo que agregar una
 * frontera nueva obligaba a revisarlos todos.
 *
 * Aquí el orden se declara una vez y cada test nombra solo la frontera que
 * sustituye. Una frontera omitida llega al constructor como `undefined`, que es
 * exactamente lo que recibía antes: el CLI aplica su propio default y las cuatro
 * fronteras del coordinador GitHub siguen distinguiendo «ausente» de «inyectada»
 * como siempre.
 *
 * Agregar una frontera al CLI es agregar una propiedad aquí y su posición en la
 * llamada de abajo. Ningún test se entera.
 */
import { LazyWorkflowCli } from "../../src/cli/lazy-workflow-cli.ts";

/** Los tipos vienen del constructor mismo, para que no puedan quedar desfasados. */
type Boundary = ConstructorParameters<typeof LazyWorkflowCli>;

export interface CliBoundaries {
  huInfoService?: Boundary[0];
  agentSource?: Boundary[1];
  checkpointStore?: Boundary[2];
  retryTimer?: Boundary[3];
  ticketBranchCleaner?: Boundary[4];
  clock?: Boundary[5];
  sagNormsService?: Boundary[6];
  git?: Boundary[7];
  githubTracker?: Boundary[8];
  deploymentService?: Boundary[9];
  infrastructureService?: Boundary[10];
  cliParser?: Boundary[11];
  createReporterFn?: Boundary[12];
  githubManagedQueue?: Boundary[13];
  githubCheckpointStore?: Boundary[14];
  githubRepositoryLock?: Boundary[15];
  githubDelivery?: Boundary[16];
  githubParentReconciliation?: Boundary[17];
  azureWorkspaceCheckpoint?: Boundary[18];
  deterministicToolServices?: Boundary[19];
  createQuestionChannelFn?: Boundary[20];
  processSignals?: Boundary[21];
  systemShutdown?: Boundary[22];
}

/**
 * La frontera `git` por defecto, que nunca es la del repositorio real.
 *
 * Una corrida sin `--working-directory` cae en `process.cwd()`, que durante el
 * suite es este mismo repositorio, y el flujo de planificación commitea lo que
 * encuentre ahí: el historial acumuló varios `lazy-workflow: commit
 * documentation from planning session` que ningún operador pidió. Un test que
 * necesite git de verdad lo inyecta; ninguno lo obtiene por omisión.
 */
const inertGit = async (): Promise<string> => "";

/** Un CLI con sus defaults, salvo las fronteras que este test nombra. */
export function createCli(boundaries: CliBoundaries = {}): LazyWorkflowCli {
  return new LazyWorkflowCli(
    boundaries.huInfoService,
    boundaries.agentSource,
    boundaries.checkpointStore,
    boundaries.retryTimer,
    boundaries.ticketBranchCleaner,
    boundaries.clock,
    boundaries.sagNormsService,
    boundaries.git ?? inertGit,
    boundaries.githubTracker,
    boundaries.deploymentService,
    boundaries.infrastructureService,
    boundaries.cliParser,
    boundaries.createReporterFn,
    boundaries.githubManagedQueue,
    boundaries.githubCheckpointStore,
    boundaries.githubRepositoryLock,
    boundaries.githubDelivery,
    boundaries.githubParentReconciliation,
    boundaries.azureWorkspaceCheckpoint,
    boundaries.deterministicToolServices,
    boundaries.createQuestionChannelFn,
    boundaries.processSignals,
    boundaries.systemShutdown,
  );
}
