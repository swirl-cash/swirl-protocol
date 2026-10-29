// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SwirlVault} from "./SwirlVault.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title Native-asset adapter for one wrapped-native SWIRL vault.
/// @notice The final native recipient is bound by ciphertextHash in the Groth16 proof.
contract SwirlNativeGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    SwirlVault public immutable vault;
    IWETH9 public immutable wrappedNative;

    error InvalidVault();
    error InvalidNativeRecipient();
    error InvalidNativeCiphertext();
    error UnexpectedNativeSender();

    constructor(SwirlVault _vault, IWETH9 _wrappedNative) {
        if (address(_vault) == address(0) || address(_wrappedNative) == address(0) || !_vault.supportedTokens(address(_wrappedNative))) {
            revert InvalidVault();
        }
        vault = _vault;
        wrappedNative = _wrappedNative;
        IERC20(_wrappedNative).forceApprove(address(_vault), type(uint256).max);
    }

    receive() external payable {
        if (msg.sender != address(wrappedNative)) revert UnexpectedNativeSender();
    }

    function shieldNative(bytes32 commitment, bytes calldata ciphertext, bytes32 owner, bytes32 randomness) external payable nonReentrant {
        if (msg.value == 0) revert SwirlVault.InvalidCommitment();
        wrappedNative.deposit{value: msg.value}();
        vault.shield(wrappedNative, msg.value, commitment, ciphertext, owner, randomness);
    }

    function unshieldNative(
        SwirlVault.Proof calldata proof,
        bytes32 root,
        bytes32[2] calldata nullifierValues,
        bytes32[4] calldata outputCommitments,
        bytes[4] calldata ciphertexts,
        uint256 publicAmount
    ) external nonReentrant {
        if (publicAmount == 0 || ciphertexts[0].length != 32) revert InvalidNativeCiphertext();
        for (uint256 i = 1; i < 4; i++) {
            if (ciphertexts[i].length != 0) revert InvalidNativeCiphertext();
        }
        address recipient = abi.decode(ciphertexts[0], (address));
        if (recipient == address(0)) revert InvalidNativeRecipient();

        uint256 before = wrappedNative.balanceOf(address(this));
        vault.transact(proof, root, nullifierValues, outputCommitments, ciphertexts, publicAmount, address(this), wrappedNative);
        uint256 received = wrappedNative.balanceOf(address(this)) - before;
        wrappedNative.withdraw(received);
        Address.sendValue(payable(recipient), received);
    }
}
