import DiffMatchPatch from "diff-match-patch";

/**
 * Three-way merge of a text that changed on two devices since they last agreed ("base"): `local` is this device's
 * version, `remote` the one from the server. Works like git's diff3 on lines - edits to different places are combined,
 * identical edits count once - and where both sides changed the same lines it tries a word-level merge of just those
 * lines (diff-match-patch). Returns `null` when some lines were changed differently on both sides and cannot be
 * combined without guessing; the caller then keeps both versions (e.g. as a conflict copy).
 */
export function merge3(base: string, local: string, remote: string): string | null {
  // Line endings are not content: a file saved by a Windows program (CRLF) must not make every line look changed.
  if (base.includes("\r") || local.includes("\r") || remote.includes("\r")) {
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    const merged = merge3(lf(base), lf(local), lf(remote));
    return merged !== null && local.includes("\r\n") ? merged.replace(/\n/g, "\r\n") : merged;
  }
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;

  const b = base.split("\n");
  const l = local.split("\n");
  const r = remote.split("\n");
  const matchL = matchLines(b, l);
  const matchR = matchLines(b, r);
  if (!matchL || !matchR) return null; // too large to compare

  const out: string[] = [];
  // Previous sync point: a base line that both sides kept (at positions pl / pr), so the stretch up to the next one
  // can be decided on its own.
  let pb = -1;
  let pl = -1;
  let pr = -1;
  for (let i = 0; i <= b.length; i++) {
    const atEnd = i === b.length;
    if (!atEnd && (matchL[i] < 0 || matchR[i] < 0)) continue;
    const nl = atEnd ? l.length : matchL[i];
    const nr = atEnd ? r.length : matchR[i];

    const region = resolveRegion(b.slice(pb + 1, i), l.slice(pl + 1, nl), r.slice(pr + 1, nr));
    if (!region) return null;
    out.push(...region);
    if (!atEnd) out.push(b[i]);
    pb = i;
    pl = nl;
    pr = nr;
  }
  return out.join("\n");
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, i) => line === y[i]);

/** One stretch between two sync points: whoever changed it wins; both changed it differently -> try a finer merge. */
function resolveRegion(base: string[], local: string[], remote: string[]): string[] | null {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  // Same number of lines on all three sides (ticked tasks, edited lines): decided line by line, so edits of
  // neighbouring lines - or the very same edit on both sides - combine instead of counting as a conflict.
  if (local.length === base.length && remote.length === base.length) {
    const lines: string[] = [];
    for (let k = 0; k < base.length; k++) {
      if (local[k] === remote[k] || remote[k] === base[k]) lines.push(local[k]);
      else if (local[k] === base[k]) lines.push(remote[k]);
      else {
        const word = mergeWords(base[k], local[k], remote[k]);
        if (word === null) return null;
        lines.push(word);
      }
    }
    return lines;
  }
  const refined = mergeWords(base.join("\n"), local.join("\n"), remote.join("\n"));
  return refined === null ? null : refined.split("\n");
}

/** Re-applies the local edit of a stretch onto the remote one; only accepted when every single edit fits exactly. */
function mergeWords(base: string, local: string, remote: string): string | null {
  // Pure insertions / deletions of whole lines at the same spot are real conflicts - word merging would only guess.
  if (base === "") return null;
  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = 0; // exact context only
  dmp.Patch_DeleteThreshold = 0;
  const patches = dmp.patch_make(base, dmp.diff_main(base, local));
  const [merged, applied] = dmp.patch_apply(patches, remote);
  return applied.every(Boolean) ? merged : null;
}

/**
 * For each line of `a`, the index of the line of `b` it is matched to (longest common subsequence), or -1. Null when the
 * texts are too different/large to align cheaply.
 */
function matchLines(a: string[], b: string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    match[head] = head;
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    match[a.length - 1 - tail] = b.length - 1 - tail;
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length * midB.length > 4_000_000) return null;

  const w = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * w);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      match[head + i] = head + j;
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  return match;
}
