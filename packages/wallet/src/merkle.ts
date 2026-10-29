import { buildPoseidon } from 'circomlibjs';
import { assertField, TREE_DEPTH } from './constants.js';

export type MerklePath = {
  root: bigint;
  pathElements: bigint[];
  leafIndex: number;
};

export async function verifyMerklePath(leaf: bigint, path: MerklePath): Promise<boolean> {
  if (path.pathElements.length !== TREE_DEPTH || !Number.isInteger(path.leafIndex) || path.leafIndex < 0) return false;
  const poseidon = await buildPoseidon();
  let current = leaf;
  let index = path.leafIndex;
  for (const element of path.pathElements) {
    current = poseidon.F.toObject(
      index % 2 === 0 ? poseidon([current, element]) : poseidon([element, current]),
    ) as bigint;
    index = Math.floor(index / 2);
  }
  return current === path.root;
}

export class SwirlMerkleTree {
  readonly depth: number;
  private leaves: bigint[];
  private zeroes: bigint[] = [];
  private poseidon: Awaited<ReturnType<typeof buildPoseidon>>;

  private constructor(depth: number, leaves: bigint[], poseidon: Awaited<ReturnType<typeof buildPoseidon>>) {
    this.depth = depth;
    this.leaves = leaves;
    this.poseidon = poseidon;
  }

  static async create(depth = TREE_DEPTH, leaves: bigint[] = []): Promise<SwirlMerkleTree> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 16) throw new Error('Invalid tree depth');
    if (leaves.length > 2 ** depth) throw new Error('Tree capacity exceeded');
    leaves.forEach((leaf) => assertField(leaf, 'Merkle leaf'));
    const tree = new SwirlMerkleTree(depth, [...leaves], await buildPoseidon());
    tree.zeroes = [0n];
    for (let level = 1; level < depth; level++) {
      tree.zeroes.push(tree.pair(tree.zeroes[level - 1], tree.zeroes[level - 1]));
    }
    return tree;
  }

  private pair(left: bigint, right: bigint): bigint {
    return this.poseidon.F.toObject(this.poseidon([left, right])) as bigint;
  }

  insert(leaf: bigint): number {
    if (this.leaves.length >= 2 ** this.depth) throw new Error('Tree is full');
    assertField(leaf, 'Merkle leaf');
    const index = this.leaves.length;
    this.leaves.push(leaf);
    return index;
  }

  get root(): bigint {
    let level = [...this.leaves];
    if (level.length === 0) level = [this.zeroes[0]];
    for (let depth = 0; depth < this.depth; depth++) {
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(this.pair(level[i], level[i + 1] ?? this.zeroes[depth]));
      }
      level = next;
    }
    return level[0];
  }

  path(leafIndex: number): MerklePath {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.leaves.length) throw new Error('Unknown leaf');
    const pathElements: bigint[] = [];
    let level = [...this.leaves];
    let index = leafIndex;
    for (let depth = 0; depth < this.depth; depth++) {
      pathElements.push(level[index ^ 1] ?? this.zeroes[depth]);
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(this.pair(level[i], level[i + 1] ?? this.zeroes[depth]));
      }
      level = next;
      index = Math.floor(index / 2);
    }
    return { root: this.root, pathElements, leafIndex };
  }
}
