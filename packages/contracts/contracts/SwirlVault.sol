// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT5} from "poseidon-solidity/PoseidonT5.sol";
import {Groth16Verifier} from "./SwirlVerifier.sol";

/// @title SWIRL Groth16 private ERC-20 vault
/// @notice Up to two inputs and four outputs, with an optional public unshield.
/// @dev Development trusted setup only. A public multi-party ceremony and audit are required before mainnet.
contract SwirlVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TREE_DEPTH = 16;
    uint256 public constant MAX_LEAVES = 2 ** TREE_DEPTH;
    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    mapping(address => bool) public supportedTokens;
    address public immutable treasury;
    uint16 public immutable feeBps;
    Groth16Verifier public immutable verifier;
    bytes32 public immutable zeroNoteCommitment;

    bytes32[TREE_DEPTH] public zeroes;
    bytes32[TREE_DEPTH] private filledSubtrees;
    bytes32 public merkleRoot;
    uint32 public nextLeafIndex;
    mapping(bytes32 => bool) public knownRoots;
    mapping(bytes32 => bool) public nullifiers;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    event Shielded(uint32 indexed leafIndex, bytes32 indexed commitment, bytes ciphertext, uint256 amount, uint256 fee, bytes32 owner, address indexed token);
    event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex);
    event Unshielded(address indexed recipient, uint256 amount, uint256 fee, address indexed token);
    event RootUpdated(bytes32 indexed root, uint32 indexed leafIndex);

    error InvalidFee();
    error InvalidCommitment();
    error InvalidRoot();
    error InvalidProof();
    error DuplicateNullifier();
    error TreeFull();
    error InvalidWithdrawal();
    error UnsupportedToken();

    constructor(address[] memory _tokens, address _treasury, uint16 _feeBps, Groth16Verifier _verifier) {
        if (_tokens.length == 0 || _treasury == address(0) || address(_verifier) == address(0)) revert InvalidCommitment();
        if (_feeBps > 1_000) revert InvalidFee();
        for (uint256 i = 0; i < _tokens.length; i++) {
            if (_tokens[i] == address(0) || supportedTokens[_tokens[i]]) revert UnsupportedToken();
            supportedTokens[_tokens[i]] = true;
        }
        treasury = _treasury;
        feeBps = _feeBps;
        verifier = _verifier;
        zeroNoteCommitment = bytes32(PoseidonT5.hash([uint256(0), uint256(0), uint256(0), uint256(0)]));

        bytes32 current;
        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            zeroes[i] = current;
            filledSubtrees[i] = current;
            current = _hashPair(current, current);
        }
        merkleRoot = current;
        knownRoots[current] = true;
        _insertLeaf(zeroNoteCommitment);
    }

    function shield(
        IERC20 token,
        uint256 grossAmount,
        bytes32 commitment,
        bytes calldata ciphertext,
        bytes32 owner,
        bytes32 randomness
    ) external nonReentrant {
        if (!supportedTokens[address(token)]) revert UnsupportedToken();
        if (grossAmount == 0 || uint256(commitment) >= FIELD_SIZE
            || uint256(owner) >= FIELD_SIZE || uint256(randomness) >= FIELD_SIZE) revert InvalidCommitment();
        uint256 fee = (grossAmount * feeBps) / FEE_DENOMINATOR;
        uint256 netAmount = grossAmount - fee;
        if (netAmount == 0) revert InvalidFee();
        bytes32 expected = bytes32(PoseidonT5.hash([
            uint256(owner), uint256(uint160(address(token))), netAmount, uint256(randomness)
        ]));
        if (commitment != expected) revert InvalidCommitment();

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), grossAmount);
        if (token.balanceOf(address(this)) - before != grossAmount) revert InvalidFee();
        if (fee > 0) token.safeTransfer(treasury, fee);
        uint32 index = _insertLeaf(commitment);
        emit Shielded(index, commitment, ciphertext, netAmount, fee, owner, address(token));
    }

    /// @notice Permissionless submission: a user wallet or any relayer may pay gas.
    /// @dev The proof binds every output, nullifier, withdrawal and chain parameter.
    function transact(
        Proof calldata proof,
        bytes32 root,
        bytes32[2] calldata nullifierValues,
        bytes32[4] calldata outputCommitments,
        bytes[4] calldata ciphertexts,
        uint256 publicAmount,
        address publicRecipient,
        IERC20 token
    ) external nonReentrant {
        if (!supportedTokens[address(token)]) revert UnsupportedToken();
        if (!knownRoots[root]) revert InvalidRoot();
        if ((publicAmount == 0) != (publicRecipient == address(0))) revert InvalidWithdrawal();
        for (uint256 i = 0; i < 2; i++) {
            if (nullifierValues[i] != 0 && nullifiers[nullifierValues[i]]) revert DuplicateNullifier();
        }
        if (nullifierValues[0] != 0 && nullifierValues[0] == nullifierValues[1]) revert DuplicateNullifier();
        for (uint256 i = 0; i < 4; i++) {
            if (uint256(outputCommitments[i]) >= FIELD_SIZE) revert InvalidCommitment();
        }

        uint256 ciphertextHash = uint256(keccak256(abi.encode(ciphertexts))) % FIELD_SIZE;
        uint256[12] memory inputs = [
            uint256(root),
            uint256(nullifierValues[0]),
            uint256(nullifierValues[1]),
            uint256(outputCommitments[0]),
            uint256(outputCommitments[1]),
            uint256(outputCommitments[2]),
            uint256(outputCommitments[3]),
            ciphertextHash,
            publicAmount,
            uint256(uint160(publicRecipient)),
            uint256(uint160(address(token))),
            block.chainid
        ];
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, inputs)) revert InvalidProof();

        for (uint256 i = 0; i < 2; i++) {
            if (nullifierValues[i] != 0) nullifiers[nullifierValues[i]] = true;
        }
        if (publicAmount > 0) {
            uint256 fee = (publicAmount * feeBps) / FEE_DENOMINATOR;
            uint256 netAmount = publicAmount - fee;
            if (netAmount == 0) revert InvalidFee();
            token.safeTransfer(publicRecipient, netAmount);
            if (fee > 0) token.safeTransfer(treasury, fee);
            emit Unshielded(publicRecipient, netAmount, fee, address(token));
        }

        uint32 firstIndex = nextLeafIndex;
        for (uint256 i = 0; i < 4; i++) _insertLeaf(outputCommitments[i]);
        emit Transacted(nullifierValues, outputCommitments, ciphertexts, firstIndex);
    }

    function hashNote(bytes32 owner, IERC20 token, uint256 amount, bytes32 randomness) external pure returns (bytes32) {
        return bytes32(PoseidonT5.hash([uint256(owner), uint256(uint160(address(token))), amount, uint256(randomness)]));
    }

    function _insertLeaf(bytes32 leaf) internal returns (uint32 index) {
        if (nextLeafIndex >= MAX_LEAVES) revert TreeFull();
        index = nextLeafIndex++;
        uint256 currentIndex = index;
        bytes32 current = leaf;
        for (uint256 level = 0; level < TREE_DEPTH; level++) {
            if (currentIndex % 2 == 0) {
                filledSubtrees[level] = current;
                current = _hashPair(current, zeroes[level]);
            } else {
                current = _hashPair(filledSubtrees[level], current);
            }
            currentIndex /= 2;
        }
        merkleRoot = current;
        knownRoots[current] = true;
        emit RootUpdated(current, index);
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return bytes32(PoseidonT3.hash([uint256(left), uint256(right)]));
    }
}
