// Sync: make one machine's checkout of a repository look exactly like
// another's, uncommitted work included.
//
// "I changed it here, build it there" needs the other machine to have this
// machine's working tree: the branch, the commits that are not pushed, the
// edits that are not committed, the new files nobody has added yet. Pushing is
// not that (half-done work does not belong on the remote), and a file watcher
// that mirrors every keystroke is not either: it would feed a compiler files
// mid-edit. So sync is a step someone takes, in one direction they name.
//
// How:
//   1. The source's working tree is read into a snapshot commit through a
//      temporary index: tracked and untracked files, ignored ones left out.
//      Its own index, HEAD and files are not touched.
//   2. Whatever of that the destination lacks travels as one git bundle
//      (channel.ts), so only the difference moves, compressed.
//   3. The destination's working tree is moved to the snapshot's tree, and its
//      branch and HEAD to the source's. `git status` then reads the same on
//      both machines (staging is not carried: what was staged arrives as an
//      ordinary modification).
//
// What it will not do is destroy work. The destination is replaced only when
// its content is something sync already knows: the last state synced with it,
// its own clean HEAD, or the incoming state itself. Changes or commits of its
// own are a refusal that names them, and the caller decides: sync the other
// way first, or say `overwrite`. Even then the replaced state is kept as a
// commit (refs/canopy/sync/<key>/backup) so it can be brought back.
//
// Ignored files do not travel. That is what keeps build output and installed
// dependencies on the machine that made them; a `.env` the build needs is a
// file to copy by name (recipe.ts `carry`).
import { ChannelError, copyStaged, mustSh, parseFields, shOn, stagingName, STAGING, joinPath, type Checkout, type CopyProgress } from "./channel";

/** A short stable name for a working tree, for its refs. Worktrees of one
 *  repository share refs, so each needs its own. */
export function checkoutKey(top: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < top.length; i++) {
    const c = top.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// The working tree as a tree object, through a throwaway index seeded from the
// real one (so only changed files are hashed again). Leaves `$tree` set.
const READ_TREE = `
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
work="$common/${STAGING}"
mkdir -p "$work"
idx="$work/index.$$"
trap 'rm -f "$idx" "$idx.lock"' EXIT
real=$(git rev-parse --git-path index)
if [ -f "$real" ]; then cp "$real" "$idx"; fi
GIT_INDEX_FILE="$idx" git add -A . >/dev/null
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
rm -f "$idx"
`;

const IDENTITY = `
export GIT_AUTHOR_NAME=Canopy GIT_AUTHOR_EMAIL=sync@canopy.invalid GIT_COMMITTER_NAME=Canopy GIT_COMMITTER_EMAIL=sync@canopy.invalid
export GIT_AUTHOR_DATE='2000-01-01T00:00:00 +0000' GIT_COMMITTER_DATE='2000-01-01T00:00:00 +0000'
`;

// $1 key, $2 a commit to look for ("-" for none). Prints the checkout's state.
// The snapshot commit has fixed dates and a fixed author, so the same content
// on the same HEAD is always the same commit.
const STATE = `set -e
key=$1
want=$2
head=$(git rev-parse --verify -q HEAD || true)
if [ -z "$head" ]; then echo 'nohead=1'; exit 0; fi
branch=$(git symbolic-ref --short -q HEAD || true)
${READ_TREE}
${IDENTITY}
snap=$(git -c commit.gpgsign=false commit-tree "$tree" -p "$head" -m 'Canopy sync snapshot')
printf 'head=%s\\nbranch=%s\\ntree=%s\\nsnap=%s\\n' "$head" "$branch" "$tree" "$snap"
printf 'headtree=%s\\n' "$(git rev-parse "$head^{tree}")"
last=$(git rev-parse --verify -q "refs/canopy/sync/$key/last" || true)
if [ -n "$last" ]; then
  printf 'last=%s\\nlasttree=%s\\n' "$last" "$(git rev-parse "$last^{tree}")"
  printf 'basis=%s\\n' "$last"
fi
printf 'basis=%s\\n' "$head"
git for-each-ref --count=48 --sort=-committerdate --format='basis=%(objectname)' refs/remotes
if [ "$want" != "-" ] && git cat-file -e "$want^{commit}" 2>/dev/null; then echo 'haswant=1'; fi
`;

// $1 key, $2 snapshot, $3 bundle name, $4.. commits the destination has.
const BUNDLE = `set -e
key=$1; snap=$2; name=$3; shift 3
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
work="$common/${STAGING}"
mkdir -p "$work"
git update-ref "refs/canopy/sync/$key/out" "$snap"
have=""
for c in "$@"; do
  if git cat-file -e "$c^{commit}" 2>/dev/null; then have="$have ^$c"; fi
done
git bundle create -q "$work/$name" "refs/canopy/sync/$key/out" $have
printf 'size=%s\\n' "$(wc -c < "$work/$name" | tr -d ' ')"
`;

// $1 key, $2 base tree, $3 current tree: what the destination changed itself.
const OWN_CHANGES = `git diff --name-status "$1" "$2" | head -40`;

// $1 key, $2 snapshot, $3 source HEAD, $4 source branch ("-" when detached),
// $5 overwrite (1/0), $6 bundle name ("-" when nothing travelled), $7 source key.
// Checks and applies in one run, so nothing can change between the two.
const APPLY = `set -e
key=$1; snap=$2; shead=$3; sbranch=$4; overwrite=$5; bundle=$6; skey=$7
if [ "$sbranch" = "-" ]; then sbranch=""; fi
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
if [ "$bundle" != "-" ]; then
  git fetch -q --no-tags "$common/${STAGING}/$bundle" "+refs/canopy/sync/$skey/out:refs/canopy/sync/$key/in"
  rm -f "$common/${STAGING}/$bundle"
fi
if ! git cat-file -e "$snap^{commit}" 2>/dev/null; then echo 'refuse=missing'; exit 0; fi
head=$(git rev-parse --verify -q HEAD || true)
cur=$(git symbolic-ref --short -q HEAD || true)
${READ_TREE}
stree=$(git rev-parse "$snap^{tree}")
headtree=""; if [ -n "$head" ]; then headtree=$(git rev-parse "$head^{tree}"); fi
lasttree=$(git rev-parse --verify -q "refs/canopy/sync/$key/last^{tree}" || true)
lastparent=$(git rev-parse --verify -q "refs/canopy/sync/$key/last^" || true)

if [ -n "$sbranch" ] && [ "$cur" != "$sbranch" ]; then
  if git worktree list --porcelain | grep -qxF "branch refs/heads/$sbranch"; then
    echo 'refuse=branch-in-use'; exit 0
  fi
fi

reason=""
if [ "$tree" != "$stree" ] && [ "$tree" != "$lasttree" ] && [ "$tree" != "$headtree" ]; then reason=changes; fi
if [ -z "$reason" ] && [ -n "$head" ] && [ "$head" != "$shead" ] && [ "$head" != "$lastparent" ] \\
   && ! git merge-base --is-ancestor "$head" "$shead"; then reason=commits; fi
if [ -z "$reason" ] && [ -n "$sbranch" ] && [ "$cur" != "$sbranch" ]; then
  tip=$(git rev-parse --verify -q "refs/heads/$sbranch" || true)
  if [ -n "$tip" ] && [ "$tip" != "$shead" ] && ! git merge-base --is-ancestor "$tip" "$shead"; then reason=branch-commits; fi
fi
if [ -n "$reason" ] && [ "$overwrite" != 1 ]; then
  echo "refuse=$reason"
  if [ "$reason" = changes ]; then
    base=$lasttree; if [ -z "$base" ]; then base=$headtree; fi
    git diff --name-status "$base" "$tree" | head -40 | sed 's/^/own=/'
  elif [ "$reason" = commits ]; then
    git log --oneline -n 10 "$head" --not "$shead" | sed 's/^/own=/'
  else
    git log --oneline -n 10 "$tip" --not "$shead" | sed 's/^/own=/'
  fi
  exit 0
fi

changed=0
if [ "$tree" != "$stree" ]; then
  if [ -n "$head" ]; then
    ${IDENTITY}
    backup=$(git -c commit.gpgsign=false commit-tree "$tree" -p "$head" -m 'Canopy sync: this checkout before a sync')
    git update-ref "refs/canopy/sync/$key/backup" "$backup"
  fi
  changed=$(git diff --name-only "$tree" "$stree" | wc -l | tr -d ' ')
  git add -A . >/dev/null
  if [ "$overwrite" = 1 ]; then git read-tree --reset -u "$tree" "$stree"; else git read-tree -m -u "$tree" "$stree"; fi
fi
if [ -n "$sbranch" ]; then
  if [ "$cur" != "$sbranch" ]; then git symbolic-ref HEAD "refs/heads/$sbranch"; fi
  git update-ref "refs/heads/$sbranch" "$shead"
else
  git update-ref --no-deref HEAD "$shead"
fi
git reset -q "$shead"
git update-ref "refs/canopy/sync/$key/last" "$snap"
printf 'applied=1\\nchanged=%s\\n' "$changed"
`;

// $1 key, $2 snapshot, $3 bundle name ("-" for none).
const RECORD = `set -e
git update-ref "refs/canopy/sync/$1/last" "$2"
if [ "$3" != "-" ]; then rm -f "$(cd "$(git rev-parse --git-common-dir)" && pwd -P)/${STAGING}/$3"; fi
`;

export interface SyncResult {
  /** Nothing had to move: both checkouts already held the same state. */
  alreadyInSync: boolean;
  /** Files that differ between what the destination had and what it has now. */
  changedFiles: number;
  /** The branch both are on now ("" when the source is detached). */
  branch: string;
  /** The commit both are at now. */
  head: string;
  /** The snapshot both hold: the commit that is `head` plus uncommitted work. */
  snapshot: string;
  /** Bytes that travelled (0 when the destination already had every object). */
  bytes: number;
}

/** Why a sync was refused, in words. */
function refusal(reason: string, own: string[], from: Checkout, to: Checkout): ChannelError {
  const there = `${to.machine.name} (${to.top})`;
  const list = own.length ? own.join("\n") : undefined;
  switch (reason) {
    case "changes":
      return new ChannelError(
        `${there} has changes of its own that this sync would replace. Sync them back to ${from.machine.name} first, or sync with overwrite to replace them (they are kept as a backup commit).`,
        list,
      );
    case "commits":
      return new ChannelError(
        `${there} has commits that ${from.machine.name} does not have. Sync them back first, or sync with overwrite to move it to ${from.machine.name}'s branch anyway.`,
        list,
      );
    case "branch-commits":
      return new ChannelError(
        `The branch on ${there} has commits that ${from.machine.name} does not have. Sync them back first, or sync with overwrite.`,
        list,
      );
    case "branch-in-use":
      return new ChannelError(`The branch is checked out in another worktree on ${to.machine.name}; sync into that worktree instead.`);
    default:
      return new ChannelError(`${there} did not receive the state to apply.`);
  }
}

/** Make `to` hold exactly what `from` holds. One direction; `from` is only read. */
export async function syncCheckout(
  from: Checkout,
  to: Checkout,
  opts: { overwrite?: boolean; onProgress?: CopyProgress } = {},
): Promise<SyncResult> {
  if (to.machine.readOnly) throw new ChannelError(`${to.machine.name} is connected view-only, so nothing can be synced to it.`);
  if (from.machine.id === to.machine.id && from.top === to.top) throw new ChannelError("That is the same checkout: there is nothing to sync.");
  const fromKey = checkoutKey(from.top);
  const toKey = checkoutKey(to.top);

  const source = parseFields(await mustSh(from.machine, from.top, STATE, [fromKey, "-"], "Reading the working tree")).one;
  if (source.nohead) throw new ChannelError(`${from.top} on ${from.machine.name} has no commits yet, so there is nothing to sync from.`);
  const there = parseFields(await mustSh(to.machine, to.top, STATE, [toKey, source.snap], "Reading the working tree"));
  const dest = there.one;

  // Refused before anything travels, when the answer is already known.
  if (!opts.overwrite && !dest.nohead && dest.tree !== source.tree && dest.tree !== dest.lasttree && dest.tree !== dest.headtree) {
    const own = await shOn(to.machine, to.top, OWN_CHANGES, [dest.lasttree || dest.headtree, dest.tree], { head: true }).catch(() => null);
    throw refusal("changes", own?.stdout.split("\n").filter(Boolean) ?? [], from, to);
  }

  const identical = dest.tree === source.tree && dest.head === source.head && (dest.branch ?? "") === (source.branch ?? "");
  let bundle = "-";
  let bytes = 0;
  if (!dest.haswant) {
    bundle = stagingName("bundle");
    const basis = dest.nohead ? [] : (there.all.basis ?? []);
    await mustSh(from.machine, from.top, BUNDLE, [fromKey, source.snap, bundle, ...basis.slice(0, 64)], "Packing the changes", { timeoutMs: 10 * 60 * 1000 });
    try {
      bytes = await copyStaged(from, to, bundle, opts.onProgress);
    } catch (error) {
      await shOn(from.machine, from.top, 'rm -f -- "$1"', [joinPath(from.common, STAGING, bundle)]).catch(() => undefined);
      throw error;
    }
  }

  const applied = parseFields(
    await mustSh(
      to.machine,
      to.top,
      APPLY,
      [toKey, source.snap, source.head, source.branch || "-", opts.overwrite ? "1" : "0", bundle, fromKey],
      "Applying the changes",
      { timeoutMs: 10 * 60 * 1000 },
    ),
  );
  await shOn(from.machine, from.top, RECORD, [fromKey, source.snap, bundle]).catch(() => undefined);
  if (applied.one.refuse) throw refusal(applied.one.refuse, applied.all.own ?? [], from, to);
  if (!applied.one.applied) throw new ChannelError(`${to.machine.name} did not confirm the sync.`);

  return {
    alreadyInSync: identical,
    changedFiles: Number(applied.one.changed) || 0,
    branch: source.branch ?? "",
    head: source.head,
    snapshot: source.snap,
    bytes,
  };
}
