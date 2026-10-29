import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const deployer = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = deployer && /^0x[0-9a-fA-F]{64}$/.test(deployer) ? [deployer] : [];
const rpc = (name: string) => {
  const url = process.env[`${name}_RPC_URL`];
  return url && accounts.length ? { url, accounts } : undefined;
};

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: Object.fromEntries(Object.entries({
    ethereum: rpc("ETHEREUM"),
    sepolia: rpc("SEPOLIA"),
    bnb: rpc("BNB"),
    polygon: rpc("POLYGON"),
    arbitrum: rpc("ARBITRUM"),
    polygonAmoy: rpc("POLYGON_AMOY"),
  }).filter((entry) => entry[1] !== undefined)),
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
