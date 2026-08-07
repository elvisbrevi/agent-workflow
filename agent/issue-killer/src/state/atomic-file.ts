import { randomBytes } from "node:crypto"
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises"
import { dirname } from "node:path"

export type AtomicFileErrorKind =
  | "destination_directory_missing"
  | "destination_is_directory"
  | "temp_create_failed"
  | "temp_write_failed"
  | "rename_failed"

export class AtomicFileError extends Error {
  readonly kind: AtomicFileErrorKind
  readonly filePath: string
  readonly cause?: unknown

  constructor(
    kind: AtomicFileErrorKind,
    filePath: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message)
    this.name = "AtomicFileError"
    this.kind = kind
    this.filePath = filePath
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

export type WriteAtomicInput = {
  readonly filePath: string
  readonly content: string | Uint8Array
  readonly encoding?: BufferEncoding
}

export type WriteAtomicResult = {
  readonly filePath: string
  readonly tempPath: string
  readonly bytes: number
}

const TEMP_SUFFIX_BYTES = 16

const resolvePayload = (
  payload: string | Uint8Array,
  encoding: BufferEncoding,
): Uint8Array =>
  typeof payload === "string" ? Buffer.from(payload, encoding) : Buffer.from(payload)

const assertWritableDestination = async (filePath: string): Promise<void> => {
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      throw new AtomicFileError(
        "destination_is_directory",
        filePath,
        `atomic write refused: destination is a directory: ${filePath}`,
      )
    }
  } catch (error) {
    if (error instanceof AtomicFileError) {
      throw error
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return
    }
    throw new AtomicFileError(
      "destination_directory_missing",
      filePath,
      `atomic write could not inspect destination: ${(error as Error).message}`,
      { cause: error },
    )
  }
}

const cleanupTemp = async (tempPath: string): Promise<void> => {
  try {
    await unlink(tempPath)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return
    }
  }
}

export const writeAtomic = async (
  input: WriteAtomicInput,
): Promise<WriteAtomicResult> => {
  const encoding: BufferEncoding = input.encoding ?? "utf8"
  const payload = resolvePayload(input.content, encoding)
  const directory = dirname(input.filePath)
  await mkdir(directory, { recursive: true })
  await assertWritableDestination(input.filePath)

  const suffix = randomBytes(TEMP_SUFFIX_BYTES).toString("hex")
  const tempPath = `${input.filePath}.tmp.${suffix}`
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(tempPath, "wx")
    await handle.writeFile(payload)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, input.filePath)
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close()
      } catch {
        // ignore double-close during error cleanup
      }
      handle = null
    }
    await cleanupTemp(tempPath)
    if (error instanceof AtomicFileError) {
      throw error
    }
    throw new AtomicFileError(
      "temp_write_failed",
      input.filePath,
      `atomic write failed for ${input.filePath}: ${(error as Error).message}`,
      { cause: error },
    )
  }

  return {
    filePath: input.filePath,
    tempPath,
    bytes: payload.byteLength,
  }
}

export type CleanupAtomicTempFilesInput = {
  readonly filePath: string
  readonly suffix?: string
}

export const cleanupAtomicTempFiles = async (
  input: CleanupAtomicTempFilesInput,
): Promise<number> => {
  const suffix = input.suffix ?? ".tmp."
  const directory = dirname(input.filePath)
  const baseName = input.filePath.split("/").pop() ?? input.filePath

  let entries: ReadonlyArray<string>
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return 0
    }
    throw error
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.startsWith(`${baseName}${suffix}`)) {
      continue
    }
    const candidate = `${directory}/${entry}`
    try {
      await unlink(candidate)
      removed += 1
    } catch {
      // ignore concurrent unlink; the next attempt will retry
    }
  }
  return removed
}