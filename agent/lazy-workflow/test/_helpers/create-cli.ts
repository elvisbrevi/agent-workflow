/**
 * El único sitio que conoce el orden de las fronteras del `LazyWorkflowCli`.
 *
 * El CLI recibe sus fronteras por posición, así que un test que solo quiere
 * sustituir el coordinador de la cola tenía que contar las anteriores y
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
  /**
   * La frontera Azure, que un test nombra por lo que su caso usa.
   *
   * `AzureBoundary` exige `createTicket`, `linkParent` y `linkPredecessor` —las primitivas de
   * publicación de ADR-0022— además de las dos de lectura, mientras que todo el resto de sus
   * operaciones es opcional. Un test del camino GitHub que solo declara `getHuInfo` y
   * `waitForAccess` no dejaba de compilar por ninguna razón suya: las tres que le faltaban no las
   * llama nadie en su escenario. Aquí se aceptan parciales y se completan abajo con stubs que
   * explotan, que es lo que un test que las tocara sin querer debería obtener.
   */
  huInfoService?: Partial<NonNullable<Boundary[0]>>;
  agentSource?: Boundary[1];
  checkpointStore?: Boundary[2];
  retryTimer?: Boundary[3];
  ticketBranchCleaner?: Boundary[4];
  clock?: Boundary[5];
  sagNormsService?: Boundary[6];
  git?: Boundary[7];
  cliParser?: Boundary[8];
  createReporterFn?: Boundary[9];
  githubManagedQueue?: Boundary[10];
  githubCheckpointStore?: Boundary[11];
  githubRepositoryLock?: Boundary[12];
  githubDelivery?: Boundary[13];
  githubParentReconciliation?: Boundary[14];
  azureWorkspaceCheckpoint?: Boundary[15];
  deterministicToolServices?: Boundary[16];
  createQuestionChannelFn?: Boundary[17];
  processSignals?: Boundary[18];
  systemShutdown?: Boundary[19];
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

/**
 * Las primitivas de publicación que `AzureBoundary` exige, para un test que no publica nada.
 *
 * Delega en vez de copiar. Un test inyecta a veces una instancia de clase para probar justamente
 * que el receptor sobrevive al llegar a la herramienta (issue #256), y un `{ ...azure }` se lleva
 * solo las propiedades propias: los métodos del prototipo desaparecerían y `this` se perdería. El
 * proxy reenvía todo lo que la frontera trae —ligado a ella— y solo responde por las tres que no
 * están.
 */
function withAzurePublication(azure: Partial<NonNullable<Boundary[0]>>): Boundary[0] {
  const unpublished = (name: string) => async (): Promise<never> => {
    throw new Error(`este test no publica en Azure: ${name} no está inyectado`);
  };
  const publication: Record<string, unknown> = {
    createTicket: unpublished("createTicket"),
    linkParent: unpublished("linkParent"),
    linkPredecessor: unpublished("linkPredecessor"),
  };
  return new Proxy(azure, {
    get(target, property, receiver) {
      if (!(property in target)) return publication[property as string];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return property in target || property in publication;
    },
  }) as NonNullable<Boundary[0]>;
}

/** Un CLI con sus defaults, salvo las fronteras que este test nombra. */
export function createCli(boundaries: CliBoundaries = {}): LazyWorkflowCli {
  return new LazyWorkflowCli(
    boundaries.huInfoService && withAzurePublication(boundaries.huInfoService),
    boundaries.agentSource,
    boundaries.checkpointStore,
    boundaries.retryTimer,
    boundaries.ticketBranchCleaner,
    boundaries.clock,
    boundaries.sagNormsService,
    boundaries.git ?? inertGit,
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
