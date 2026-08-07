# Plan de migración de `issue-killer` a TypeScript, Bun y OpenCode SDK

Estado: decisiones de dominio cerradas (grill 2026-08-06); lista para M0/M1  
Repositorio: `elvisbrevi/agent-workflow`  
Línea base inspeccionada: `main` en `69037045eb12e832e358af952a79c61c8378aac1`  
Fecha de la línea base: 2026-08-06  
Fuente de verdad de lenguaje: `CONTEXT.md`, ADR 0001, ADR 0014, `docs/design/issue-killer.md`

## 1. Objetivo

Reescribir el supervisor autónomo `agent/issue-killer` en TypeScript ejecutado por Bun, usando `@opencode-ai/sdk` como única integración de runtime de agente.

La migración debe:

- preservar la ejecución de exactamente un ticket por sesión;
- conservar el lock compartido por repositorio y worktrees enlazados;
- conservar checkpoint, recuperación, retries, fallback, selección de tracker y verificación independiente del resultado;
- seguir soportando GitHub y Azure DevOps;
- usar el SDK de OpenCode para servidor, cliente, sesiones, eventos, abortos y eliminación de sesiones;
- eliminar `jq` y la interpretación de JSON mediante pipelines Bash;
- evitar dependencias externas salvo las estrictamente necesarias;
- mantener el comando público `issue-killer` después del cutover;
- no modificar las skills ni sus `SKILL.md` como parte de esta migración;
- incorporar en V2 (no en Bash V1) las correcciones del code review y el harness execution log.

## 2. Decisiones de alcance

### 2.1 Decisión: V2 OpenCode-only

La V2 no porta adaptadores Claude/Codex. Solo perfiles OpenCode y fallback entre perfiles OpenCode. ADR 0012/0013 eliminados; ADR 0001 reescrito; ADR 0014 registra el runtime SDK.

Durante la transición, Bash V1 queda solo como rollback. No mezclar Bash y TypeScript en la misma ejecución. No backportear al Bash los hallazgos de seguridad: se implementan en V2.

### 2.2 Se conserva

- Trackers GitHub y Azure DevOps.
- Contrato del worker en `PROMPT.md`.
- Estados públicos: `ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`, `RECOVERY_REQUIRED`.
- Códigos de salida observables.
- Variables `ISSUE_RUNNER_*` aplicables.
- Archivo `issue-killer.checkpoint` y directorio `issue-killer.lock/`.
- Recuperación explícita mediante `ISSUE_RUNNER_ADOPT_ISSUE`; nunca inferir el ticket desde rama o archivos.
- Confirmación destructiva única antes de permitir acciones autónomas.
- Integración Azure HU, evidencia, Real Effort, ramas y reglas de cierre.

### 2.3 No se incluye

- Reescritura de las skills.
- Reemplazo de `gh`, `az` o `git` por SDKs adicionales.
- UI web o servicio remoto.
- Base de datos.
- Plugin de OpenCode.
- Cambio del modelo de negocio de Azure HU.
- Rediseño general del instalador fuera de lo necesario para instalar y enlazar la V2.
- Publicación, issues o implementación automática de este plan.
- Corrección de los hallazgos del code review sobre el runtime Bash V1.

### 2.4 Decisiones cerradas en grill (obligatorias en V2)

| Tema | Decisión |
|---|---|
| Lenguaje / ADRs | V2 prevalece; multi-CLI fuera de `CONTEXT.md`; 0012/0013 eliminados; 0001+0014 vigentes |
| Completion GitHub | Issue cerrado + exactamente 1 PR atribuible + merged + `baseRefName == BASE_BRANCH`; si no → `RECOVERY_REQUIRED` |
| Cierre post-merge | GitHub cierra issue tras merge; Azure mueve task a estado completed (p.ej. Done) tras merge |
| Opaque session id | `^[A-Za-z0-9_-]+$`, máx 128; revalidar antes de persist/resume/delete |
| TOML | Fail-closed: sin `\n`/`\r`/NUL en escalares de control; sin basura tras tokens; claves desconocidas = error |
| Lock/status | Un solo writer en memoria; temps aleatorios; nunca `$$` |
| Installer | Dry-run solo staging temporal; uninstall offline sin `sync_repo` |
| Event pump | Drenar todos los eventos de la sesión en orden |
| Redacción | Máquina de estados multilínea + por línea; antes de consola y archivo; raw SDK opt-in nunca en CI |
| Outcome | Structured output primario; marcador texto solo coexistencia V1; se retira en M12 |
| Permisos | Post-confirmación: allow total; sin prompt mid-run; permiso inesperado detiene |
| Harness log | Supervisor escribe JSONL por run bajo `log_dir` obligatorio del TOML; no tokens de modelo |
| Fallback | Reutiliza la sesión OpenCode previa si sigue reanudable, con el modelo del perfil siguiente; sesión nueva solo si no hay sesión reanudable (ADR 0015) |
| Serve | Solo `127.0.0.1`, puerto efímero, retries acotados, una instancia por run del supervisor |
| Docs runtime | `AGENT.md`/`REFERENCE.md` del runner se alinean en M10/M11; design/CONTEXT/ADRs ya V2 |

## 3. Línea base y restricciones

La versión actual contiene aproximadamente:

- 9.356 líneas Bash bajo `agent/issue-killer`;
- 10.435 líneas Bash de pruebas;
- runtime para Claude, Codex y OpenCode;
- un adaptador Azure de más de 2.200 líneas;
- un adaptador OpenCode por CLI basado en `opencode run --format json`;
- estado temporal coordinado mediante archivos laterales, `jq`, `sed`, `grep`, pipelines y subshells.

La migración no debe ser un reemplazo big-bang. Debe construir una V2 en paralelo, demostrar paridad por escenarios y cambiar el entrypoint solo al final.

## 4. Dependencias permitidas

### 4.1 Dependencias directas

| Tipo | Paquete | Justificación |
|---|---|---|
| Runtime | `@opencode-ai/sdk` con versión exacta | Es el requisito funcional central y entrega cliente tipado, sesiones, eventos y lifecycle del servidor OpenCode. |
| Desarrollo | `typescript` con versión exacta | Bun transpila TypeScript, pero no realiza type-checking. |
| Desarrollo | `@types/bun` con versión exacta | Necesario para tipar APIs nativas como `Bun.spawn`, `Bun.TOML`, `Bun.file` y `bun:test`. |

No agregar otras dependencias sin un ADR que demuestre que la plataforma estándar no cubre la necesidad.

### 4.2 Dependencias prohibidas por defecto

No usar:

- `commander`, `yargs` o equivalentes;
- `zod`, `joi`, `ajv` o equivalentes;
- `execa` o wrappers de procesos;
- `proper-lockfile` o librerías de locks;
- parsers TOML externos;
- librerías de retry;
- loggers externos;
- Jest, Vitest, Mocha o Sinon;
- ESLint o Prettier como condición para completar la migración.

Usar en su lugar:

- parser de argumentos pequeño y total;
- validadores TypeScript manuales con allowlists;
- `Bun.TOML.parse`;
- `Bun.spawn` con arrays de argumentos;
- `node:fs/promises`, `node:path`, `node:crypto` y APIs Web estándar;
- `bun:test`;
- logs JSONL propios y redacción interna.

### 4.3 Regla de versiones

- Confirmar en la primera fase la versión publicada de `@opencode-ai/sdk` compatible con el binario `opencode` soportado.
- Fijar versiones exactas en `package.json` y confirmar `bun.lock`.
- No usar `latest`, `^` ni `~` para el SDK.
- Registrar una matriz `Bun / OpenCode CLI / OpenCode SDK` en `REFERENCE.md`.
- Validar al inicio `client.global.health()` y rechazar una versión fuera de la matriz soportada.

La máquina inspeccionada usa Bun `1.3.3` y OpenCode `1.18.14`; son datos de referencia, no una garantía de compatibilidad. El agente implementador debe resolver y probar el SDK publicado correspondiente antes de fijar la matriz.

## 5. Arquitectura objetivo

```text
agent/issue-killer/
├── AGENT.md
├── PROMPT.md
├── REFERENCE.md
├── package.json
├── bun.lock
├── tsconfig.json
├── bin/
│   └── issue-killer.ts
├── src/
│   ├── app/
│   │   ├── run-queue.ts
│   │   ├── run-attempt.ts
│   │   └── recover-attempt.ts
│   ├── domain/
│   │   ├── checkpoint.ts
│   │   ├── execution-profile.ts
│   │   ├── lifecycle.ts
│   │   ├── outcome.ts
│   │   ├── recovery.ts
│   │   └── tracker.ts
│   ├── config/
│   │   ├── load-config.ts
│   │   └── validate-config.ts
│   ├── opencode/
│   │   ├── create-runtime.ts
│   │   ├── event-pump.ts
│   │   ├── normalize-event.ts
│   │   ├── provider-failure.ts
│   │   └── session.ts
│   ├── operator/
│   │   ├── arguments.ts
│   │   └── terminal-session.ts
│   ├── state/
│   │   ├── atomic-file.ts
│   │   ├── checkpoint-store.ts
│   │   └── repository-lock.ts
│   ├── system/
│   │   ├── clock.ts
│   │   ├── command.ts
│   │   ├── git.ts
│   │   ├── redaction.ts
│   │   └── signals.ts
│   └── tracker/
│       ├── select-tracker.ts
│       ├── github/
│       │   └── github-tracker.ts
│       └── azure/
│           ├── azure-config.ts
│           ├── azure-evidence.ts
│           ├── azure-hu.ts
│           ├── azure-pr.ts
│           └── azure-tracker.ts
└── test/
    ├── fixtures/
    ├── contract/
    ├── integration/
    └── unit/
```

### 5.1 Dirección de dependencias

```text
CLI -> aplicación -> dominio <- puertos
                        ^
                        |
      OpenCode / GitHub / Azure / Git / filesystem
```

Reglas:

- `domain/` no importa Bun, filesystem, SDK ni CLIs.
- `app/` coordina puertos; no construye comandos `gh`, `az` o `git`.
- cada adaptador devuelve objetos tipados, no stdout sin interpretar;
- `command.ts` es el único lugar que ejecuta procesos externos;
- ningún comando se construye como string de shell;
- la composición ocurre en `bin/issue-killer.ts`.

## 6. Flujo OpenCode objetivo

1. Validar argumentos, configuración, repositorio, tracker, autenticación y worktree.
2. Resolver el Git common dir.
3. Migrar o validar estado legacy sin mutar trabajo ambiguo.
4. Adquirir el lock del repositorio.
5. Seleccionar en el supervisor un ticket exacto, tanto en GitHub como en Azure.
6. Persistir su identidad antes de lanzar OpenCode.
7. Solicitar la confirmación destructiva si no existe autorización explícita válida.
8. Iniciar una instancia local de OpenCode mediante `createOpencode()` con `AbortSignal`.
9. Crear un cliente asociado al repositorio mediante `createOpencodeClient({ baseUrl, directory, throwOnError: true })`.
10. Verificar health y compatibilidad de versión.
11. Suscribirse a `client.event.subscribe()` antes de enviar el prompt.
12. Crear o recuperar la sesión mediante `client.session.create()` / `client.session.get()`.
13. Verificar que la sesión recuperada pertenece al mismo directorio, issue, rama, base SHA y perfil.
14. Enviar el prompt con `client.session.prompt()`, usando `providerID`, `modelID` y la variante soportada por la versión fijada.
15. Consumir todos los eventos del async iterator, filtrados por `sessionID`.
16. Normalizar eventos de archivos, tools, mensajes, retry, error, status e idle.
17. Actualizar checkpoint y status desde un único event loop; no usar subshells ni archivos laterales.
18. Obtener un outcome final estructurado o, durante compatibilidad, el marcador textual exacto.
19. Reconciliar Git, PR y ticket de forma independiente.
20. Avanzar la cola únicamente si `tracker.verifyCompletion()` confirma el estado real.
21. Eliminar la sesión con `client.session.delete()` solo después de cierre verificado o cola vacía verificada.
22. Ante señal o error, abortar sesión, cerrar servidor, conservar checkpoint si corresponde y liberar el lock solo si el token de ownership coincide.

### 6.1 Selección host-owned

La V2 no debe permitir que el modelo elija libremente un issue de GitHub. El supervisor selecciona y fija el issue antes de crear la sesión.

Esto elimina:

- extracción frágil del número desde texto del asistente;
- dependencia de inspeccionar comandos emitidos por el modelo;
- riesgo de mutar antes de conocer la identidad;
- posibilidad de que una sesión cambie silenciosamente a otro ticket.

El prompt debe decir: “trabaja únicamente en el ticket N; no inspecciones ni selecciones otro ticket”.

### 6.2 Permisos

- La confirmación del operador sigue siendo la frontera de autorización.
- Solo después de confirmación se crea la instancia OpenCode con el permiso autónomo acordado.
- La traducción inicial recomendada de `auto_approve = true` es una configuración OpenCode `permission = "allow"` limitada a la instancia local del runner.
- `auto_approve = false` no es válido en modo no interactivo destructivo; debe fallar antes de lanzar la sesión.
- Si llega un evento de permiso inesperado bajo un perfil autónomo, detener con `BLOCKED` o `RECOVERY_REQUIRED`; no aprobar silenciosamente una categoría desconocida.

### 6.3 Puerto y lifecycle del servidor

`createOpencode()` inicia un proceso `opencode serve`; el puerto predeterminado puede colisionar entre repositorios.

La fase de SDK debe comprobar si `port: 0` está soportado por la versión fijada. Si no lo está:

1. reservar un puerto local efímero;
2. cerrar la reserva inmediatamente antes de iniciar OpenCode;
3. reintentar un número acotado de veces ante `EADDRINUSE`;
4. escuchar únicamente en `127.0.0.1`;
5. nunca exponer el servidor por red sin una decisión de seguridad separada.

## 7. Persistencia y seguridad

### 7.1 Checkpoint

Para permitir rollback y recuperación durante el cutover, la V2 debe leer y escribir inicialmente el formato `key=value` actual. Puede agregar `format_version=2`, pero no cambiar a JSON en esta migración.

Requisitos:

- parser por líneas con allowlist de claves;
- rechazo de duplicados donde solo se admite un valor;
- rechazo de `\n`, `\r`, NUL y longitudes excesivas;
- `session_id` validado como identificador opaco limitado antes de persistir;
- escritura en un archivo temporal único aleatorio del mismo directorio;
- flush, close y rename atómico;
- nunca persistir prompt, credenciales, headers, tools completos ni comandos completos.

### 7.2 Lock

- Crear `issue-killer.lock` mediante operación exclusiva de directorio.
- Guardar PID, token aleatorio, repositorio y timestamp.
- Considerar stale solo si el PID no existe y el owner no cambió entre lecturas.
- Escribir `status` con nombres temporales aleatorios, nunca `status.$$`.
- Serializar las escrituras de status desde un único writer en memoria.
- Liberar solo si el token guardado todavía coincide.
- Conservar cobertura entre checkout principal y linked worktrees usando Git common dir.

### 7.3 Logs y redacción

- No persistir el stream SDK crudo por defecto.
- Persistir JSONL normalizado y redactado con categoría, timestamp, iteración, sesión abreviada y detalle permitido.
- Implementar redacción multilínea como máquina de estados para claves privadas.
- Redactar bearer tokens, headers Authorization, API keys, passwords, tokens GitHub/Azure y URLs con credenciales.
- Aplicar redacción antes de consola y antes de archivo.
- Un modo debug crudo, si se agrega, debe ser opt-in, advertir el riesgo y no activarse en CI.

## 8. Configuración

Continuar leyendo `~/.config/issue-killer/config.toml` mediante `Bun.TOML.parse`.

Compatibilidad inicial recomendada:

```toml
default_profile = "opencode-main"
log_dir = "~/.local/state/issue-killer/logs"

[profiles.opencode-main]
label = "OpenCode main"
cli = "opencode"
command = "opencode"
model = "provider/model"
fallbacks = ["opencode-backup"]

[profiles.opencode-main.options]
variant = "high"
auto_approve = true

[profiles.opencode-backup]
label = "OpenCode backup"
cli = "opencode"
command = "opencode"
model = "provider/backup-model"
```

Reglas V2:

- `cli` debe ser `opencode`.
- `command` debe ser `opencode`, porque el SDK inicia ese ejecutable desde PATH.
- `model` se divide una sola vez en `providerID/modelID`.
- `log_dir` es obligatorio, expandido y escribible; todo harness log cae ahí (un JSONL redactado por run de cola).
- todos los perfiles y fallbacks deben ser OpenCode.
- claves desconocidas son error.
- ciclos, duplicados y referencias ausentes son error.
- strings con saltos de línea, `\r` o NUL en identificadores y campos de control son error; basura tras tokens es error.
- credenciales siguen fuera del TOML.

No simplificar el formato de configuración en el mismo cutover. Una limpieza posterior puede retirar `cli` y `command` mediante otro ADR.

## 9. Estado final del worker

La opción preferida es usar structured output del SDK con un schema mínimo:

```json
{
  "status": "ISSUE_COMPLETED | QUEUE_EMPTY | BLOCKED | FAILED | RECOVERY_REQUIRED",
  "issue": 123,
  "summary": "texto breve no sensible"
}
```

El agente implementador debe validar primero el nombre exacto del campo (`format` u `outputFormat`) en la versión fijada del SDK. La documentación y los tipos generados son el contrato, no ejemplos memorizados.

Durante la coexistencia con V1:

- aceptar structured output como primario;
- aceptar el marcador `ISSUE_KILLER_STATUS=...` solo como compatibilidad;
- rechazar outcomes contradictorios;
- tratar ausencia o schema inválido como `malformed`;
- nunca considerar `ISSUE_COMPLETED` suficiente sin **completion verification** live.

En M12 se retira el aceptador del marcador textual junto con el runtime Bash.

## 10. Plan de trabajo por entregables

Cada entregable debe ser un PR pequeño, revisable y con rollback. No iniciar el siguiente si el anterior no está verde.

### M0 — Congelar contratos y aprobar ADR

Depende de: nada.

Trabajo:

- confirmar ADR 0014 y ADR 0001 ya alineados al grill; no recrear 0012/0013;
- registrar OpenCode-only, host-owned selection, completion verification, log_dir, harness log y compatibilidad del checkpoint;
- listar códigos de salida, estados, variables y comportamientos que no pueden cambiar;
- capturar fixtures de los escenarios Bash actuales antes de tocar el entrypoint;
- convertir cada hallazgo del code review en prueba V2 obligatoria (GitHub verify, session_id, TOML injection, lock temps, dry-run, multi-event, redacción, args faltantes).

Aceptación:

- ADRs/CONTEXT/design alineados (ya en repo post-grill);
- matriz de comportamiento versionada;
- ninguna modificación runtime aún.

### M1 — Spike contractual de Bun y OpenCode SDK

Depende de: M0.

Trabajo:

- crear package mínimo dentro de `agent/issue-killer`;
- fijar provisionalmente Bun, TypeScript, `@types/bun` y SDK exacto;
- probar `createOpencode`, health, `createOpencodeClient` con `directory`, create/get/delete session, event subscription, abort y close;
- probar puerto concurrente;
- confirmar nombres y shapes reales de prompt, structured output, model, variant, permission y errores;
- documentar la matriz CLI/SDK.

Aceptación:

- smoke test sin llamada a modelo;
- prueba opt-in con modelo en sandbox DEV;
- ninguna suposición sobre API queda sin fixture;
- si el SDK no satisface una operación esencial, detener el plan y registrar el gap antes de crear wrappers HTTP manuales.

### M2 — Scaffold TypeScript y dominio puro

Depende de: M1.

Trabajo:

- agregar `package.json`, `bun.lock`, `tsconfig.json` strict y entrypoint V2 no instalado;
- modelar `Outcome`, `LifecycleState`, `ExecutionProfile`, `Checkpoint`, `RecoveryDecision`, `TrackerItem` y errores tipados;
- definir puertos `Tracker`, `OpenCodeRuntime`, `Git`, `CheckpointStore`, `RepositoryLock`, `Clock`, `CommandRunner`;
- usar unions discriminadas y exhaustive switches.

Aceptación:

- `bun test` verde;
- typecheck verde con `noUncheckedIndexedAccess` y `noFallthroughCasesInSwitch`;
- dominio sin imports de infraestructura.

### M3 — Primitivas seguras de sistema, configuración y estado

Depende de: M2.

Trabajo:

- parser CLI total;
- loader TOML con `Bun.TOML.parse` y validación manual estricta;
- `CommandRunner` con `Bun.spawn` y argv arrays;
- Git common dir y estado de worktree;
- lock, checkpoint y atomic writer;
- señales y cleanup con `AbortController`;
- redacción multilínea.

Pruebas obligatorias derivadas de la revisión previa:

- path traversal y longitud de `session_id`;
- inyección TOML mediante `\n` / `\r` y contenido sobrante;
- colisión de temporales entre heartbeat y writer;
- argumentos faltantes de `--config`, `--hu` y repositorio duplicado;
- redacción de clave privada multilínea;
- checkpoint sin secretos, prompt ni comandos completos;
- lock compartido por linked worktrees y recuperación stale segura.

Aceptación:

- no se invoca shell para construir comandos;
- no se necesita `jq`;
- fixtures legacy del checkpoint se leen sin pérdida.

### M4 — Tracker GitHub y selección host-owned

Depende de: M3.

Trabajo:

- portar preflight, remote detection, auth, queue, blockers, claim, PR lookup y close;
- solicitar JSON explícito a `gh` y validar cada shape;
- seleccionar y persistir el issue antes de cualquier sesión;
- implementar `verifyCompletion(issue, branch, baseBranch)` incondicional.

`verifyCompletion` debe exigir:

- issue cerrado;
- exactamente un PR atribuible a la rama/ticket;
- PR merged;
- base branch exacta;
- estado no ambiguo.

Aceptación:

- fixtures de issue abierto, bloqueado, épico, asignado y elegible;
- cero, uno y múltiples PRs;
- PR merged a rama incorrecta;
- marcador falso `ISSUE_COMPLETED` termina en `RECOVERY_REQUIRED`.

### M5 — Runtime OpenCode SDK y event pump

Depende de: M3 y M4.

Trabajo:

- implementar lifecycle local del servidor;
- crear cliente directory-scoped;
- crear/consultar/eliminar sesiones;
- suscribir eventos antes del prompt;
- filtrar por `sessionID`;
- procesar todos los eventos, nunca solo el primero;
- normalizar `message.part.updated`, tools, file edits, retry, session error/status/idle y permisos;
- generar artefacto JSONL redactado;
- extraer outcome estructurado y compatibilidad textual.

Aceptación:

- prueba con dos o más tool events dentro de la misma ejecución;
- eventos de otra sesión ignorados;
- cancelación por SIGINT aborta sesión y cierra servidor;
- sesión inexistente o de otro directorio no se reanuda;
- stream nunca imprime tools completos ni secretos.

### M6 — Vertical GitHub completa

Depende de: M5.

Trabajo:

- componer una ejecución completa contra fakes: select -> checkpoint -> session -> outcome -> live verification -> cleanup;
- implementar heartbeat sin concurrencia de writers;
- implementar cola, límite de iteraciones y códigos de salida;
- conservar `PROMPT.md` como asset leído en runtime.

Aceptación:

- escenarios `ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`, malformed y cancelación;
- ninguna segunda issue se inicia tras un outcome no verificado;
- la sesión se elimina solo al completar o vaciar cola de forma verificada;
- comparación black-box V1/V2 para GitHub.

### M7 — Retry, recuperación y fallback OpenCode

Depende de: M6.

Trabajo:

- portar clasificación de transporte y provider failure;
- preferir errores tipados del SDK y status HTTP antes que regex textual;
- conservar retries acotados antes del fallback;
- permitir fallback solo en quota, rate limit persistente o model unavailable;
- persistir posición, perfil fallido, perfil siguiente y categoría;
- reanudar únicamente si `session.get()` confirma sesión, directory, issue, rama y base SHA;
- en todo fallback elegible, continuar la sesión OpenCode previa cuando siga reanudable, enviando el modelo del perfil siguiente sobre esa misma sesión; crear una sesión nueva restringida al mismo issue/worktree solo cuando no exista sesión reanudable (ADR 0015).

Aceptación:

- fallbacks en orden, sin ciclos ni saltos;
- implementación fallida nunca consume fallback;
- restart restaura posición exacta;
- drift de config, rama, base SHA o tracker conserva `RECOVERY_REQUIRED`;
- adopción legacy requiere issue explícita.

### M8 — Azure I: preflight, configuración, selección HU/ticket y ramas

Depende de: M3 y M7.

Trabajo:

- portar parser del contrato repository-owned;
- validar organization/project/repository, tipos, estados y relaciones;
- portar selección de HU y child directo;
- portar pinning, branch category, origen e integration branch;
- portar claim e identidad.

Aceptación:

- selección determinista por fecha e ID;
- solo hijos jerárquicos directos Task/Bug configurados;
- related links e indirect descendants excluidos;
- HU no se cierra ni se integra a mainline automáticamente;
- primera selección no interactiva sin origen termina segura.

### M9 — Azure II: evidencia, effort, PR, cierre y recuperación

Depende de: M8.

Trabajo:

- portar field discovery/persistence;
- portar modalidades de evidencia y attachments;
- portar Real Effort acumulado;
- portar development links idempotentes;
- portar verificación de PR a la HU integration branch;
- portar cierre del ticket y reconciliación parcial.

Aceptación:

- exactamente una PR merged y exitosa hacia la rama HU;
- evidencia requerida presente;
- effort válido y acumulado;
- ticket en closed state configurado;
- integración parcial conserva `RECOVERY_REQUIRED`;
- pruebas DEV/sandbox opt-in, nunca contra producción por defecto.

### M10 — Operador, instalador y dry-run

Depende de: M6; puede avanzar en paralelo con M8/M9 sin hacer cutover.

Trabajo:

- portar menú y confirmaciones a `node:readline/promises` o lectura TTY estándar;
- agregar entrypoint con shebang Bun;
- hacer que el instalador instale dependencias con `bun install --frozen-lockfile --production` en el cache administrado;
- mantener symlink `issue-killer`;
- hacer que dry-run use staging temporal y no modifique cache ni destinos;
- uninstall no debe depender de red;
- conservar ownership/provenance de symlinks.

Aceptación:

- instalación global y local;
- reinstalación idempotente;
- dry-run sin cambios persistentes;
- uninstall offline;
- error claro si Bun u OpenCode faltan;
- rollback al entrypoint Bash todavía posible.

### M11 — Paridad, canary y cutover

Depende de: M7, M9 y M10.

Trabajo:

- ejecutar matriz black-box V1/V2 con los mismos fixtures;
- canary en repositorio GitHub sandbox;
- canary Azure DEV con un único ticket controlado;
- actualizar `AGENTS.md`, `README.md`, `AGENT.md`, `REFERENCE.md`, diseño y ADRs;
- cambiar el symlink público a `bin/issue-killer.ts`;
- conservar V1 como rollback durante una ventana definida, sin instalarla por defecto.

Aceptación:

- suite completa verde en macOS y Linux;
- Bun y OpenCode en matriz soportada;
- recuperación desde checkpoint Bash real demostrada;
- una ejecución GitHub y una Azure DEV completas verificadas externamente;
- no hay referencias de runtime a Claude/Codex en la V2;
- no hay dependencia de `jq` para `issue-killer`.

### M12 — Retiro de Bash

Depende de: canary estable de M11 y aprobación explícita.

Trabajo:

- eliminar módulos runtime Bash de `agent/issue-killer`;
- retirar pruebas duplicadas ya cubiertas por Bun;
- mantener únicamente fixtures de migración necesarios;
- retirar rollback del instalador;
- comprobar catálogo y enlaces instalados.

Aceptación:

- no queda `.sh` ejecutable dentro del runtime de `issue-killer`;
- el repo sigue instalando skills sin alterarlas;
- documentación y comandos coinciden con la V2.

## 11. Estrategia de pruebas

### 11.1 Pirámide

1. Unitarias puras: dominio, config, redacción, state machine, retries.
2. Contratos: SDK, shapes `gh`/`az`, checkpoint legacy.
3. Integración: filesystem, linked worktrees, fake HTTP OpenCode, stub CLIs.
4. Black-box: comando V2 en repositorios temporales.
5. Live opt-in: OpenCode real, GitHub sandbox y Azure DEV.

### 11.2 Dobles sin librerías

- objetos fake que implementan los puertos TypeScript;
- scripts stub ejecutables colocados al inicio de PATH para `git`, `gh` y `az` cuando corresponda;
- `Bun.serve` para simular endpoints y SSE del SDK cuando no se requiere `createOpencode()` real;
- reloj y sleep inyectables;
- filesystem temporal con `mkdtemp`.

### 11.3 Comandos objetivo

```bash
cd agent/issue-killer
bun install --frozen-lockfile
bun run typecheck
bun test
bun test test/unit
bun test test/contract
bun test test/integration
```

Mientras exista V1:

```bash
bash ../../tests/issue_killer_test.sh
bash ../../tests/issue_killer_migration_test.sh
bash ../../tests/github_tracker_adapter_test.sh
bash ../../tests/azure_devops_tracker_adapter_test.sh
bash ../../tests/azure_hu_selection_test.sh
bash ../../tests/azure_hu_runner_test.sh
bash ../../tests/azure_hu_branch_test.sh
bash ../../tests/azure_hu_drainage_test.sh
bash ../../tests/hu_progress_test.sh
bash ../../tests/install_test.sh
git diff --check
```

## 12. Gates de seguridad

El agente implementador debe detenerse y pedir decisión si ocurre cualquiera de estos casos:

- el SDK no expone una operación esencial y sería necesario usar endpoints internos no documentados;
- el SDK y el CLI no tienen una combinación compatible demostrable;
- el structured output no funciona con sesiones tool-using;
- `port: 0` no funciona y la estrategia de puerto no supera pruebas concurrentes;
- el checkpoint Bash no puede migrarse sin ambigüedad;
- Azure requiere cambiar reglas de negocio o estados de HU;
- una prueba live requeriría credenciales o mutaciones fuera de un sandbox explícito;
- aparece una nueva dependencia runtime propuesta;
- la V2 intenta avanzar tras un marcador no confirmado por el tracker.

## 13. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Drift rápido del SDK | Versión exacta, contract tests y health/version gate. |
| Colisión del servidor local | Puerto efímero comprobado, retries acotados y localhost. |
| Pérdida de recuperación | Mantener formato checkpoint y ejecutar fixtures V1/V2. |
| Reescritura Azure demasiado grande | Separar M8 y M9; PRs verticales por capacidad. |
| Falso éxito del modelo | `tracker.verifyCompletion()` obligatorio para todos los trackers. |
| Fuga de secretos en eventos | No guardar raw stream; redacción antes de sinks. |
| Sesión equivocada | Validar `session.get()`, directory, issue, rama, base SHA y perfil. |
| Dos runners en linked worktrees | Lock en Git common dir con token de ownership. |
| Dry-run destructivo | staging temporal y pruebas de snapshot del filesystem. |
| Dependencias crecientes | presupuesto de dependencias y ADR obligatorio. |

## 14. Definition of Done global

La migración está completa solo cuando:

- `issue-killer` público ejecuta TypeScript con Bun;
- el runtime usa `@opencode-ai/sdk`, no `opencode run --format json`;
- GitHub y Azure DevOps pasan sus suites y canaries sandbox;
- selección de issue es host-owned;
- todo éxito se verifica live e independientemente;
- checkpoints y locks sobreviven reinicios y linked worktrees;
- recovery nunca infiere issue;
- fallback solo rota perfiles OpenCode por fallas de proveedor permitidas;
- no se persisten secretos, prompts, comandos completos ni raw SDK streams por defecto;
- `jq` deja de ser requisito del agente;
- solo existen las tres dependencias directas autorizadas;
- instalador, dry-run, uninstall y rollback fueron probados;
- documentación y ADRs reflejan el comportamiento final;
- V1 se elimina solo después de aprobación del cutover.

## 15. Instrucciones concretas para el siguiente agente

1. Trabajar desde un checkout limpio de `elvisbrevi/agent-workflow` y revalidar `origin/main`.
2. Leer `AGENTS.md`, `CONTEXT.md`, `docs/design/issue-killer.md`, ADRs 0001 y 0014, este plan, `AGENT.md`, `PROMPT.md` y `REFERENCE.md` (estos últimos aún pueden describir V1 hasta M10/M11).
3. No empezar por portar archivos Bash línea por línea.
4. Ejecutar M0 y M1 primero; el contrato real del SDK decide las firmas.
5. Implementar un solo entregable M por PR, o dividir M8/M9 en PRs aún menores.
6. Mantener V1 funcional hasta M11; no parchear hallazgos de seguridad en Bash.
7. Convertir cada bug del code review en una prueba V2 antes de implementar el módulo correspondiente.
8. Usar TDD para dominio, estado y recuperación.
9. Implementar harness execution log y `log_dir` junto al event pump (M5/M6), no como afterthought.
10. Ejecutar revisión de código enfocada en invariantes, no solo equivalencia sintáctica.
11. No publicar ni cerrar tickets adicionales sin autorización explícita.

## 16. Referencias técnicas

- [OpenCode SDK](https://opencode.ai/docs/sdk/): creación de servidor/cliente, tipos, sesiones, structured output y eventos.
- [OpenCode Server](https://opencode.ai/docs/server/): servidor headless, hostname, puerto y autenticación.
- [Código fuente del SDK: `server.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/server.ts): lifecycle real del proceso `opencode serve`.
- [Código fuente del SDK: `client.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/client.ts): cliente asociado a `directory`.
- [Tipos generados del SDK](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts): contrato exacto de eventos, mensajes, sesiones y errores.
- [Bun TypeScript](https://bun.sh/docs/runtime/typescript): configuración strict y `@types/bun`.
- [Bun test](https://bun.sh/docs/test): runner de pruebas integrado.
- [Bun.spawn](https://bun.sh/reference/bun/spawn): procesos con argv, cwd, env y AbortSignal.
- [Bun TOML](https://bun.sh/reference/bun): parser TOML nativo.
- [Bun lockfile](https://bun.sh/docs/pm/lockfile): lockfile reproducible y versionado.
