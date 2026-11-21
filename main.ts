// Push-optimal Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// One program answers all 5 instances of a set. Every level is a hallway
// with 1-4 independent rooms off it (the generator builds it that way and
// the level's push-optimum P* is the sum of the rooms' optima), so each room
// is solved on its own, push-optimally, and the rooms' move strings are
// joined by walks along the hallway.
//
// A room is solved with A* over pushes: a state is the boxes' squares plus
// the player's reachable region (named by its lowest square), the estimate
// is the cheapest assignment of boxes to goals by grid distance, and two
// prunings keep it small: a box on a dead square (one from which no push,
// ignoring the other boxes, can ever reach a goal) and a frozen 2x2 block
// (four squares of walls and boxes holding a box off its goal). Both are
// proved safe by the same argument the kit's own reference solver uses.
// Search budgets are counted in expansions, never the clock, so two runs
// write the same bytes. A greedy best-first pass with the same pruning is
// the fallback when A* exhausts its budget.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Work budgets, in search expansions: never the wall clock.
const ASTAR_CAP = 250_000;
const GREEDY_CAP = 250_000;
const GLOBAL_CAP = 2_000_000;
let spent = 0;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** BFS distances from `start` over the cells where `floor` is set. */
function bfsDist(start: number, floor: Uint8Array, w: number): Int32Array {
  const dist = new Int32Array(floor.length).fill(-1);
  const q: number[] = [start];
  dist[start] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    for (let d = 0; d < 4; d++) {
      const n = c + DY[d]! * w + DX[d]!;
      if (n >= 0 && n < floor.length && floor[n] && dist[n] < 0) {
        dist[n] = dist[c]! + 1;
        q.push(n);
      }
    }
  }
  return dist;
}

/** The cells the player reaches from `from` over `floor`, avoiding `blocked`. */
function regionMask(from: number, floor: Uint8Array, blocked: Uint8Array, w: number): Uint8Array {
  const seen = new Uint8Array(floor.length);
  const q: number[] = [from];
  seen[from] = 1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    for (let d = 0; d < 4; d++) {
      const n = c + DY[d]! * w + DX[d]!;
      if (n >= 0 && n < floor.length && floor[n] && !blocked[n] && !seen[n]) {
        seen[n] = 1;
        q.push(n);
      }
    }
  }
  return seen;
}

/** A walk from `from` to `to` over `floor` avoiding `blocked`, as move letters, or null. */
function walkPath(from: number, to: number, floor: Uint8Array, blocked: Uint8Array, w: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(floor.length).fill(-2);
  const prevDir = new Int8Array(floor.length);
  const q: number[] = [from];
  prev[from] = -1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    for (let d = 0; d < 4; d++) {
      const n = c + DY[d]! * w + DX[d]!;
      if (n < 0 || n >= floor.length || !floor[n] || blocked[n] || prev[n] !== -2) continue;
      prev[n] = c;
      prevDir[n] = d;
      if (n === to) {
        let out = '';
        for (let t = n; t !== from; t = prev[t]!) out = LETTER[prevDir[t]!] + out;
        return out;
      }
      q.push(n);
    }
  }
  return null;
}

interface Room {
  cells: number[];
  floor: Uint8Array; // room cells + the hallway square outside the door
  boxFloor: Uint8Array; // room cells only: a box never sits on the hallway
  boxes: number[];
  goals: number[];
  entry: number; // the hallway square outside the door
}

interface RoomSolution {
  moves: string;
  pushes: number;
  endPlayer: number;
}

/** Solve one room push-optimally from its door's hallway square. */
function solveRoom(room: Room, w: number): RoomSolution | null {
  const { floor, boxFloor, boxes: startBoxes, goals, entry } = room;
  const n = goals.length;
  if (startBoxes.length !== n) return null;
  const goalSet = new Uint8Array(floor.length);
  for (const g of goals) goalSet[g] = 1;

  // Grid distance from every cell to each goal, boxes moving over room cells.
  const goalDist = goals.map((g) => bfsDist(g, boxFloor, w));

  // Dead squares: pulled back from the goals. A box on a square outside
  // this set can never reach a goal, whatever the other boxes do.
  const live = new Uint8Array(floor.length);
  const lq: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    lq.push(g);
  }
  for (let i = 0; i < lq.length; i++) {
    const c = lq[i]!;
    for (let d = 0; d < 4; d++) {
      const prev = c - DY[d]! * w - DX[d]!;
      const stance = prev - DY[d]! * w - DX[d]!;
      if (prev >= 0 && prev < floor.length && boxFloor[prev] && stance >= 0 && stance < floor.length && floor[stance] && !live[prev]) {
        live[prev] = 1;
        lq.push(prev);
      }
    }
  }

  // Cheapest assignment of boxes to goals; Infinity when no assignment works.
  const permutations: number[][] = [];
  {
    const idx = goals.map((_, i) => i);
    const gen = (k: number): void => {
      if (k === 1) {
        permutations.push(idx.slice());
        return;
      }
      for (let i = 0; i < k; i++) {
        gen(k - 1);
        const j = k % 2 === 0 ? i : 0;
        const t = idx[j]!;
        idx[j] = idx[k - 1]!;
        idx[k - 1] = t;
      }
    };
    gen(n);
  }
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of permutations) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = goalDist[p[i]!]![boxes[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b] === 1);
  const allLive = (boxes: number[]): boolean => boxes.every((b) => live[b] === 1);

  // A frozen 2x2 block must hold the box just pushed, so only the four
  // blocks touching `moved` need checking after a push.
  const frozenAt = (boxes: number[], moved: number): boolean => {
    const boxSet = new Uint8Array(floor.length);
    for (const b of boxes) boxSet[b] = 1;
    const tops = [moved, moved - 1, moved - w, moved - w - 1];
    for (const t of tops) {
      const cells = [t, t + 1, t + w, t + w + 1];
      let boxesIn = 0;
      let full = true;
      for (const c of cells) {
        if (c < 0 || c >= floor.length) {
          // Outside the board counts as wall.
        } else if (boxSet[c]) {
          boxesIn++;
        } else if (floor[c]) {
          full = false;
          break;
        }
      }
      if (full && boxesIn > 0) {
        for (const c of cells) {
          if (c >= 0 && c < floor.length && boxSet[c] && goalSet[c] !== 1) return true;
        }
      }
    }
    return false;
  };

  const keyOf = (boxes: number[], regionMin: number): number => {
    let k = regionMin;
    for (let i = 0; i < boxes.length; i++) k = k * 256 + boxes[i]!;
    return k;
  };

  // One search: A* (greedy=false) or greedy best-first (greedy=true).
  const search = (greedy: boolean, cap: number): number[] | null => {
    // State stores, indexed by state id.
    const sBoxes: number[][] = [startBoxes.slice()];
    const sPlayer: number[] = [entry];
    const sG: number[] = [0];
    const sParent: number[] = [-1];
    const sFrom: number[] = [-1];
    const sDir: number[] = [-1];
    const best = new Map<number, number>();
    const startRegion = regionMask(entry, floor, boxMask(startBoxes, floor.length), w);
    let startMin = Infinity;
    for (let i = 0; i < floor.length; i++) if (startRegion[i]) { startMin = i; break; }
    best.set(keyOf(startBoxes, startMin), 0);

    // Binary heap on [order, tie, seq, state], order = f (A*) or h (greedy).
    const heap: [number, number, number, number][] = [];
    let seq = 0;
    const h0 = heuristic(startBoxes);
    if (h0 === Infinity || !allLive(startBoxes)) return null;
    const pushHeap = (order: number, tie: number, s: number): void => {
      heap.push([order, tie, seq++, s]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[i]![0] > heap[p]![0] || (heap[i]![0] === heap[p]![0] && (heap[i]![1] > heap[p]![1] || (heap[i]![1] === heap[p]![1] && heap[i]![2] > heap[p]![2])))) break;
        const t = heap[i]!;
        heap[i] = heap[p]!;
        heap[p] = t;
        i = p;
      }
    };
    const popHeap = (): number => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && (heap[c + 1]![0] < heap[c]![0] || (heap[c + 1]![0] === heap[c]![0] && (heap[c + 1]![1] < heap[c]![1] || (heap[c + 1]![1] === heap[c]![1] && heap[c + 1]![2] < heap[c]![2]))))) c++;
          if (heap[c]![0] > heap[i]![0] || (heap[c]![0] === heap[i]![0] && (heap[c]![1] > heap[i]![1] || (heap[c]![1] === heap[i]![1] && heap[c]![2] > heap[i]![2])))) break;
          const t = heap[i]!;
          heap[i] = heap[c]!;
          heap[c] = t;
          i = c;
        }
      }
      return top[3];
    };
    pushHeap(greedy ? h0 : h0, h0, 0);

    let expanded = 0;
    while (heap.length > 0) {
      if (expanded >= cap || spent >= GLOBAL_CAP) return null;
      const s = popHeap();
      const boxes = sBoxes[s]!;
      if (solved(boxes)) {
        const pushes: number[] = [];
        const dirs: number[] = [];
        for (let t = s; t > 0; t = sParent[t]!) {
          pushes.push(sFrom[t]!);
          dirs.push(sDir[t]!);
        }
        pushes.reverse();
        dirs.reverse();
        // Pack as [from, dir] pairs in one array for the caller.
        const out: number[] = [];
        for (let i = 0; i < pushes.length; i++) {
          out.push(pushes[i]!, dirs[i]!);
        }
        return out;
      }
      // Skip a stale entry: a better route to this state was found since.
      const region = regionMask(sPlayer[s]!, floor, boxMask(boxes, floor.length), w);
      let regionMin = Infinity;
      for (let i = 0; i < floor.length; i++) if (region[i]) { regionMin = i; break; }
      const seen = best.get(keyOf(boxes, regionMin));
      if (seen !== undefined && seen !== s && sG[seen]! <= sG[s]!) continue;
      expanded++;
      spent++;
      const boxSet = boxMask(boxes, floor.length);
      for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi]!;
        for (let d = 0; d < 4; d++) {
          const dest = b + DY[d]! * w + DX[d]!;
          if (dest < 0 || dest >= floor.length || !boxFloor[dest] || boxSet[dest]) continue;
          const pusher = b - DY[d]! * w - DX[d]!;
          if (pusher < 0 || pusher >= floor.length || !region[pusher]) continue;
          const nb = boxes.slice();
          nb[bi] = dest;
          nb.sort((a, b2) => a - b2);
          if (!allLive(nb) || frozenAt(nb, dest)) continue;
          const h = heuristic(nb);
          if (h === Infinity) continue;
          const newRegion = regionMask(b, floor, boxMask(nb, floor.length), w);
          let newMin = Infinity;
          for (let i = 0; i < floor.length; i++) if (newRegion[i]) { newMin = i; break; }
          const k = keyOf(nb, newMin);
          const g2 = sG[s]! + 1;
          const prev = best.get(k);
          if (prev !== undefined && sG[prev]! <= g2) continue;
          const t = sBoxes.length;
          sBoxes.push(nb);
          sPlayer.push(b);
          sG.push(g2);
          sParent.push(s);
          sFrom.push(b);
          sDir.push(d);
          best.set(k, t);
          pushHeap(greedy ? h : g2 + h, h, t);
        }
      }
    }
    return null;
  };

  const found = search(false, ASTAR_CAP) ?? search(true, GREEDY_CAP);
  if (found === null) return null;

  // Rebuild the move string: walk to each push, then push.
  let moves = '';
  let cur = entry;
  let curBoxes = startBoxes.slice();
  for (let i = 0; i < found.length; i += 2) {
    const from = found[i]!;
    const d = found[i + 1]!;
    const pusher = from - DY[d]! * w - DX[d]!;
    const path = walkPath(cur, pusher, floor, boxMask(curBoxes, floor.length), w);
    if (path === null) return null;
    moves += path + LETTER[d];
    const at = curBoxes.indexOf(from);
    curBoxes[at] = from + DY[d]! * w + DX[d]!;
    curBoxes.sort((a, b) => a - b);
    cur = from;
  }
  return { moves, pushes: found.length / 2, endPlayer: cur };
}

function boxMask(boxes: number[], len: number): Uint8Array {
  const m = new Uint8Array(len);
  for (const b of boxes) m[b] = 1;
  return m;
}

/** Replay `moves` on `text`; true only when every step is legal and solved. */
function verifyLevel(text: string, moves: string): boolean {
  const { w, wall, goals, boxes, player } = parseLevel(text);
  const goalSet = new Uint8Array(wall.length);
  for (const g of goals) goalSet[g] = 1;
  const box = boxMask(boxes, wall.length);
  let p = player;
  for (const ch of moves) {
    const d = LETTER.indexOf(ch);
    if (d < 0) return false;
    const q = p + DY[d]! * w + DX[d]!;
    if (q < 0 || q >= wall.length || wall[q]) return false;
    if (box[q]) {
      const beyond = q + DY[d]! * w + DX[d]!;
      if (beyond < 0 || beyond >= wall.length || wall[beyond] || box[beyond]) return false;
      box[q] = 0;
      box[beyond] = 1;
    }
    p = q;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goalSet[i]) return false;
  return true;
}

/** Solve one level: split it into rooms, solve each, join with hallway walks. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h, wall, goals, boxes, player } = level;
  const hallRow = Math.floor(player / w);
  const allFloor = new Uint8Array(wall.length);
  for (let i = 0; i < wall.length; i++) allFloor[i] = wall[i] ? 0 : 1;

  // Rooms: connected components of floor off the hallway row.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  let assignedBoxes = 0;
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || Math.floor(i / w) === hallRow || seen[i]) continue;
    const cells: number[] = [i];
    seen[i] = 1;
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j]!;
      for (let d = 0; d < 4; d++) {
        const n = c + DY[d]! * w + DX[d]!;
        if (n >= 0 && n < w * h && !wall[n] && Math.floor(n / w) !== hallRow && !seen[n]) {
          seen[n] = 1;
          cells.push(n);
        }
      }
    }
    const cellSet = new Uint8Array(w * h);
    for (const c of cells) cellSet[c] = 1;
    const rBoxes = boxes.filter((b) => cellSet[b]);
    const rGoals = goals.filter((g) => cellSet[g]);
    assignedBoxes += rBoxes.length;
    // The door: the room cell touching the hallway row.
    let door = -1;
    let entry = -1;
    for (const c of cells) {
      const y = Math.floor(c / w);
      if (y === hallRow - 1 || y === hallRow + 1) {
        const e = Math.floor(c / w) === hallRow - 1 ? c + w : c - w;
        if (!wall[e]) {
          door = c;
          entry = e;
          break;
        }
      }
    }
    if (door < 0 || rBoxes.length !== rGoals.length) return solveWhole(text, level);
    const floor = new Uint8Array(w * h);
    for (const c of cells) floor[c] = 1;
    floor[entry] = 1;
    const boxFloor = new Uint8Array(w * h);
    for (const c of cells) boxFloor[c] = 1;
    rooms.push({ cells, floor, boxFloor, boxes: rBoxes, goals: rGoals, entry });
  }
  if (rooms.length === 0 || assignedBoxes !== boxes.length) return solveWhole(text, level);
  rooms.sort((a, b) => a.entry - b.entry);
  return solveLevelJoined(text, level, rooms);
}

/** Join room solutions, recomputing the box layout after each room. */
function solveLevelJoined(text: string, level: Level, rooms: Room[]): string {
  const { w, h, wall, boxes, player } = level;
  const allFloor = new Uint8Array(w * h);
  for (let i = 0; i < wall.length; i++) allFloor[i] = wall[i] ? 0 : 1;
  let moves = '';
  let curPlayer = player;
  // Boxes still unsolved; a solved room's boxes sit on its goals.
  const curBoxes = boxes.slice();
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const walk = walkPath(curPlayer, room.entry, allFloor, boxMask(curBoxes, w * h), w);
    if (walk === null) return '';
    moves += walk;
    const res = solveRoom(room, w);
    if (res === null) return '';
    moves += res.moves;
    curPlayer = res.endPlayer;
    // Move this room's boxes onto its goals in curBoxes.
    const roomBoxSet = new Set(room.boxes);
    for (let i = 0; i < curBoxes.length; i++) {
      if (roomBoxSet.has(curBoxes[i]!)) {
        // Take the next free goal of this room.
        for (const g of room.goals) {
          if (!curBoxes.includes(g)) {
            curBoxes[i] = g;
            break;
          }
        }
      }
    }
  }
  if (!verifyLevel(text, moves)) return '';
  return moves;
}

/** Fallback: the whole level as one room (used only when the split fails). */
function solveWhole(text: string, level: Level): string {
  const { w, h, wall, goals, boxes, player } = level;
  const floor = new Uint8Array(w * h);
  const boxFloor = new Uint8Array(w * h);
  for (let i = 0; i < wall.length; i++) {
    floor[i] = wall[i] ? 0 : 1;
    boxFloor[i] = wall[i] ? 0 : 1;
  }
  const room: Room = { cells: [], floor, boxFloor, boxes, goals, entry: player };
  const res = solveRoom(room, w);
  if (res === null) return '';
  if (!verifyLevel(text, res.moves)) return '';
  return res.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
