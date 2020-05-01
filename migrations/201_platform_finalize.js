require("babel-register");
const fs = require("fs");
const { join } = require("path");
const getConfig = require("./config").getConfig;
const getDeployerAccount = require("./config").getDeployerAccount;
const getNetworkDefinition = require("./config").getNetworkDefinition;
const roles = require("../test/helpers/roles").default;
const knownInterfaces = require("../test/helpers/knownInterfaces").knownInterfaces;
const interfaceArtifacts = require("../test/helpers/interfaceArtifacts").interfaceToArtifacts;
const { TriState } = require("../test/helpers/triState");
const createAccessPolicy = require("../test/helpers/createAccessPolicy").default;
const promisify = require("../test/helpers/utils").promisify;

module.exports = function deployContracts(deployer, network, accounts) {
  const CONFIG = getConfig(web3, network, accounts);
  if (CONFIG.shouldSkipStep(__filename)) return;

  const Universe = artifacts.require(CONFIG.artifacts.UNIVERSE);
  const Commitment = artifacts.require(CONFIG.artifacts.ICBM_COMMITMENT);
  const RoleBasedAccessPolicy = artifacts.require(CONFIG.artifacts.ROLE_BASED_ACCESS_POLICY);
  const DEPLOYER = getDeployerAccount(network, accounts);

  deployer.then(async () => {
    let universe;
    if (CONFIG.UNIVERSE_ADDRESS) {
      universe = await Universe.at(CONFIG.UNIVERSE_ADDRESS);
    } else {
      universe = await Universe.deployed();
    }
    let commitmentAddress;
    if (CONFIG.ICBM_COMMITMENT_ADDRESS) {
      commitmentAddress = CONFIG.ICBM_COMMITMENT_ADDRESS;
    } else {
      commitmentAddress = (await Commitment.deployed()).address;
    }
    if (CONFIG.isLiveDeployment) {
      const accessPolicy = await RoleBasedAccessPolicy.at(await universe.accessPolicy());
      if (!CONFIG.ISOLATED_UNIVERSE) {
        console.log("Dropping temporary permissions on DEPLOYER");
        await createAccessPolicy(accessPolicy, [
          { subject: DEPLOYER, role: roles.eurtDepositManager, state: TriState.Unset },
          { subject: DEPLOYER, role: roles.eurtLegalManager, state: TriState.Unset },
          { subject: DEPLOYER, role: roles.identityManager, state: TriState.Unset },
          { subject: DEPLOYER, role: roles.tokenRateOracle, state: TriState.Unset },
          { subject: DEPLOYER, role: roles.lockedAccountAdmin, state: TriState.Unset },
          { subject: DEPLOYER, role: roles.disbursalManager, state: TriState.Unset },
          {
            subject: DEPLOYER,
            role: roles.universeManager,
            object: universe.address,
            state: TriState.Unset,
          },
        ]);

        console.log("---------------------------------------------");
        console.log(
          // eslint-disable-next-line max-len
          `ACCESS_CONTROLLER ${CONFIG.addresses.ACCESS_CONTROLLER} must remove access to deployer ${DEPLOYER} for object ${accessPolicy.address}`,
        );
        console.log("---------------------------------------------");
        console.log("On live network, enable LockedAccount migrations manually");
        console.log("On live network, set transfers from and to on ICBMEuroToken to EuroLock");
        console.log(
          // eslint-disable-next-line max-len
          `On live network, make sure PLATFORM_OPERATOR_WALLET ${CONFIG.addresses.PLATFORM_OPERATOR_WALLET} has KYC done`,
        );
        console.log(`On live network, send some ether to SimpleExchange`);
        console.log(
          // eslint-disable-next-line max-len
          `Must use ${CONFIG.addresses.PLATFORM_OPERATOR_REPRESENTATIVE} account to amend ToS agreement on Universe at ${universe.address}`,
        );
        console.log(
          `Must use ${
            CONFIG.addresses.EURT_LEGAL_MANAGER
          } account to amend Euro Token agreement at ${await universe.euroToken()}`,
        );
        console.log(
          `Must use ${
            CONFIG.addresses.PLATFORM_OPERATOR_REPRESENTATIVE
          } account to amend Euro Lock agreement at ${await universe.euroLock()}`,
        );
        console.log(
          `Must use ${
            CONFIG.addresses.PLATFORM_OPERATOR_REPRESENTATIVE
          } account to amend Ether Lock agreement at ${await universe.etherLock()}`,
        );
        console.log("---------------------------------------------");
      }
    }

    const endBlockNo = await promisify(web3.eth.getBlockNumber)();
    console.log(`deployment finished at block ${endBlockNo}`);

    const networkDefinition = getNetworkDefinition(network);
    networkDefinition.unlockedAccounts = accounts;
    networkDefinition.provider = undefined;

    const initialBlock = global._initialBlockNo || -1;
    const meta = {
      CONFIG,
      DEPLOYER,
      UNIVERSE_ADDRESS: universe.address,
      ICBM_COMMITMENT_ADDRESS: commitmentAddress,
      ROLES: roles,
      KNOWN_INTERFACES: knownInterfaces,
      INTERFACE_ARTIFACTS: interfaceArtifacts,
      NETWORK: networkDefinition,
      HEAD_BLOCK_NO: endBlockNo,
      INITIAL_BLOCK_NO: initialBlock,
    };
    const path = join(__dirname, "../build/meta.json");
    fs.writeFile(path, JSON.stringify(meta, null, 2), err => {
      if (err) throw new Error(err);
    });

    console.log("---------------------------------------------");
    console.log(`Universe is ${universe.address}`);
    console.log(`Deployment artifacts are in "${path}"`);
    console.log("---------------------------------------------");
  });
};
