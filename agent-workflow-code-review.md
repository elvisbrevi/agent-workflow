# Revisión de código de `elvisbrevi/agent-workflow`

Revisé la rama `main` de **`elvisbrevi/agent-workflow`** mediante GitHub, concentrándome en el código ejecutable: instalador, configuración, locks/checkpoints, recuperación, runtimes y trackers.

## Evaluación general

La arquitectura está bien planteada:

- `run.sh` funciona como composition root.
- Configuración, runtime, recuperación, estado y trackers están separados.
- Los contratos destructivos están documentados.
- Existe una suite amplia de pruebas Bash.
- La compatibilidad con Bash 3.2 aparece como una restricción explícita.

Sin embargo, encontré **tres problemas de prioridad alta** que convendría corregir antes de confiar plenamente en `issue-killer` para ejecuciones autónomas destructivas.

## Hallazgos

### 1. Alta: GitHub acepta `ISSUE_COMPLETED` sin verificar el estado real

En el flujo final, la verificación de que el PR está integrado y el ticket cerrado solamente se ejecuta cuando el tracker es Azure DevOps. Para GitHub, el runner acepta el marcador, elimina el checkpoint y continúa con el siguiente issue.

El adapter de GitHub tiene funciones para consultar issues y PRs, pero no expone una validación final equivalente a la utilizada por Azure.

Esto significa que un worker podría emitir accidentalmente:

```text
ISSUE_KILLER_STATUS=ISSUE_COMPLETED
```

aunque:

- el PR continúe abierto;
- el PR se haya integrado en otra rama;
- el issue siga abierto;
- existan varios PRs para la rama.

**Corrección recomendada:** definir `tracker_item_completion_verified` en todos los adapters y llamarlo incondicionalmente antes de limpiar el checkpoint. Para GitHub debería comprobar issue cerrado, exactamente un PR, `mergedAt` presente y `baseRefName == BASE_BRANCH`.

---

### 2. Alta: posible path traversal mediante `session_id`

El adapter captura `session_id` directamente desde el JSON producido por Claude, sin validar su formato.

Posteriormente concatena ese valor dentro de una ruta y ejecuta `rm -f` cuando termina el trabajo.

Un CLI manipulado podría producir algo como:

```text
../../../../tmp/important-file
```

y hacer que la limpieza apunte fuera del directorio esperado.

**Corrección recomendada:**

```bash
case "$session_id" in
  ""|*[!A-Za-z0-9_-]*)
    return 1
    ;;
esac
```

También conviene limitar su longitud y volver a validar antes de cualquier operación de lectura o eliminación.

---

### 3. Alta: inyección en el estado interno desde strings TOML

El parser admite `\n` dentro de strings TOML. Luego escribe los valores sin escape en un archivo con formato:

```text
clave=valor
```

Como las consultas posteriores utilizan `grep` sobre ese archivo, un valor puede crear registros adicionales.

Ejemplo conceptual:

```toml
label = "Claude\nprofiles.injected.cli=codex"
```

produce:

```text
profiles.safe.label=Claude
profiles.injected.cli=codex
```

Lo confirmé con una reproducción aislada en Bash.

El parser también acepta silenciosamente contenido sobrante:

```toml
command = "claude" texto-invalido
```

porque retorna al encontrar la comilla de cierre sin validar el resto de la línea.

**Corrección recomendada:** rechazar `\n` y `\r` en todos los valores escalares, validar que después del string o array solo exista whitespace y usar una representación escapada para el archivo temporal.

---

### 4. Media-alta: carrera al actualizar el archivo de estado del lock

El heartbeat escribe el estado desde un subshell mientras el proceso principal también puede actualizarlo. Ambos usan:

```bash
status_tmp="${LOCK_DIR}/status.$$"
```

En Bash, un subshell normalmente conserva el mismo `$$` que el proceso padre. Lo confirmé:

```text
parent:   $$=420 BASHPID=420
subshell: $$=420 BASHPID=423
```

Por lo tanto, ambos procesos pueden truncar y mover exactamente el mismo archivo temporal. Esto puede producir estado incompleto o hacer fallar el `mv`. El heartbeat que activa esta concurrencia está en el supervisor.

**Corrección recomendada:**

```bash
status_tmp="$(mktemp "${LOCK_DIR}/status.XXXXXX")"
```

El checkpoint debería adoptar la misma estrategia en lugar de `tmp.$$`.

---

### 5. Media: `--dry-run` modifica el sistema

Aunque el instalador termina diciendo que no hizo cambios, siempre ejecuta `sync_repo`, que clona y reemplaza:

```text
~/.cache/agent-workflow
```

antes de procesar los destinos.

Por tanto, este comando sí modifica archivos:

```bash
./install.sh --dry-run --global
```

Además, `--uninstall` también intenta refrescar el repositorio, haciendo que una desinstalación dependa de GitHub y de la conexión a internet.

**Corrección recomendada:**

- En dry-run, clonar en un directorio temporal y eliminarlo al finalizar.
- En uninstall, omitir completamente `sync_repo`.
- Eliminar symlinks administrados basándose en el prefijo del cache, incluso cuando el cache ya no exista.

---

### 6. Media: solo se procesa el primer `tool_use`

El adapter de Claude extrae los bloques con:

```bash
jq ... | head -n 1
```

Un evento de assistant puede contener varios usos de herramientas. Si en un mismo evento se ejecutan, por ejemplo, una edición y después `gh pr create`, solamente la primera acción será registrada. Esto puede dejar el checkpoint retrasado respecto del estado real.

**Corrección recomendada:** emitir y procesar todos los bloques `tool_use` en orden, no solamente el primero.

---

### 7. Media: la redacción de claves privadas no funciona

La expresión intenta usar:

```regex
[\s\S]*?
```

dentro de `sed -E`. Esa construcción no funciona como patrón multilínea en `sed`, y `sed` procesa cada línea separadamente.

Lo confirmé con una clave privada ficticia multilínea: el contenido permaneció intacto.

**Corrección recomendada:** usar una pequeña máquina de estados en `awk` que descarte todo desde `BEGIN ... PRIVATE KEY` hasta `END ... PRIVATE KEY`, además de la redacción normal por línea.

---

### 8. Baja: argumentos faltantes producen errores no controlados

En `install.sh`, estas opciones leen `$2` sin comprobar antes que exista:

```bash
--target
--ref
```

Con `set -u`, esto genera:

```text
$2: unbound variable
```

en vez de un error descriptivo.

**Corrección recomendada:**

```bash
--target)
  [[ $# -ge 2 ]] || die "--target requires a directory"
  TARGET="$2"
  shift 2
  ;;
```

## Prioridad recomendada

Primero corregiría:

1. Verificación final de GitHub.
2. Validación de `session_id`.
3. Serialización segura de configuración.
4. Carrera del archivo de lock.

Después corregiría el comportamiento de dry-run, el procesamiento de múltiples herramientas y la redacción.

No modifiqué el repositorio. Tampoco pude ejecutar la suite completa porque este entorno no pudo clonar GitHub; la revisión fue estática mediante el conector, aunque validé aisladamente los comportamientos de Bash relacionados con `$$`, `set -u`, inyección por saltos de línea y redacción multilínea.
