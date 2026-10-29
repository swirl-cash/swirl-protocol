pragma circom 2.2.3;

include "poseidon.circom";
include "bitify.circom";
include "comparators.circom";

template NoteHash() {
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

template Membership(levels) {
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

// Up to two real inputs and four outputs. A disabled input is bound to the
// canonical zero note at leaf zero, allowing one-input transactions without
// disabling membership or ownership constraints for real inputs.
template SwirlTransfer(levels) {
    signal input root;
    signal input nullifiers[2];
    signal input outputCommitments[4];
    // keccak256(abi.encode(ciphertexts)) reduced into the BN254 field.
    // The contract recomputes it, making every ciphertext byte proof-bound.
    signal input ciphertextHash;
    signal input publicAmount;
    signal input publicRecipient;
    signal input token;
    signal input chainId;

    signal input inputEnabled[2];
    signal input inputOwner[2];
    signal input inputOwnerSecret[2];
    signal input inputAmount[2];
    signal input inputRandomness[2];
    signal input inputLeafIndex[2];
    signal input pathElements[2][levels];

    signal input outputOwner[4];
    signal input outputAmount[4];
    signal input outputRandomness[4];

    component inputRange[2];
    component ownerHash[2];
    component inputNote[2];
    component membership[2];
    component nullifierHash[2];
    for (var i = 0; i < 2; i++) {
        inputEnabled[i] * (inputEnabled[i] - 1) === 0;
        inputAmount[i] * (1 - inputEnabled[i]) === 0;
        inputRandomness[i] * (1 - inputEnabled[i]) === 0;
        inputLeafIndex[i] * (1 - inputEnabled[i]) === 0;

        inputRange[i] = Num2Bits(128);
        inputRange[i].in <== inputAmount[i];
        ownerHash[i] = Poseidon(1);
        ownerHash[i].inputs[0] <== inputOwnerSecret[i];
        inputOwner[i] === inputEnabled[i] * ownerHash[i].out;

        inputNote[i] = NoteHash();
        inputNote[i].owner <== inputOwner[i];
        inputNote[i].token <== inputEnabled[i] * token;
        inputNote[i].amount <== inputAmount[i];
        inputNote[i].randomness <== inputRandomness[i];
        membership[i] = Membership(levels);
        membership[i].leaf <== inputNote[i].commitment;
        membership[i].pathIndices <== inputLeafIndex[i];
        for (var level = 0; level < levels; level++) {
            membership[i].pathElements[level] <== pathElements[i][level];
        }
        membership[i].root === root;

        nullifierHash[i] = Poseidon(2);
        nullifierHash[i].inputs[0] <== inputOwnerSecret[i];
        nullifierHash[i].inputs[1] <== inputLeafIndex[i];
        nullifiers[i] === inputEnabled[i] * nullifierHash[i].out;
    }

    component anyInput = IsZero();
    anyInput.in <== inputEnabled[0] + inputEnabled[1];
    anyInput.out === 0;

    component distinctNullifiers = IsZero();
    distinctNullifiers.in <== nullifiers[0] - nullifiers[1];
    distinctNullifiers.out === 0;

    component outputRange[4];
    component outputNote[4];
    for (var i = 0; i < 4; i++) {
        outputRange[i] = Num2Bits(128);
        outputRange[i].in <== outputAmount[i];
        outputNote[i] = NoteHash();
        outputNote[i].owner <== outputOwner[i];
        outputNote[i].token <== token;
        outputNote[i].amount <== outputAmount[i];
        outputNote[i].randomness <== outputRandomness[i];
        outputCommitments[i] === outputNote[i].commitment;
    }

    component publicRange = Num2Bits(128);
    publicRange.in <== publicAmount;
    inputAmount[0] + inputAmount[1] === outputAmount[0] + outputAmount[1] + outputAmount[2] + outputAmount[3] + publicAmount;

    component noWithdrawal = IsZero();
    noWithdrawal.in <== publicAmount;
    publicRecipient * noWithdrawal.out === 0;
    component noRecipient = IsZero();
    noRecipient.in <== publicRecipient;
    (1 - noWithdrawal.out) * noRecipient.out === 0;
}

component main {public [root, nullifiers, outputCommitments, ciphertextHash, publicAmount, publicRecipient, token, chainId]} = SwirlTransfer(16);
