import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  AtomicFileError,
  cleanupAtomicTempFiles,
  writeAtomic,
} from "../../../src/state/atomic-file"

describe("writeAtomic", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-atomic-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("creates the file with the requested content", async () => {
    const filePath = join(directory, "out.txt")
    const result = await writeAtomic({ filePath, content: "hello world" })
    expect(result.bytes).toBe(11)
    const written = await readFile(filePath, "utf8")
    expect(written).toBe("hello world")
  })

  test("accepts a Uint8Array payload and an explicit encoding", async () => {
    const filePath = join(directory, "binary.bin")
    await writeAtomic({
      filePath,
      content: new Uint8Array([0x68, 0x69]),
      encoding: "utf8",
    })
    const written = await readFile(filePath)
    expect(written.length).toBe(2)
    expect(written[0]).toBe(0x68)
    expect(written[1]).toBe(0x69)
  })

  test("uses a random temp name in the same directory and removes it on success", async () => {
    const filePath = join(directory, "no-temp.txt")
    await writeAtomic({ filePath, content: "ok" })
    const siblings = await Bun.$`ls -1 ${directory}`.text()
    expect(siblings.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)).toEqual([
      "no-temp.txt",
    ])
  })

  test("removes the sibling temp file when the destination is unwritable", async () => {
    const filePath = join(directory, "fail.txt")
    await Bun.$`mkdir -p ${filePath}`.text()
    let caught: unknown
    try {
      await writeAtomic({ filePath, content: "boom" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AtomicFileError)
    const siblings = await Bun.$`ls -1 ${directory}`.text()
    const remaining = siblings
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    expect(remaining.some((entry) => entry.startsWith("fail.txt.tmp."))).toBe(false)
  })

  test("refuses to write when the destination is an existing directory", async () => {
    const filePath = join(directory, "directory-collision")
    await Bun.$`mkdir -p ${filePath}`.text()
    let caught: unknown
    try {
      await writeAtomic({ filePath, content: "boom" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AtomicFileError)
    if (caught instanceof AtomicFileError) {
      expect(caught.kind).toBe("destination_is_directory")
    }
  })
})

describe("cleanupAtomicTempFiles", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "issue-killer-cleanup-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("removes only sibling temp files matching the base name", async () => {
    const filePath = join(directory, "checkpoint")
    await Bun.$`touch ${filePath}.tmp.abc123 ${filePath}.tmp.def456 ${directory}/other.tmp.xyz`.text()
    const removed = await cleanupAtomicTempFiles({ filePath })
    expect(removed).toBe(2)
    const siblings = await Bun.$`ls -1 ${directory}`.text()
    const list = siblings
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    expect(list.includes("checkpoint.tmp.abc123")).toBe(false)
    expect(list.includes("checkpoint.tmp.def456")).toBe(false)
    expect(list.includes("other.tmp.xyz")).toBe(true)
  })

  test("returns zero when the directory does not exist", async () => {
    const filePath = join(directory, "never-created", "checkpoint")
    const removed = await cleanupAtomicTempFiles({ filePath })
    expect(removed).toBe(0)
  })
})

describe("V2-SEC-04 atomic writes", () => {
  test("concurrent writers produce distinct random temp names and only one final file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "issue-killer-concurrent-"))
    try {
      const filePath = join(directory, "status")
      const writes = Array.from({ length: 10 }, (_, index) =>
        writeAtomic({ filePath, content: `writer-${index}` }),
      )
      const results = await Promise.all(writes)
      const temps = new Set(results.map((entry) => entry.tempPath))
      expect(temps.size).toBe(10)
      for (const temp of temps) {
        expect(temp.includes("/status.tmp.")).toBe(true)
        expect(temp.includes("$$")).toBe(false)
      }
      const final = await readFile(filePath, "utf8")
      const statInfo = await stat(filePath)
      expect(statInfo.isFile()).toBe(true)
      expect(final.startsWith("writer-")).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})