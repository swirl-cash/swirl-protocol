// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local development only. Never deploy this asset as a production USDC/USDT.
contract SwirlTestAsset is ERC20 {
    uint8 private immutable assetDecimals;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        assetDecimals = decimals_;
        _mint(msg.sender, 1_000_000_000 * 10 ** decimals_);
    }

    function decimals() public view override returns (uint8) {
        return assetDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Canonical WETH9-shaped wrapped native token for local integration tests.
contract SwirlTestWrappedNative is ERC20 {
    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped Native", "WNATIVE") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Native transfer failed");
        emit Withdrawal(msg.sender, amount);
    }
}
