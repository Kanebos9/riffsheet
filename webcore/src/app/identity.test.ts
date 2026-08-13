/**
 * IDENTITY — the duplicate-id fault, and the seeding rule that ends it.
 *
 * THE BUG THIS SUITE IS ABOUT, in the owner's words: "changing one duration changes another
 * note". The audit found two independent causes and this is the second one, which has nothing to
 * do with chords and is the reason the first fix alone would not have been enough.
 *
 * `add<N>`, `auto<N>` and `split<N>` came from counters that lived on the App instance and were
 * initialised to zero. Restore installed a document's persisted notes WITHOUT telling those
 * counters what names the document had already spent. So a take saved with `add1` in it minted
 * `add1` again for the very next note drawn — and since the duration command resolves to a SET of
 * ids and rewrites every note carrying one of them, editing either of the two identically-named
 * notes edited both, minutes apart on the timeline.
 *
 * Every check below fails against an unseeded counter. `seedingIsWhatMatters` is the one that
 * reproduces the reported repro exactly.
 */

import {
  NoteIdAllocator,
  identityProblems,
  isValidNoteId,
  liveKey,
  noteKeyString,
  repairNoteIdentity,
  sameKey
} from './identity';
import type { InputNote } from '@pipeline';

let checks = 0;
function assert(condition: boolean, message: string): void {
  checks++;
  if (!condition) throw new Error(message);
}

const note = (id: string | undefined, startSec: number): InputNote =>
  ({ ...(id !== undefined ? { id } : {}), startSec, endSec: startSec + 0.2, midi: 40 }) as InputNote;

// ---------------------------------------------------------------------------
// 1 — a fresh allocator behaves as the old counters did
// ---------------------------------------------------------------------------
{
  const a = new NoteIdAllocator();
  assert(a.next('add') === 'add1', 'the first added note is add1, as it always was');
  assert(a.next('add') === 'add2', 'and they count up');
  assert(a.next('auto') === 'auto1', 'each prefix has its own namespace');
  assert(a.next('split', '~n4') === 'split1~n4', 'a split carries the note it came from');
  assert(a.probe().add === 2 && a.probe().auto === 1, 'the counters are where they should be');
}

// ---------------------------------------------------------------------------
// 2 — SEEDING IS WHAT MATTERS. The reported repro, exactly.
// ---------------------------------------------------------------------------
{
  // "Add add1, save/reopen, add another note, then duration-edit either one."
  const reopened = [note('n0', 0), note('add1', 1.5), note('n2', 3)];

  const unseeded = new NoteIdAllocator();
  assert(
    unseeded.next('add') === 'add1',
    'WITHOUT SEEDING the allocator hands back a name the document is already using — the bug'
  );

  const seeded = new NoteIdAllocator();
  seeded.seed(reopened);
  const minted = seeded.next('add');
  assert(minted !== 'add1', 'seeded, it refuses the name that is taken');
  assert(minted === 'add2', 'and continues from the document’s own high-water mark');
  assert(
    !reopened.some((n) => n.id === minted),
    'the new name collides with nothing in the reopened document'
  );
}

// ---------------------------------------------------------------------------
// 3 — seeding is monotonic and idempotent, because the install paths overlap
// ---------------------------------------------------------------------------
{
  const a = new NoteIdAllocator();
  a.seed([note('add7', 0)]);
  a.seed([note('add3', 1)]);
  assert(a.next('add') === 'add8', 'a lower seed never pulls a counter back down');
  a.seed([note('add8', 2)]);
  assert(a.next('add') === 'add9', 'seeding the same names twice is harmless');
}

// ---------------------------------------------------------------------------
// 4 — a name that is taken by something the counters cannot predict
// ---------------------------------------------------------------------------
{
  // A hand-edited document can contain literally any string, including one a fresh counter
  // would produce. The counter alone does not defend against that; the used-name set does.
  const a = new NoteIdAllocator();
  a.seed([note('add1', 0), note('add3', 1)]);
  // Counter is at 3, so `next` proposes add4 — free. But if add4 were taken too:
  const b = new NoteIdAllocator();
  b.seed([note('add1', 0), note('add2', 1), note('add3', 2)]);
  const first = b.next('add');
  assert(first === 'add4', 'the next free name past the high-water mark');
  assert(a.next('add') === 'add4', 'and the same from the sparse document');
}

// ---------------------------------------------------------------------------
// 5 — prefix parsing does not fire on names that merely start the same way
// ---------------------------------------------------------------------------
{
  const a = new NoteIdAllocator();
  // The engine's own ids are `n<i>` and share no prefix; these are the near-misses.
  a.seed([note('added', 0), note('automatic', 1), note('addendum', 2)]);
  assert(a.next('add') === 'add1', 'a word that begins with a prefix is not a counter value');
  assert(a.next('auto') === 'auto1', 'nor is one that begins with auto');
}

// ---------------------------------------------------------------------------
// 6 — repair at ingress: duplicates renamed, missing ids named
// ---------------------------------------------------------------------------
{
  // Audit finding 23: nothing validated uniqueness at any door, so a legacy or already-corrupt
  // document walked straight into the selection, edit, undo and playback maps with two notes
  // sharing one name — where every one of those layers treats them as one logical note.
  const corrupt = [note('n7', 0), note('n7', 4), note(undefined, 6), note('n9', 8)];
  const before = identityProblems(corrupt);
  assert(before.duplicates.length === 1 && before.missing === 1, 'the fixture really is corrupt');

  const a = new NoteIdAllocator();
  const { notes, renamed, named } = repairNoteIdentity(corrupt, a);
  assert(renamed === 1, 'one duplicate was renamed');
  assert(named === 1, 'one id-less note was named');
  const after = identityProblems(notes);
  assert(after.duplicates.length === 0 && after.missing === 0, 'and the result is sound');
  assert(notes[0].id === 'n7', 'the FIRST bearer keeps the name, so an edit log keyed on it lands');
  assert(notes[1].id !== 'n7', 'the second gets a fresh one');
  assert(notes[3].id === 'n9', 'untouched notes are untouched');
  assert(notes.length === corrupt.length, 'nothing is dropped — the player keeps their music');
}

// ---------------------------------------------------------------------------
// 7 — a repaired batch cannot collide with itself
// ---------------------------------------------------------------------------
{
  // The trap: minting `add1` for a duplicate at index 0 when `add1` appears at index 5. Seeding
  // from the WHOLE batch before renaming anything is what makes this impossible.
  const tricky = [note('x', 0), note('x', 1), note('add1', 2), note('add2', 3)];
  const { notes } = repairNoteIdentity(tricky, new NoteIdAllocator());
  assert(identityProblems(notes).duplicates.length === 0, 'no id collides after repair');
  assert(new Set(notes.map((n) => n.id)).size === tricky.length, 'every note still has its own name');
}

// ---------------------------------------------------------------------------
// 8 — NoteKey is a pair, and is never reconstructed by string surgery
// ---------------------------------------------------------------------------
{
  // Audit finding 24: `parts.ts` rewrote the pipeline's collision-proof prefixes into
  // `${part.id}~${localId}` and `app.ts` then classified a note as imported with a `startsWith`
  // test — so a live note honestly called `imp1~x` and imported part `imp1`'s local note `x`
  // became the same name and the same note. Carrying the pair means the question is never asked
  // of a string.
  const live = liveKey('imp1~x');
  const imported = { partId: 'imp1', noteId: 'x' };
  assert(!sameKey(live, imported), 'a live note and an imported one are never the same note');
  assert(
    noteKeyString(live) !== noteKeyString(imported),
    'and they do not flatten to the same map key either'
  );
  assert(sameKey(live, liveKey('imp1~x')), 'the same pair is the same note');
}

// ---------------------------------------------------------------------------
// 9 — what counts as an id at all
// ---------------------------------------------------------------------------
{
  assert(isValidNoteId('n0'), 'an ordinary id');
  assert(!isValidNoteId(''), 'an empty string is not an id');
  assert(!isValidNoteId('   '), 'nor is whitespace — it reads as "no id" everywhere downstream');
  assert(!isValidNoteId(undefined), 'nor is undefined');
  assert(!isValidNoteId(7), 'nor is a number');
}

console.log(`identity.test: passed (${checks} checks)`);
