import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createAskProSession,
  getAskProSessionPaths,
  readAskProAnswer,
  readAskProStatus,
  updateAskProStatus,
} from "../../src/ask-pro/session.js";
import { MAX_CONTEXT_BYTES } from "../../src/ask-pro/limits.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createRepoWithOutsideSibling(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-parent-"));
  const cwd = path.join(parent, "repo");
  const sibling = path.join(parent, "sibling");
  await fs.mkdir(path.join(cwd, "src", "a"), { recursive: true });
  await fs.mkdir(sibling);
  tempDirs.push(parent);
  await fs.writeFile(path.join(sibling, "outside.ts"), "export const outside = true;\n");
  return cwd;
}

function readStoredZipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    entries.set(name, zip.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function countStoredZipEntries(zip: Buffer, expectedName: string): number {
  let count = 0;
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === expectedName) count += 1;
    offset = dataStart + compressedSize;
  }
  return count;
}

describe("ask-pro sessions", () => {
  test("creates a dry-run session with manifests and a context zip", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, "src", "example.ts"),
      "const token = 'sk-testsecretsecretsecretsecret';\n",
    );

    const session = await createAskProSession({
      cwd,
      question: "Review this billing queue plan.",
      filePatterns: ["src/**/*.ts"],
      dryRun: true,
    });

    expect(session.status.status).toBe("DRY_RUN_COMPLETE");
    expect(session.manifest.includedFiles).toEqual([
      { path: "src/example.ts", reason: "Matched by --files pattern." },
    ]);
    expect(session.manifest.redaction.mode).toBe("best_effort");

    const files = await fs.readdir(session.dir);
    expect(files).toEqual(
      expect.arrayContaining([
        "PROMPT.md",
        "MANIFEST.md",
        "MANIFEST.json",
        "CONTEXT.zip",
        "ANSWER.md",
        "browser.json",
        "status.json",
        "log.txt",
      ]),
    );
    const zip = await fs.readFile(path.join(session.dir, "CONTEXT.zip"));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.toString("utf8")).toContain("[REDACTED_OPENAI_KEY]");
  });

  test("includes an exact prior-session answer despite discovery exclusions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const relativePath = ".ask-pro/sessions/prior/ANSWER.md";
    const marker = "EXACT_PRIOR_ANSWER_MARKER";
    await fs.mkdir(path.join(cwd, ".ask-pro", "sessions", "prior"), { recursive: true });
    await fs.writeFile(path.join(cwd, relativePath), `${marker}\n`, "utf8");

    const session = await createAskProSession({
      cwd,
      question: "Review the prior answer.",
      filePatterns: [relativePath],
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual([
      { path: relativePath, reason: "Explicit file requested by --files." },
    ]);
    const zip = await fs.readFile(path.join(session.dir, "CONTEXT.zip"));
    const entries = readStoredZipEntries(zip);
    expect(entries.get(`context/${relativePath}`)?.toString("utf8")).toBe(`${marker}\n`);
    const embeddedManifest = entries.get("MANIFEST.json")!.toString("utf8");
    expect(embeddedManifest).toBe(
      await fs.readFile(path.join(session.dir, "MANIFEST.json"), "utf8"),
    );
    const jsonManifest = JSON.parse(embeddedManifest);
    expect(jsonManifest.includedFiles).toEqual(session.manifest.includedFiles);
    expect([...entries.keys()].filter((entry) => entry.startsWith("context/")).sort()).toEqual(
      jsonManifest.includedFiles.map((file: { path: string }) => `context/${file.path}`).sort(),
    );
    expect(entries.get("MANIFEST.md")?.toString("utf8")).toContain(
      `\`${relativePath}\` - Explicit file requested by --files.`,
    );
  });

  test.each([".ask-pro", ".ask-pro/**"])(
    "keeps prior sessions excluded from discovery input %s",
    async (filePattern) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
      tempDirs.push(cwd);
      const relativePath = ".ask-pro/sessions/prior/ANSWER.md";
      await fs.mkdir(path.join(cwd, ".ask-pro", "sessions", "prior"), { recursive: true });
      await fs.writeFile(path.join(cwd, relativePath), "MUST_NOT_BE_DISCOVERED\n", "utf8");
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const session = await createAskProSession({
        cwd,
        question: "Review discovery behavior.",
        filePatterns: [filePattern],
        dryRun: true,
      });

      expect(session.manifest.includedFiles).toEqual([]);
      expect(session.manifest.excludedFiles).toContainEqual({
        path: filePattern,
        reason: "No attachable files matched this --files discovery input.",
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(filePattern));
      const entries = readStoredZipEntries(
        await fs.readFile(path.join(session.dir, "CONTEXT.zip")),
      );
      expect(entries.has(`context/${relativePath}`)).toBe(false);
      warning.mockRestore();
    },
  );

  test("deduplicates an exact file and overlapping glob while preserving explicit reason", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "example.ts"), "export const exact = true;\n");

    const session = await createAskProSession({
      cwd,
      question: "Review this file.",
      filePatterns: ["src/example.ts", "src/**/*.ts"],
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual([
      { path: "src/example.ts", reason: "Explicit file requested by --files." },
    ]);
    const zip = await fs.readFile(path.join(session.dir, "CONTEXT.zip"));
    expect(countStoredZipEntries(zip, "context/src/example.ts")).toBe(1);
  });

  test("fails a missing exact request before creating a consultation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: ["missing.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/Exact --files path does not exist: missing\.txt/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("reports an ENOTDIR exact request as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "not-a-directory"), "text\n", "utf8");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: ["not-a-directory/missing.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/Exact --files path does not exist: not-a-directory\/missing\.txt/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test.each([
    [".env", "environment credential"],
    [".env.local", "environment credential"],
    ["certificate.pem", "private-key"],
    ["private.key", "private-key"],
    ["identity.p12", "private-key"],
    ["id_ed25519", "private-key"],
    [".git/config", "\\.git contents"],
  ])("rejects forbidden exact credential path %s", async (relativePath, reason) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
    await fs.writeFile(path.join(cwd, relativePath), "fixture only\n", "utf8");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: [relativePath],
        dryRun: false,
      }),
    ).rejects.toThrow(new RegExp(`Exact --files path is forbidden: .*${reason}`));
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("redacts secrets in an allowed exact prior answer", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const relativePath = ".ask-pro/sessions/prior/ANSWER.md";
    await fs.mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
    await fs.writeFile(
      path.join(cwd, relativePath),
      "token=sk-testsecretsecretsecretsecret\n",
      "utf8",
    );

    const session = await createAskProSession({
      cwd,
      question: "Review the redacted answer.",
      filePatterns: [relativePath],
      dryRun: true,
    });

    const entries = readStoredZipEntries(await fs.readFile(path.join(session.dir, "CONTEXT.zip")));
    expect(entries.get(`context/${relativePath}`)?.toString("utf8")).toContain(
      "[REDACTED_OPENAI_KEY]",
    );
    expect(entries.get(`context/${relativePath}`)?.toString("utf8")).not.toContain(
      "sk-testsecretsecretsecretsecret",
    );
  });

  test("permits exact text files beneath discovery-only exclusions", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const paths = [
      "node_modules/pkg/index.js",
      "dist/report.txt",
      "build/result.txt",
      ".next/trace.txt",
      "target/notes.txt",
      "vendor/notes.md",
    ];
    for (const relativePath of paths) {
      await fs.mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
      await fs.writeFile(path.join(cwd, relativePath), `${relativePath}\n`, "utf8");
    }

    const session = await createAskProSession({
      cwd,
      question: "Review exact excluded-tree files.",
      filePatterns: paths,
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual(
      paths.sort().map((filePath) => ({
        path: filePath,
        reason: "Explicit file requested by --files.",
      })),
    );
  });

  test("supports a Windows-style exact path", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "windows.ts"), "export const windows = true;\n");

    const session = await createAskProSession({
      cwd,
      question: "Review this file.",
      filePatterns: [".\\src\\windows.ts"],
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual([
      { path: "src/windows.ts", reason: "Explicit file requested by --files." },
    ]);
  });

  test.each([".env", ".git/config"])(
    "rejects an exact symlink that disguises forbidden target %s",
    async (targetPath) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
      tempDirs.push(cwd);
      await fs.mkdir(path.dirname(path.join(cwd, targetPath)), { recursive: true });
      await fs.writeFile(path.join(cwd, targetPath), "credential fixture\n", "utf8");
      await fs.symlink(targetPath, path.join(cwd, "apparently-safe.txt"), "file");

      await expect(
        createAskProSession({
          cwd,
          question: "Review this file.",
          filePatterns: ["apparently-safe.txt"],
          dryRun: false,
        }),
      ).rejects.toThrow(/Exact --files path is forbidden: apparently-safe\.txt/);
      await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
    },
  );

  test("keeps discovery exclusions effective through in-project symlink aliases", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, ".ask-pro", "sessions", "prior"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".ask-pro", "sessions", "prior", "ANSWER.md"),
      "PRIVATE_PRIOR\n",
      "utf8",
    );
    await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".git", "config"), "PRIVATE_GIT\n", "utf8");
    await fs.writeFile(path.join(cwd, ".env"), "PRIVATE_ENV\n", "utf8");
    await fs.symlink(".ask-pro", path.join(cwd, "session-alias"), "dir");
    await fs.symlink(".git", path.join(cwd, "git-alias"), "dir");
    await fs.symlink(".env", path.join(cwd, "safe-looking.txt"), "file");
    const patterns = ["session-alias/**", "git-alias/**", "*.txt"];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const session = await createAskProSession({
      cwd,
      question: "Review discovery aliases.",
      filePatterns: patterns,
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual([]);
    for (const pattern of patterns) {
      expect(session.manifest.excludedFiles).toContainEqual({
        path: pattern,
        reason: "No attachable files matched this --files discovery input.",
      });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(pattern));
    }
    warning.mockRestore();
  });

  test("keeps nested dependency and build trees excluded from discovery", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const excludedPaths = [
      "packages/app/node_modules/pkg/index.js",
      "packages/app/dist/bundle.js",
      "packages/app/build/result.txt",
      "packages/app/.next/trace.txt",
      "packages/app/target/output.txt",
      "packages/app/vendor/notes.txt",
    ];
    for (const relativePath of excludedPaths) {
      await fs.mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
      await fs.writeFile(path.join(cwd, relativePath), "excluded\n", "utf8");
    }
    await fs.mkdir(path.join(cwd, "packages", "app", "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "packages", "app", "src", "main.ts"), "included\n");

    const session = await createAskProSession({
      cwd,
      question: "Review discovered source.",
      filePatterns: ["packages/**"],
      dryRun: true,
    });

    expect(session.manifest.includedFiles.map((file) => file.path)).toEqual([
      "packages/app/src/main.ts",
    ]);
  });

  test("rejects a file path swapped to a credential target during stable open", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const safePath = path.join(cwd, "safe.txt");
    await fs.writeFile(safePath, "safe\n", "utf8");
    await fs.writeFile(path.join(cwd, ".env"), "PRIVATE_ENV\n", "utf8");
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.unlink(safePath);
      await fs.symlink(".env", safePath, "file");
      return originalOpen(...args);
    });

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: ["safe.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/changed during validation/);
    openSpy.mockRestore();
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("deduplicates an exact symlink and a glob by resolved target", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "real.ts"), "export const real = true;\n");
    await fs.symlink("real.ts", path.join(cwd, "src", "alias.ts"), "file");

    const session = await createAskProSession({
      cwd,
      question: "Review this file.",
      filePatterns: ["src/**/*.ts", "src/alias.ts"],
      dryRun: true,
    });

    expect(session.manifest.includedFiles).toEqual([
      { path: "src/alias.ts", reason: "Explicit file requested by --files." },
    ]);
    const zip = await fs.readFile(path.join(session.dir, "CONTEXT.zip"));
    const contextEntries = [...readStoredZipEntries(zip).keys()].filter((entry) =>
      entry.startsWith("context/"),
    );
    expect(contextEntries).toEqual(["context/src/alias.ts"]);
    expect(countStoredZipEntries(zip, "context/src/alias.ts")).toBe(1);
  });

  test.each([
    ["binary.dat", Buffer.from([0x61, 0x00, 0x62]), /not a regular text file/],
    ["invalid-utf8.txt", Buffer.from([0xff, 0xfe]), /not valid UTF-8 text/],
  ])("rejects non-text exact file %s", async (relativePath, content, expected) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, relativePath as string), content as Buffer);

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: [relativePath as string],
        dryRun: false,
      }),
    ).rejects.toThrow(expected as RegExp);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test.runIf(process.platform !== "win32")(
    "rejects an unreadable exact file before creating a consultation",
    async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
      tempDirs.push(cwd);
      const filePath = path.join(cwd, "unreadable.txt");
      await fs.writeFile(filePath, "unreadable\n", "utf8");
      await fs.chmod(filePath, 0o000);

      await expect(
        createAskProSession({
          cwd,
          question: "Review this file.",
          filePatterns: ["unreadable.txt"],
          dryRun: false,
        }),
      ).rejects.toThrow(/Exact --files path is unreadable: unreadable\.txt/);
      await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
    },
  );

  test("rejects an oversized individual input before reading it", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const filePath = path.join(cwd, "oversized.txt");
    await fs.writeFile(filePath, "x", "utf8");
    await fs.truncate(filePath, MAX_CONTEXT_BYTES + 1);

    await expect(
      createAskProSession({
        cwd,
        question: "Review this file.",
        filePatterns: ["oversized.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/oversized\.txt.*per-file context limit.*20 MiB/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("rejects oversized aggregate input before reading files", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const eachSize = Math.floor(MAX_CONTEXT_BYTES / 2) + 1;
    for (const relativePath of ["first.txt", "second.txt"]) {
      const filePath = path.join(cwd, relativePath);
      await fs.writeFile(filePath, "x", "utf8");
      await fs.truncate(filePath, eachSize);
    }

    await expect(
      createAskProSession({
        cwd,
        question: "Review these files.",
        filePatterns: ["first.txt", "second.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/aggregate context limit.*20 MiB/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("rejects a final context zip that exceeds the shared upload ceiling", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.writeFile(
      path.join(cwd, "nearly-limit.txt"),
      "a".repeat(MAX_CONTEXT_BYTES - 256),
      "utf8",
    );

    await expect(
      createAskProSession({
        cwd,
        question: "Review this nearly full context bundle.",
        filePatterns: ["nearly-limit.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/CONTEXT\.zip.*context bundle limit.*20 MiB/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).resolves.toEqual([]);
  }, 30_000);

  test("preserves prompt text without injecting a response zip request", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const question = "\nLine one\n\nLine two with the real advisory question.\n";

    const session = await createAskProSession({
      cwd,
      question,
      filePatterns: [],
      dryRun: true,
    });

    const prompt = await fs.readFile(path.join(session.dir, "PROMPT.md"), "utf8");
    expect(prompt.startsWith(question)).toBe(true);
    expect(prompt).not.toContain("ask-pro-response.zip");
    expect(prompt).not.toContain("IMPLEMENTATION_PLAN.md");
  });

  test("adds response zip instructions only when artifacts are requested", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);

    const session = await createAskProSession({
      cwd,
      question: "Return an implementation package.",
      filePatterns: [],
      dryRun: true,
      artifacts: true,
    });

    const prompt = await fs.readFile(path.join(session.dir, "PROMPT.md"), "utf8");
    expect(prompt).toContain("ask-pro-response.zip");
    expect(prompt).toContain("IMPLEMENTATION_PLAN.md");
    expect(session.status.artifacts).toBe(true);
  });

  test("creates distinct sessions for the same question in the same second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T14:20:00.123Z"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);

    const first = await createAskProSession({
      cwd,
      question: "Review this billing queue plan.",
      filePatterns: [],
      dryRun: true,
    });
    const second = await createAskProSession({
      cwd,
      question: "Review this billing queue plan.",
      filePatterns: [],
      dryRun: true,
    });

    expect(first.id).toMatch(/^2026-05-01T142000-review-this-billing-queue-plan-[a-f0-9]{8}$/);
    expect(second.id).toMatch(/^2026-05-01T142000-review-this-billing-queue-plan-[a-f0-9]{8}$/);
    expect(second.id).not.toBe(first.id);
    expect((await fs.stat(first.dir)).isDirectory()).toBe(true);
    expect((await fs.stat(second.dir)).isDirectory()).toBe(true);
  });

  test("reads the latest session by creation metadata instead of directory name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T14:20:00.123Z"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);

    const first = await createAskProSession({
      cwd,
      question: "Zzz older question.",
      filePatterns: [],
      dryRun: true,
    });
    const second = await createAskProSession({
      cwd,
      question: "Aaa newer question.",
      filePatterns: [],
      dryRun: true,
    });
    expect(first.id.localeCompare(second.id)).toBeGreaterThan(0);

    for (const [session, createdAt] of [
      [first, "2026-05-01T14:20:00.000Z"],
      [second, "2026-05-01T14:20:00.001Z"],
    ] as const) {
      const statusPath = path.join(session.dir, "status.json");
      const status = JSON.parse(await fs.readFile(statusPath, "utf8")) as Record<string, unknown>;
      await fs.writeFile(
        statusPath,
        `${JSON.stringify({ ...status, createdAt, updatedAt: createdAt }, null, 2)}\n`,
        "utf8",
      );
    }

    await expect(readAskProStatus({ cwd })).resolves.toMatchObject({
      status: { sessionId: second.id },
    });
  });

  test("rejects path-like session ids before resolving session files", async () => {
    const cwd = path.join(os.tmpdir(), "ask-pro-missing-session-root");
    const invalidIds = ["", ".", "..", "../escape", "nested/id", "nested\\id", "bad.id"];

    for (const sessionId of invalidIds) {
      expect(() => getAskProSessionPaths(cwd, sessionId)).toThrow(/Invalid ask-pro session id/);
      await expect(readAskProStatus({ cwd, sessionId })).rejects.toThrow(
        /Invalid ask-pro session id/,
      );
      await expect(updateAskProStatus({ cwd, sessionId, status: "COMPLETED" })).rejects.toThrow(
        /Invalid ask-pro session id/,
      );
    }
  });

  test("normalizes Windows-style file and directory patterns", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "nested", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(cwd, "src", "b.ts"), "export const b = 2;\n");

    const session = await createAskProSession({
      cwd,
      question: "Review these files.",
      filePatterns: [
        path.join(cwd, "src", "nested", "a.ts"),
        ".\\src\\b.ts",
        path.join(cwd, "src", "nested"),
      ],
      dryRun: true,
    });

    expect(session.manifest.includedFiles.map((file) => file.path)).toEqual([
      "src/b.ts",
      "src/nested/a.ts",
    ]);
  });

  test("keeps absolute project-root directory patterns scoped to the project", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "rooted.ts"), "export const rooted = true;\n");

    const session = await createAskProSession({
      cwd,
      question: "Review the project.",
      filePatterns: [cwd],
      dryRun: true,
    });

    expect(session.manifest.includedFiles.map((file) => file.path)).toEqual(["src/rooted.ts"]);
    expect(session.manifest.includedFiles.some((file) => path.isAbsolute(file.path))).toBe(false);
  });

  test("supports absolute in-project brace glob alternatives", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "a.ts"), "export const a = true;\n");
    await fs.writeFile(path.join(cwd, "src", "b.ts"), "export const b = true;\n");

    const session = await createAskProSession({
      cwd,
      question: "Review these files.",
      filePatterns: [path.join(cwd, "src", "{a,b}.ts")],
      dryRun: true,
    });

    expect(session.manifest.includedFiles.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("rejects absolute file paths outside the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-outside-"));
    tempDirs.push(cwd, other);
    await fs.writeFile(path.join(other, "outside.ts"), "export const outside = true;\n");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: [path.join(other, "outside.ts")],
        dryRun: true,
      }),
    ).rejects.toThrow(/inside the project cwd/);
  });

  test("rejects parent-relative file paths outside the project cwd", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-parent-"));
    const cwd = path.join(parent, "repo");
    const sibling = path.join(parent, "sibling");
    await fs.mkdir(cwd);
    await fs.mkdir(sibling);
    tempDirs.push(parent);
    await fs.writeFile(path.join(sibling, "outside.ts"), "export const outside = true;\n");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: ["../sibling/outside.ts"],
        dryRun: true,
      }),
    ).rejects.toThrow(/inside the project cwd/);
  });

  test.each([
    "../sibling/**/*.ts",
    "..\\sibling\\**\\*.ts",
    "../missing/**/*.ts",
    "src/*/../../../sibling/**/*.ts",
    "{src,../sibling}/**/*.ts",
    "src/*/{..,a}/../../sibling/**/*.ts",
    "src/*/@(..)/../../sibling/**/*.ts",
    "src/@(..|a)/../sibling/**/*.ts",
    "src/@(?(a))/../../sibling/**/*.ts",
    "src/{,a}/../../sibling/**/*.ts",
    "src/{a/../../../sibling,a}/**/*.ts",
    "src/?(a)/../../sibling/**/*.ts",
    "src/@(a|)/../../sibling/**/*.ts",
    "src/!(a)/../../sibling/**/*.ts",
    "src/@(a|@(b|))/../../sibling/**/*.ts",
    "src/?(a)../../sibling/**/*.ts",
    "src/@(?(a))../../sibling/**/*.ts",
    "src/@(a|@(b|))../../sibling/**/*.ts",
    "src/@(@(a|).)./../sibling/**/*.ts",
    "src/@(a|@(b|c)|)../../sibling/**/*.ts",
    "src/@(?()../..)/sibling/**/*.ts",
    "src/@(@(a|)/../../sibling|a)/**/*.ts",
    "src/+(a/../../sibling|b)/**/*.ts",
    "{src,C:/outside}/**/*.ts",
  ])("rejects outside project glob pattern %s", async (pattern) => {
    const cwd = await createRepoWithOutsideSibling();

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: [pattern],
        dryRun: true,
      }),
    ).rejects.toThrow(/inside the project cwd/);
  });

  test("does not reject glob patterns with parent segments that stay inside the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src", "a"), { recursive: true });
    await fs.writeFile(path.join(cwd, "src", "root.ts"), "export const root = true;\n");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: ["src/*/../*.ts"],
        dryRun: true,
      }),
    ).resolves.toMatchObject({ status: { status: "DRY_RUN_COMPLETE" } });
  });

  test.each(["src/{..,a}/**/*.ts"])(
    "does not reject in-project parent alternative glob %s",
    async (pattern) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
      tempDirs.push(cwd);
      await fs.mkdir(path.join(cwd, "src", "a"), { recursive: true });

      await expect(
        createAskProSession({
          cwd,
          question: "Review this.",
          filePatterns: [pattern],
          dryRun: true,
        }),
      ).resolves.toMatchObject({ status: { status: "DRY_RUN_COMPLETE" } });
    },
  );

  test("does not reject in-project brace ranges with dot-dot text", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: ["src/{a..z}/**/*.ts"],
        dryRun: true,
      }),
    ).resolves.toMatchObject({ status: { status: "DRY_RUN_COMPLETE" } });
  });

  test("allows parent segments that resolve inside the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    await fs.mkdir(path.join(cwd, "src"), { recursive: true });
    await fs.writeFile(path.join(cwd, "README.md"), "# Inside\n");

    const session = await createAskProSession({
      cwd,
      question: "Review this.",
      filePatterns: ["src/../README.md"],
      dryRun: true,
    });

    expect(session.manifest.includedFiles.map((file) => file.path)).toEqual(["README.md"]);
  });

  test("rejects absolute symlinked file paths that resolve outside the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-outside-"));
    tempDirs.push(cwd, other);
    await fs.writeFile(path.join(other, "outside.ts"), "export const outside = true;\n");
    const link = path.join(cwd, "outside-link");
    await fs.symlink(other, link, process.platform === "win32" ? "junction" : "dir");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: [link],
        dryRun: true,
      }),
    ).rejects.toThrow(/inside the project cwd/);
  });

  test("rejects a relative exact file symlink that escapes the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-outside-"));
    tempDirs.push(cwd, other);
    const outside = path.join(other, "outside.txt");
    await fs.writeFile(outside, "outside\n", "utf8");
    await fs.symlink(outside, path.join(cwd, "outside.txt"), "file");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: ["outside.txt"],
        dryRun: false,
      }),
    ).rejects.toThrow(/inside the project cwd/);
    await expect(fs.readdir(path.join(cwd, ".ask-pro", "sessions"))).rejects.toThrow();
  });

  test("rejects glob matches that traverse symlinked directories outside the project cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-outside-"));
    tempDirs.push(cwd, other);
    await fs.writeFile(path.join(other, "outside.ts"), "export const outside = true;\n");
    const link = path.join(cwd, "outside-link");
    await fs.symlink(other, link, process.platform === "win32" ? "junction" : "dir");

    await expect(
      createAskProSession({
        cwd,
        question: "Review this.",
        filePatterns: ["outside-link/**/*.ts"],
        dryRun: true,
      }),
    ).rejects.toThrow(/inside the project cwd/);
  });

  test("reads latest status and answer", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Return a plan.",
      filePatterns: [],
      dryRun: true,
    });

    const latest = await readAskProStatus({ cwd });
    expect(latest.status.sessionId).toBe(session.id);

    const answer = await readAskProAnswer({ cwd, sessionId: session.id });
    expect(answer.answer).toContain("No browser submission");
  });

  test("clears stale reason when a later status has no reason", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-session-reason-"));
    tempDirs.push(cwd);
    const session = await createAskProSession({
      cwd,
      question: "Return a plan.",
      filePatterns: [],
      dryRun: true,
    });

    await updateAskProStatus({
      cwd,
      sessionId: session.id,
      status: "WAIT_TIMED_OUT",
      reason: "assistant_timeout",
    });
    const completed = await updateAskProStatus({
      cwd,
      sessionId: session.id,
      status: "COMPLETED",
    });

    expect(completed).not.toHaveProperty("reason");
    const { status } = await readAskProStatus({ cwd, sessionId: session.id });
    expect(status).not.toHaveProperty("reason");
  });
});
