import { buildPoseidon } from 'circomlibjs';
import type { MerklePath } from '@swirl/wallet';

export const TREE_DEPTH = 16;
export const TREE_CAPACITY = 2 ** TREE_DEPTH;
export const POI_ZERO_LEAF = BigInt('0x0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc');

export class PoseidonMerkleTree {
  private readonly nodes: bigint[][] = [];
  private readonly zeroes: bigint[] = [];
  private readonly historicalRoots = new Set<string>();

  private constructor(
    readonly depth: number,
    private readonly poseidon: Awaited<ReturnType<typeof buildPoseidon>>,
    readonly zeroLeaf: bigint,
  ) {
    this.zeroes[0] = zeroLeaf;
    for (let level = 1; level <= depth; level++) this.zeroes[level] = this.pair(this.zeroes[level - 1], this.zeroes[level - 1]);
    this.nodes[0] = [];
    this.historicalRoots.add(this.root.toString());
  }

  static async create(depth = TREE_DEPTH, leaves: bigint[] = [], zeroLeaf = POI_ZERO_LEAF): Promise<PoseidonMerkleTree> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 16 || leaves.length > 2 ** depth) throw new Error('Invalid Merkle tree configuration');
    const tree = new PoseidonMerkleTree(depth, await buildPoseidon(), zeroLeaf);
    for (const leaf of leaves) tree.append(leaf);
    return tree;
  }

  private pair(left: bigint, right: bigint): bigint {
    return this.poseidon.F.toObject(this.poseidon([left, right])) as bigint;
  }

  get length(): number {
    return this.nodes[0].length;
  }

  get leaves(): bigint[] {
    return [...this.nodes[0]];
  }

  get root(): bigint {
    return this.nodes[this.depth]?.[0] ?? this.zeroes[this.depth];
  }

  hasRoot(root: bigint): boolean {
    return this.historicalRoots.has(root.toString());
  }

  leaf(index: number): bigint {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new Error('Unknown Merkle leaf');
    return this.nodes[0][index];
  }

  append(leaf: bigint): number {
    if (this.length >= 2 ** this.depth) throw new Error('Merkle tree is full');
    const index = this.length;
    this.nodes[0][index] = leaf;
    let current = leaf;
    let currentIndex = index;
    for (let level = 0; level < this.depth; level++) {
      const siblingIndex = currentIndex ^ 1;
      const sibling = this.nodes[level]?.[siblingIndex] ?? this.zeroes[level];
      current = currentIndex % 2 === 0 ? this.pair(current, sibling) : this.pair(sibling, current);
      currentIndex = Math.floor(currentIndex / 2);
      this.nodes[level + 1] ??= [];
      this.nodes[level + 1][currentIndex] = current;
    }
    this.historicalRoots.add(this.root.toString());
    return index;
  }

  path(leafIndex: number): MerklePath {
    const leaf = this.leaf(leafIndex);
    if (leaf === undefined) throw new Error('Unknown Merkle leaf');
    const pathElements: bigint[] = [];
    let index = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      pathElements.push(this.nodes[level]?.[index ^ 1] ?? this.zeroes[level]);
      index = Math.floor(index / 2);
    }
    return { root: this.root, pathElements, leafIndex };
  }
}
