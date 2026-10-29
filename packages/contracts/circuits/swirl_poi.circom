pragma circom 2.2.3;

include "poseidon.circom";
include "bitify.circom";
include "comparators.circom";

template POINoteHash() {
    signal input owner;
    signal input token;
    signal input amount;
    signal input randomness;
    signal output commitment;
    component hash = Poseidon(4);
    hash.inputs[0] <== owner;
    hash.inputs[1] <== token;
    hash.inputs[2] <== amount;
    hash.inputs[3] <== randomness;
    commitment <== hash.out;
}

template POIMembership(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices;
    signal output root;
    component indexBits = Num2Bits(levels);
    indexBits.in <== pathIndices;
    signal nodes[levels + 1];
    component hashes[levels];
    nodes[0] <== leaf;
    for (var i = 0; i < levels; i++) {
        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== nodes[i] + indexBits.out[i] * (pathElements[i] - nodes[i]);
        hashes[i].inputs[1] <== pathElements[i] + indexBits.out[i] * (nodes[i] - pathElements[i]);
        nodes[i + 1] <== hashes[i].out;
    }
    root <== nodes[levels];
}

// Carries list-provider approval across a confirmed 2x4 SWIRL transaction.
// The TXID tree is built exclusively from confirmed vault events, so the
// transaction's value conservation and base Groth16 proof are checked on-chain
// before its TXID can become a member of that tree.
template SwirlPOI(levels) {
    signal input anyTxidMerkleRootAfterTransaction;
    signal input txidIfHasUnshield;
    signal input poiMerkleRoots[2];
    signal output blindedCommitmentsOut[4];

    signal input nullifiers[2];
    signal input outputCommitments[4];
    signal input ciphertextHash;
    signal input publicAmount;
    signal input publicRecipient;
    signal input token;
    signal input chainId;
    signal input firstLeafIndex;

    signal input inputEnabled[2];
    signal input inputOwner[2];
    signal input inputOwnerSecret[2];
    signal input inputAmount[2];
    signal input inputRandomness[2];
    signal input inputLeafIndex[2];
    signal input poiPathIndices[2];
    signal input poiPathElements[2][levels];

    signal input outputOwner[4];
    signal input outputAmount[4];
    signal input outputRandomness[4];

    signal input txidPathIndices;
    signal input txidPathElements[levels];

    component nullifiersHash = Poseidon(2);
    nullifiersHash.inputs[0] <== nullifiers[0];
    nullifiersHash.inputs[1] <== nullifiers[1];
    component commitmentsHash = Poseidon(4);
    for (var i = 0; i < 4; i++) commitmentsHash.inputs[i] <== outputCommitments[i];
    component boundHash = Poseidon(5);
    boundHash.inputs[0] <== ciphertextHash;
    boundHash.inputs[1] <== publicAmount;
    boundHash.inputs[2] <== publicRecipient;
    boundHash.inputs[3] <== token;
    boundHash.inputs[4] <== chainId;
    component txidHash = Poseidon(3);
    txidHash.inputs[0] <== nullifiersHash.out;
    txidHash.inputs[1] <== commitmentsHash.out;
    txidHash.inputs[2] <== boundHash.out;
    component txidLeafHash = Poseidon(3);
    txidLeafHash.inputs[0] <== txidHash.out;
    txidLeafHash.inputs[1] <== 0;
    txidLeafHash.inputs[2] <== firstLeafIndex;

    component txidMembership = POIMembership(levels);
    txidMembership.leaf <== txidLeafHash.out;
    txidMembership.pathIndices <== txidPathIndices;
    for (var level = 0; level < levels; level++) {
        txidMembership.pathElements[level] <== txidPathElements[level];
    }
    txidMembership.root === anyTxidMerkleRootAfterTransaction;

    component hasNoUnshield = IsZero();
    hasNoUnshield.in <== publicAmount;
    txidIfHasUnshield === txidHash.out * (1 - hasNoUnshield.out);

    component ownerHash[2];
    component inputNote[2];
    component inputBlinded[2];
    component inputMembership[2];
    component inputRootCheck[2];
    component nullifierHash[2];
    for (var i = 0; i < 2; i++) {
        inputEnabled[i] * (inputEnabled[i] - 1) === 0;
        ownerHash[i] = Poseidon(1);
        ownerHash[i].inputs[0] <== inputOwnerSecret[i];
        inputOwner[i] === inputEnabled[i] * ownerHash[i].out;

        inputNote[i] = POINoteHash();
        inputNote[i].owner <== inputOwner[i];
        inputNote[i].token <== inputEnabled[i] * token;
        inputNote[i].amount <== inputAmount[i];
        inputNote[i].randomness <== inputRandomness[i];
        inputBlinded[i] = Poseidon(3);
        inputBlinded[i].inputs[0] <== inputNote[i].commitment;
        inputBlinded[i].inputs[1] <== inputOwner[i];
        inputBlinded[i].inputs[2] <== inputLeafIndex[i];
        inputMembership[i] = POIMembership(levels);
        inputMembership[i].leaf <== inputBlinded[i].out;
        inputMembership[i].pathIndices <== poiPathIndices[i];
        for (var level = 0; level < levels; level++) {
            inputMembership[i].pathElements[level] <== poiPathElements[i][level];
        }
        inputRootCheck[i] = ForceEqualIfEnabled();
        inputRootCheck[i].enabled <== inputEnabled[i];
        inputRootCheck[i].in[0] <== inputMembership[i].root;
        inputRootCheck[i].in[1] <== poiMerkleRoots[i];

        nullifierHash[i] = Poseidon(2);
        nullifierHash[i].inputs[0] <== inputOwnerSecret[i];
        nullifierHash[i].inputs[1] <== inputLeafIndex[i];
        nullifiers[i] === inputEnabled[i] * nullifierHash[i].out;
    }

    component outputNote[4];
    component outputBlinded[4];
    component outputIsZero[4];
    for (var i = 0; i < 4; i++) {
        outputNote[i] = POINoteHash();
        outputNote[i].owner <== outputOwner[i];
        outputNote[i].token <== token;
        outputNote[i].amount <== outputAmount[i];
        outputNote[i].randomness <== outputRandomness[i];
        outputCommitments[i] === outputNote[i].commitment;

        outputBlinded[i] = Poseidon(3);
        outputBlinded[i].inputs[0] <== outputCommitments[i];
        outputBlinded[i].inputs[1] <== outputOwner[i];
        outputBlinded[i].inputs[2] <== firstLeafIndex + i;
        outputIsZero[i] = IsZero();
        outputIsZero[i].in <== outputAmount[i];
        blindedCommitmentsOut[i] <== outputBlinded[i].out * (1 - outputIsZero[i].out);
    }
}

component main {public [anyTxidMerkleRootAfterTransaction, txidIfHasUnshield, poiMerkleRoots]} = SwirlPOI(16);
