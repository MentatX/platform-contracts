require("babel-register");
const fs = require("fs");
const { join } = require("path");
const getConfig = require("./config").getConfig;
const getFixtureAccounts = require("./getFixtureAccounts").getFixtureAccounts;
const { randomBytes32 } = require("../test/helpers/utils");
const { GovAction, GovExecutionState } = require("../test/helpers/govState");
const { shareCapitalToTokens } = require("../test/helpers/govUtils");
const { loadEtoFixtures, getEtoFixtureByName } = require("./helpers");
const { decodeBylaw } = require("../test/helpers/deployTerms");
const createAccessPolicy = require("../test/helpers/createAccessPolicy").default;
const roles = require("../test/helpers/roles").default;
const stringify = require("../test/helpers/utils").stringify;

module.exports = function deployContracts(deployer, network, accounts) {
  const CONFIG = getConfig(web3, network, accounts);
  if (CONFIG.shouldSkipStep(__filename)) return;
  if (CONFIG.isLiveDeployment) return;

  const Universe = artifacts.require(CONFIG.artifacts.UNIVERSE);
  const TokenController = artifacts.require(CONFIG.artifacts.EQUITY_TOKEN_CONTROLLER);
  const VotingCenter = artifacts.require(CONFIG.artifacts.VOTING_CENTER);
  const EquityToken = artifacts.require(CONFIG.artifacts.STANDARD_EQUITY_TOKEN);
  const TokenholderRights = artifacts.require("ITokenholderRights");
  const RoleBasedAccessPolicy = artifacts.require(CONFIG.artifacts.ROLE_BASED_ACCESS_POLICY);

  deployer.then(async () => {
    const fas = getFixtureAccounts(accounts);
    const issuer = fas.ISSUER_PAYOUT.address;
    // get payout commitment
    const etoFixtures = loadEtoFixtures();
    const payoutFixture = getEtoFixtureByName(etoFixtures, "ETOInPayoutState");
    const payoutController = await TokenController.at(payoutFixture.tokenController);
    const equityToken = await EquityToken.at(payoutFixture.equityToken);

    // issue general information
    const generalInfoRID = randomBytes32();
    console.log(`executing general information with ${generalInfoRID}`);
    await payoutController.generalResolution(
      generalInfoRID,
      GovAction.CompanyNone,
      "A general information from ISSUER_PAYOUT 2020",
      "ifps:QmVEJvxmo4M5ugvfSQfKzejW8cvXsWe8261MpGChov7DQt",
      { from: issuer },
    );
    // issue annual meeting resolution (SHR escalation)
    // note that offering, token and token controller were time-shifted
    // to provide balances at past snapshot
    const annualRID = randomBytes32();
    console.log(`executing annual meeting resolution ${annualRID}`);
    await payoutController.generalResolution(
      annualRID,
      GovAction.AnnualGeneralMeeting,
      "A Notice of General Meeting 2020",
      "ifps:QmVEJvxmo4M5ugvfSQfKzejW8cvXsWe8261MpGChov7DQt",
      { from: issuer },
    );

    const shareholderInformation = await payoutController.shareholderInformation();
    const govToken = await payoutController.governanceToken();
    const tokenholderRights = TokenholderRights.at(govToken[3]);
    const bylaw = await tokenholderRights.getBylaw(GovAction.AnnualGeneralMeeting);
    const decodedBylaw = decodeBylaw(GovAction.AnnualGeneralMeeting, `0x0${bylaw.toString(16)}`);

    // add issuer as voting initiator
    const universe = await Universe.deployed();
    const votingCenter = await VotingCenter.at(await universe.getSingleton("0xff5dbb18"));
    console.log(votingCenter.address);
    const accessPolicy = await RoleBasedAccessPolicy.at(await universe.accessPolicy());
    await createAccessPolicy(accessPolicy, [
      { subject: issuer, role: roles.votingInitiator, object: votingCenter.address },
    ]);

    // create proposal
    const proposalId = randomBytes32();
    console.log(`opening independent proposal ${proposalId}`);

    async function shareCapitalVotingPower(shareCapital) {
      return shareCapitalToTokens(
        shareCapital,
        await equityToken.tokensPerShare(),
        await equityToken.shareNominalValueUlps(),
      );
    }

    await votingCenter.addProposal(
      proposalId,
      equityToken.address,
      0,
      0,
      decodedBylaw[2],
      issuer,
      decodedBylaw[2],
      await shareCapitalVotingPower(shareholderInformation[0]),
      GovAction.AnnualGeneralMeeting,
      "General Meeting 2020 Resolution,ifps:QmVEJvxmo4M5ugvfSQfKzejW8cvXsWe8261MpGChov7DQt",
      false,
      { from: issuer },
    );

    // dump post investment state
    const proposalIds = [proposalId];
    const controllers = {};
    // dump all controllers and collect open proposals
    async function describeResolutions(controller) {
      const resolutions = {};
      const ids = await controller.resolutionsList();
      for (const id of ids) {
        resolutions[id] = await controller.resolution(id);
        // add to proposals to describe from voting center
        if (resolutions[id][1] === GovExecutionState.Escalating) {
          proposalIds.push(id);
        }
      }
      return resolutions;
    }

    for (const addr of Object.keys(etoFixtures)) {
      const etoFixture = etoFixtures[addr];
      const controller = await TokenController.at(etoFixture.tokenController);
      const controllerDesc = {
        address: addr,
        name: etoFixture.name,
        company: etoFixture.company,
        resolutions: await describeResolutions(controller),
        shareholderInformation: await controller.shareholderInformation(),
        governanceToken: await controller.governanceToken(),
        tokenOfferings: await controller.tokenOfferings(),
        moduleIds: await controller.moduleId(),
        contractId: await controller.contractId(),
      };
      controllers[addr] = stringify(controllerDesc);
    }
    // dump all proposals from voting center
    const openProposals = {};
    for (const propId of proposalIds) {
      openProposals[propId] = {
        proposal: await votingCenter.timedProposal(propId),
        tally: await votingCenter.tally(propId),
      };
    }
    const postInvestmentDesc = {
      controllers,
      openProposals,
    };
    const postInvestmentPath = join(__dirname, "../build/post_investment.json");
    fs.writeFile(postInvestmentPath, JSON.stringify(postInvestmentDesc, null, 2), err => {
      if (err) throw new Error(err);
    });
    console.log(`Post-Investment described in ${postInvestmentPath}`);
  });
};
