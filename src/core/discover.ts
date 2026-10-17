import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Find the newest `.hap` under a directory (bounded search, ignores build caches). */
export async function findNewestHap(root: string, maxDepth = 7): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "oh_modules") continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".hap")) {
        try {
          const info = await stat(full);
          if (!best || info.mtimeMs > best.mtime) best = { path: full, mtime: info.mtimeMs };
        } catch {
          /* ignore */
        }
      }
    }
  };

  await walk(root, 0);
  return best ? (best as { path: string; mtime: number }).path : null;
}
