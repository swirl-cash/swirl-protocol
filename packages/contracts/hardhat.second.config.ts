import type { HardhatUserConfig } from "hardhat/config";
import base from "./hardhat.config";

const config: HardhatUserConfig = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: { chainId: 31338 },
  },
};

export default config;
