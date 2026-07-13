import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MAX_CONTEXT_BYTES } from "../../src/ask-pro/limits.js";
import { transferAttachmentViaDataTransfer } from "../../src/browser/actions/attachmentDataTransfer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("rejects an oversized data-transfer attachment before browser evaluation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ask-pro-transfer-size-"));
  tempDirs.push(cwd);
  const attachmentPath = path.join(cwd, "oversized.zip");
  await fs.writeFile(attachmentPath, "x", "utf8");
  await fs.truncate(attachmentPath, MAX_CONTEXT_BYTES + 1);
  const evaluate = vi.fn();

  await expect(
    transferAttachmentViaDataTransfer(
      { evaluate } as never,
      { path: attachmentPath, displayPath: "CONTEXT.zip" },
      (() => undefined) as never,
    ),
  ).rejects.toThrow(/oversized\.zip.*too large for data transfer/);
  expect(evaluate).not.toHaveBeenCalled();
});
