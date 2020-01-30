require("babel-register");
const getConfig = require("./config").getConfig;
const getDeployerAccount = require("./config").getDeployerAccount;
const initializeMigrationStep = require("./helpers").initializeMigrationStep;
const knownInterfaces = require("../test/helpers/knownInterfaces").knownInterfaces;
const { TriState } = require("../test/helpers/triState");
const roles = require("../test/helpers/roles").default;
const createAccessPolicy = require("../test/helpers/createAccessPolicy").default;
const Q18 = require("../test/helpers/constants").Q18;

module.exports = function deployContracts(deployer, network, accounts) {
  const CONFIG = getConfig(web3, network, accounts);
  if (CONFIG.shouldSkipStep(__filename)) return;

  const PlatformTerms = artifacts.require(CONFIG.artifacts.PLATFORM_TERMS);
  const EuroToken = artifacts.require(CONFIG.artifacts.EURO_TOKEN);
  const ICBMLockedAccount = artifacts.require(CONFIG.artifacts.ICBM_LOCKED_ACCOUNT);
  const ICBMEuroToken = artifacts.require(CONFIG.artifacts.ICBM_EURO_TOKEN);
  const EuroTokenController = artifacts.require(CONFIG.artifacts.EURO_TOKEN_CONTROLLER);
  const FeeDisbursal = artifacts.require(CONFIG.artifacts.FEE_DISBURSAL);
  const FeeDisbursalController = artifacts.require(CONFIG.artifacts.FEE_DISBURSAL_CONTROLLER);
  const RoleBasedAccessPolicy = artifacts.require(CONFIG.artifacts.ROLE_BASED_ACCESS_POLICY);

  deployer.then(async () => {
    const universe = await initializeMigrationStep(CONFIG, artifacts, web3);
    // deploy fee disbursal and controller
    console.log("Deploying FeeDisbursalController");
    await deployer.deploy(FeeDisbursalController, universe.address);
    const controller = await FeeDisbursalController.deployed();
    console.log("Deploying FeeDisbursal");
    await deployer.deploy(FeeDisbursal, universe.address, controller.address);
    const feeDisbursal = await FeeDisbursal.deployed();

    // set some permissions
    const euroTokenAddress = await universe.euroToken();
    const etherTokenAddress = await universe.etherToken();
    const euroToken = await EuroToken.at(euroTokenAddress);
    const icbmEuroLockedAccount = await ICBMLockedAccount.at(await universe.icbmEuroLock());
    const icbmEtherLockedAccount = await ICBMLockedAccount.at(await universe.icbmEtherLock());
    const icbmEuroToken = await ICBMEuroToken.at(await icbmEuroLockedAccount.assetToken());
    const tokenController = await EuroTokenController.at(await euroToken.tokenController());
    const DEPLOYER = getDeployerAccount(network, accounts);

    const accessPolicy = await RoleBasedAccessPolicy.at(await universe.accessPolicy());
    console.log("Setting permissions");
    await createAccessPolicy(accessPolicy, [
      // temporary access to universe, will be dropped in finalize
      {
        subject: DEPLOYER,
        role: roles.universeManager,
        object: universe.address,
        state: TriState.Allow,
      },
      // temporary access to euro token controller, will be dropped in finalize
      { subject: DEPLOYER, role: roles.eurtLegalManager },
      // temporary deposit manager so icbm euro token permissions can be changed
      { subject: DEPLOYER, role: roles.eurtDepositManager },
      // temporary locked account manager to set fee disbursal contract
      { subject: DEPLOYER, role: roles.lockedAccountAdmin },
      // add platform wallet to disbursers
      {
        subject: CONFIG.PLATFORM_OPERATOR_WALLET,
        role: roles.disburser,
        object: feeDisbursal.address,
        state: TriState.Allow,
      },
      // add deposit manager role to feeDisbursal to be able to convert old nEur to new nEur
      {
        subject: feeDisbursal.address,
        role: roles.eurtDepositManager,
        object: euroTokenAddress,
        state: TriState.Allow,
      },
    ]);
    // set as default disbursal
    console.log("Setting singletons");
    await universe.setSingleton(knownInterfaces.feeDisbursal, feeDisbursal.address);

    const minDeposit = await tokenController.minDepositAmountEurUlps();
    const minWithdraw = await tokenController.minWithdrawAmountEurUlps();
    const maxAllowance = await tokenController.maxSimpleExchangeAllowanceEurUlps();
    console.log(
      `re-apply token controller settings to reload feeDisbursal permissions ${minDeposit
        .div(Q18)
        .toNumber()} ${minWithdraw.div(Q18).toNumber()} ${maxAllowance.div(Q18).toNumber()}`,
    );
    await tokenController.applySettings(minDeposit, minWithdraw, maxAllowance);

    console.log("Setting fee disbursal in ICBM Locked Contracts");
    await icbmEuroLockedAccount.setPenaltyDisbursal(feeDisbursal.address);
    await icbmEtherLockedAccount.setPenaltyDisbursal(feeDisbursal.address);

    console.log("Giving ICBM Euro Token broker permissions to FeeDisbursal");
    await icbmEuroToken.setAllowedTransferTo(feeDisbursal.address, true);
    await icbmEuroToken.setAllowedTransferFrom(feeDisbursal.address, true);

    console.log("add payment tokens to payment tokens collection");
    await universe.setCollectionsInterfaces(
      [knownInterfaces.paymentTokenInterface, knownInterfaces.paymentTokenInterface],
      [euroTokenAddress, etherTokenAddress],
      [true, true],
    );
    if (CONFIG.isLiveDeployment) {
      console.log("re-deploying PlatformTerms on live network");
      await deployer.deploy(PlatformTerms);
      const platformTerms = await PlatformTerms.deployed();
      await universe.setSingleton(knownInterfaces.platformTerms, platformTerms.address);
    }
  });
};
