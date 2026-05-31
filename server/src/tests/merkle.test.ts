import { createHash } from 'crypto';
import {
  buildMerkleTree,
  generateProof,
  verifyProof
} from '../utils/merkle.js';

const sha256 = (d: string) => createHash('sha256').update(d).digest('hex');
const leafInput = (i: number) => sha256(`event:${i}:payload`);

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`❌ ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`✅ ${label}`);
}

// Inclusion proofs must verify for every leaf at every tree size, including
// non power-of-two sizes where the last node of an odd layer is paired with
// itself. This is the exact reconstruction the public /proof verifier and the
// temporal anchor verifier perform: leaf = sha256(eventHash), walk siblings.
const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 17, 31, 100, 255, 500];
for (const n of sizes) {
  const inputs = Array.from({ length: n }, (_, i) => leafInput(i));
  const tree = buildMerkleTree(inputs);

  let allLeavesVerify = true;
  for (let i = 0; i < n; i++) {
    const proof = generateProof(tree, i)!;
    const verified = verifyProof({
      leaf: sha256(inputs[i]!),
      leafIndex: i,
      siblings: proof.siblings,
      root: tree.root
    });
    if (!verified) allLeavesVerify = false;
  }
  ok(allLeavesVerify, `Test: n=${n} — all ${n} inclusion proofs verify`);

  // A different leaf value must not reconstruct the root with a stored path.
  const p0 = generateProof(tree, 0)!;
  const tampered = verifyProof({
    leaf: sha256(leafInput(999_999)),
    leafIndex: 0,
    siblings: p0.siblings,
    root: tree.root
  });
  ok(!tampered, `Test: n=${n} — tampered leaf rejected`);
}

// Root is deterministic for the same inputs in the same order.
const a = buildMerkleTree([leafInput(1), leafInput(2), leafInput(3)]).root;
const b = buildMerkleTree([leafInput(1), leafInput(2), leafInput(3)]).root;
ok(a === b, 'Test: root is deterministic');

// Reordering inputs changes the root.
const c = buildMerkleTree([leafInput(3), leafInput(2), leafInput(1)]).root;
ok(a !== c, 'Test: order-sensitive root');

console.log(`\nAll Merkle tests passed (${passed}/${passed})`);
