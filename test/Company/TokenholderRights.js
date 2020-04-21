import { expect } from "chai";
import { leftPad } from "web3-utils";
import { prettyPrintGasCost } from "../helpers/gasUtils";
import {
  deployTokenholderRights,
  verifyTerms,
  defaultTokenholderTerms,
  generateDefaultBylaws,
  decodeBylaw,
  encodeBylaw,
  applyBylawsToRights,
} from "../helpers/deployTerms";
import { Q18, web3, ZERO_BN, dayInSeconds } from "../helpers/constants";
import { contractId, getKeyByValue } from "../helpers/utils";
import {
  GovTokenVotingRule,
  GovAction,
  GovActionEscalation,
  GovActionLegalRep,
  hasVotingRights,
  isVotingEscalation,
} from "../helpers/govState";

const EquityTokenholderRights = artifacts.require("EquityTokenholderRights");

contract("TokenholderRights", () => {
  let sourceTerms;
  let tokenholderRights;
  let tokenholderTerms;
  let tokenholderTermsKeys;

  const votingRightsOvr = {
    GENERAL_VOTING_RULE: new web3.BigNumber(GovTokenVotingRule.Positive),
    TAG_ALONG_VOTING_RULE: new web3.BigNumber(GovTokenVotingRule.Negative),
  };
  const nonVotingRightsOvr = {
    GENERAL_VOTING_RULE: new web3.BigNumber(GovTokenVotingRule.NoVotingRights),
    TAG_ALONG_VOTING_RULE: new web3.BigNumber(GovTokenVotingRule.NoVotingRights),
  };

  it("deploy", async () => {
    await deployRights();
    await prettyPrintGasCost("TokenholderRights deploy", tokenholderRights);
    // console.log(await tokenholderRights.contractId());
    // console.log([contractId("EquityTokenholderRights"), new web3.BigNumber("1")]);
    expect((await tokenholderRights.contractId())[0]).to.eq(contractId("EquityTokenholderRights"));
    expect((await tokenholderRights.contractId())[1]).to.be.bignumber.eq(ZERO_BN);
    expect(await tokenholderRights.HAS_VOTING_RIGHTS()).to.be.true;
    const bylaws = await tokenholderRights.ACTION_BYLAWS();
    expect(bylaws.length).to.eq(24);

    await verifyTerms(tokenholderRights, tokenholderTermsKeys, tokenholderTerms);
  });

  describe("bylaws", () => {
    it("should create default bylaws with voting rights", async () => {
      sourceTerms = Object.assign({}, defaultTokenholderTerms, votingRightsOvr);
      const bylaws = generateDefaultBylaws(sourceTerms);
      expectDefaultBylaws(bylaws);
    });

    it("should create default bylaws without voting rights", async () => {
      sourceTerms = Object.assign({}, defaultTokenholderTerms, nonVotingRightsOvr);
      const bylaws = generateDefaultBylaws(sourceTerms);
      expectDefaultBylaws(bylaws);
    });

    it("should create custom bylaws", async () => {
      // replace ChangeOfControl with voting power bylaw where THR vote, not SHR
      const sourceBylaw = [
        GovActionEscalation.THR,
        new web3.BigNumber(dayInSeconds),
        Q18,
        Q18,
        Q18.mul("0.7"),
        GovTokenVotingRule.Prorata,
        GovActionLegalRep.Nominee,
      ];
      const coc = encodeBylaw(...sourceBylaw);
      const cocDecode = decodeBylaw(GovAction.ChangeOfControl, coc);
      expect(cocDecode[0]).to.eq("ChangeOfControl");
      for (let ii = 0; ii < sourceBylaw; ii += 1) {
        expect(cocDecode[ii + 1]).to.be.bignumber.eq(sourceBylaw[ii]);
      }

      // same bylaw but with no voting rights
      sourceBylaw[5] = GovTokenVotingRule.NoVotingRights;
      const cocNv = encodeBylaw(...sourceBylaw);
      const cocDecodeNv = decodeBylaw(GovAction.ChangeOfControl, cocNv);
      expect(cocDecodeNv[1]).to.be.bignumber.eq(GovActionEscalation.Nominee);
      expect(cocDecodeNv[2]).to.be.bignumber.eq(0);
      expect(cocDecodeNv[3]).to.be.bignumber.eq(0);
      expect(cocDecodeNv[4]).to.be.bignumber.eq(0);
      expect(cocDecodeNv[5]).to.be.bignumber.eq(0);
      expect(cocDecodeNv[6]).to.be.bignumber.eq(GovTokenVotingRule.NoVotingRights);
      expect(cocDecodeNv[7]).to.be.bignumber.eq(GovActionLegalRep.Nominee);
    });

    async function expectDeployedBylaws() {
      const bylaws = await tokenholderRights.ACTION_BYLAWS();
      const hexBylaws = bylaws.map(bn => `0x${leftPad(bn.toString(16), 14)}`);
      expectDefaultBylaws(hexBylaws);
      // get decoded bylaws, encode them and verify
      for (let ii = 0; ii < 24; ii += 1) {
        const bylaw = await tokenholderRights.getBylaw(ii);
        const decodedBylaw = await tokenholderRights.decodeBylaw(bylaw);
        const reEncodedBylaw = encodeBylaw(...onchainDecodedBylawToEnums(decodedBylaw));
        expect(bylaw, getKeyByValue(GovAction, ii)).to.be.bignumber.eq(reEncodedBylaw);
        expect(bylaw).to.be.bignumber.eq(bylaws[ii]);
      }
      // get default bylaws
      const noneBylaw = await tokenholderRights.getDefaultBylaw();
      expect(noneBylaw).to.be.bignumber.eq(bylaws[GovAction.None]);
      const restrictedBylaw = await tokenholderRights.getRestrictedBylaw();
      expect(restrictedBylaw).to.be.bignumber.eq(bylaws[GovAction.RestrictedNone]);
    }

    it("should deploy default bylaws with no voting rights", async () => {
      await deployRights(nonVotingRightsOvr);
      await expectDeployedBylaws();
    });

    it("should deploy default bylaws with voting rights", async () => {
      await deployRights(votingRightsOvr);
      await expectDeployedBylaws();
    });

    it("should deploy custom bylaws", async () => {
      sourceTerms = Object.assign({}, defaultTokenholderTerms);
      const bylaws = generateDefaultBylaws(sourceTerms);
      // replace ChangeOfControl with voting power bylaw where THR vote, not SHR
      const coc = encodeBylaw(
        GovActionEscalation.THR,
        new web3.BigNumber(dayInSeconds).mul(255),
        Q18,
        Q18,
        Q18.mul("0.01"),
        GovTokenVotingRule.Prorata,
        GovActionLegalRep.Nominee,
      );
      bylaws[GovAction.ChangeOfControl] = coc;
      const fullRights = applyBylawsToRights(Object.assign({}, defaultTokenholderTerms), bylaws);
      [tokenholderRights, tokenholderTerms, tokenholderTermsKeys] = await deployTokenholderRights(
        EquityTokenholderRights,
        fullRights,
        true,
      );
      const onchainCoc = await tokenholderRights.getBylaw(GovAction.ChangeOfControl);
      expect(onchainCoc).to.be.bignumber.eq(new web3.BigNumber(coc, 16));
      const cocDecode = await tokenholderRights.decodeBylaw(onchainCoc);
      expect(cocDecode[0]).to.be.bignumber.eq(GovActionEscalation.THR);
      expect(cocDecode[1]).to.be.bignumber.eq(255);
      expect(cocDecode[2]).to.be.bignumber.eq(100);
      expect(cocDecode[3]).to.be.bignumber.eq(100);
      expect(cocDecode[4]).to.be.bignumber.eq(1);
      expect(cocDecode[5]).to.be.bignumber.eq(GovTokenVotingRule.Prorata);
      expect(cocDecode[6]).to.be.bignumber.eq(GovActionLegalRep.Nominee);
    });
  });

  function onchainDecodedBylawToEnums(bylaw) {
    const frac = bn => bn.mul(Q18).div("100");
    return [
      bylaw[0].toNumber(),
      bylaw[1].mul(dayInSeconds),
      frac(bylaw[2]),
      frac(bylaw[3]),
      frac(bylaw[4]),
      bylaw[5].toNumber(),
      bylaw[6].toNumber(),
    ];
  }

  async function deployRights(termsOvr) {
    sourceTerms = Object.assign({}, defaultTokenholderTerms, termsOvr || {});
    [tokenholderRights, tokenholderTerms, tokenholderTermsKeys] = await deployTokenholderRights(
      EquityTokenholderRights,
      termsOvr,
    );
  }

  const expectedEscalations = [
    GovActionEscalation.SHR,
    GovActionEscalation.SHR,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.ParentResolution,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.SHR,
    GovActionEscalation.SHR,
    GovActionEscalation.Anyone,
    GovActionEscalation.SHR,
    GovActionEscalation.SHR,
    GovActionEscalation.SHR,
    GovActionEscalation.Nominee,
    GovActionEscalation.TokenHolder,
    GovActionEscalation.SHR,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.SHR,
    GovActionEscalation.SHR,
    GovActionEscalation.THR,
    GovActionEscalation.SHR,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.CompanyLegalRep,
    GovActionEscalation.Anyone,
  ];

  function downgradeEscalation(escalation) {
    switch (escalation) {
      case GovActionEscalation.THR:
        return GovActionEscalation.Nominee;
      case GovActionEscalation.SHR:
        return GovActionEscalation.CompanyLegalRep;
      default:
        return escalation;
    }
  }

  const expectedNonVotingEscalations = expectedEscalations.map(e => downgradeEscalation(e));

  function escalationToRep(escalation) {
    switch (escalation) {
      case GovActionEscalation.THR:
        return GovActionLegalRep.Nominee;
      case GovActionEscalation.SHR:
        return GovActionLegalRep.CompanyLegalRep;
      default:
        return GovActionLegalRep.None;
    }
  }

  const expectedLegalReps = expectedEscalations.map(e => escalationToRep(e));

  function expectDefaultBylaws(bylaws) {
    expect(bylaws.length).to.eq(Object.keys(GovAction).length);
    const escalations = hasVotingRights(sourceTerms.GENERAL_VOTING_RULE)
      ? expectedEscalations
      : expectedNonVotingEscalations;
    for (let ii = 0; ii < bylaws.length; ii += 1) {
      const decodedBylaw = decodeBylaw(ii, bylaws[ii]);
      expect(decodedBylaw[1], decodedBylaw[0]).to.be.bignumber.eq(escalations[ii]);
      expect(decodedBylaw[7], decodedBylaw[0]).to.be.bignumber.eq(expectedLegalReps[ii]);
      expectBylawCore(decodedBylaw);
    }
  }

  function isRestrictedAct(action) {
    return [
      GovAction.RestrictedNone,
      GovAction.DissolveCompany,
      GovAction.ChangeOfControl,
    ].includes(action);
  }

  function expectBylawCore(decodedBylaw) {
    if (isVotingEscalation(decodedBylaw[1])) {
      expect(decodedBylaw[3], decodedBylaw[0]).to.be.bignumber.eq(
        sourceTerms.SHAREHOLDERS_VOTING_QUORUM_FRAC,
      );
      expect(decodedBylaw[4], decodedBylaw[0]).to.be.bignumber.eq(sourceTerms.VOTING_MAJORITY_FRAC);
      if (GovAction[decodedBylaw[0]] === GovAction.TagAlong) {
        expect(decodedBylaw[6], decodedBylaw[0]).to.be.bignumber.eq(
          sourceTerms.TAG_ALONG_VOTING_RULE,
        );
      } else {
        expect(decodedBylaw[6], decodedBylaw[0]).to.be.bignumber.eq(
          sourceTerms.GENERAL_VOTING_RULE,
        );
      }
      if (isRestrictedAct(GovAction[decodedBylaw[0]])) {
        expect(decodedBylaw[2], decodedBylaw[0]).to.be.bignumber.eq(
          sourceTerms.RESTRICTED_ACT_VOTING_DURATION,
        );
      } else {
        expect(decodedBylaw[2], decodedBylaw[0]).to.be.bignumber.eq(
          sourceTerms.GENERAL_VOTING_DURATION,
        );
      }
    } else {
      expect(decodedBylaw[2], decodedBylaw[0]).to.be.bignumber.eq(ZERO_BN);
      expect(decodedBylaw[3], decodedBylaw[0]).to.be.bignumber.eq(ZERO_BN);
      expect(decodedBylaw[4], decodedBylaw[0]).to.be.bignumber.eq(ZERO_BN);
      expect(decodedBylaw[6], decodedBylaw[0]).to.be.bignumber.eq(
        GovTokenVotingRule.NoVotingRights,
      );
    }
    expect(decodedBylaw[5], decodedBylaw[0]).to.be.bignumber.eq(ZERO_BN);
  }
});
