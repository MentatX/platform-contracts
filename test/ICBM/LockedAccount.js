import { expect } from "chai";
import moment from "moment";
import { hasEvent, eventValue } from "../helpers/events";
import {
  deployControlContracts,
  deployNeumark,
  deployICBMLockedAccount,
  applyTransferPermissions,
  deployPlatformTerms,
  deployFeeDisbursalUniverse,
  deployUniverse,
  deployEuroTokenUniverse,
  deployEtherTokenUniverse,
} from "../helpers/deployContracts";
import increaseTime, { setTimeTo } from "../helpers/increaseTime";
import { latestTimestamp } from "../helpers/latestTime";
import EvmError from "../helpers/EVMThrow";
import { TriState } from "../helpers/triState";
import { LockState } from "./lockState";
import forceEther from "../helpers/forceEther";
import { etherToWei } from "../helpers/unitConverter";
import roles from "../helpers/roles";
import { promisify } from "../helpers/evmCommands";
import { dayInSeconds, monthInSeconds, Q18 } from "../helpers/constants";
import { knownInterfaces } from "../helpers/knownInterfaces";
import { getKeyByValue } from "../helpers/utils";

const ICBMEtherToken = artifacts.require("ICBMEtherToken");
const ICBMEuroToken = artifacts.require("ICBMEuroToken");
const TestFeeDistributionPool = artifacts.require("TestFeeDistributionPool");
const TestNullContract = artifacts.require("TestNullContract");
const TestICBMLockedAccountMigrationTarget = artifacts.require(
  "TestICBMLockedAccountMigrationTarget",
);

const gasPrice = new web3.BigNumber(0x01); // this low gas price is forced by code coverage
const LOCK_PERIOD = 18 * monthInSeconds;
const UNLOCK_PENALTY_FRACTION = Q18.mul(0.1).round(0, 0);

contract(
  "ICBMLockedAccount",
  ([_, admin, investor, investor2, otherMigrationSource, operatorWallet]) => {
    let controller;
    let startTimestamp;
    let assetToken;
    let lockedAccount;
    let migrationTarget;
    let testDisbursal;
    let noCallbackContract;
    let neumark;
    let accessPolicy;
    let forkArbiter;

    beforeEach(async () => {
      [accessPolicy, forkArbiter] = await deployControlContracts();
      neumark = await deployNeumark(accessPolicy, forkArbiter);
    });

    describe("ICBMEtherToken", () => {
      async function deployEtherToken() {
        assetToken = await ICBMEtherToken.new(accessPolicy.address);
      }

      async function makeDepositEth(from, to, amount) {
        await assetToken.deposit({ from, value: amount });
        if (from !== to) {
          await assetToken.approve(to, amount, { from });
        }
      }

      async function makeWithdrawEth(investorAddress, amount) {
        const initalBalance = await promisify(web3.eth.getBalance)(investorAddress);
        const tx = await assetToken.withdraw(amount, {
          from: investorAddress,
          gasPrice,
        });
        const afterBalance = await promisify(web3.eth.getBalance)(investorAddress);
        const gasCost = gasPrice.mul(tx.receipt.gasUsed);
        expect(afterBalance).to.be.bignumber.eq(initalBalance.add(amount).sub(gasCost));
      }

      beforeEach(async () => {
        await deployEtherToken();
        [lockedAccount, controller] = await deployICBMLockedAccount(
          accessPolicy,
          neumark,
          admin,
          assetToken,
          operatorWallet,
          LOCK_PERIOD,
          UNLOCK_PENALTY_FRACTION,
        );
        await deployAuxiliaryContracts();
      });

      describe("core tests", () => {
        lockedAccountTestCases(makeDepositEth, makeWithdrawEth);
      });

      describe("migration tests", () => {
        beforeEach(async () => {
          migrationTarget = await deployMigrationTarget(assetToken, operatorWallet);
        });

        lockedAccountMigrationTestCases(makeDepositEth, makeWithdrawEth);
      });
    });

    describe("ICBMEuroToken", () => {
      async function deployEuroToken() {
        assetToken = await ICBMEuroToken.new(accessPolicy.address);
        await accessPolicy.setUserRole(
          admin,
          roles.eurtDepositManager,
          assetToken.address,
          TriState.Allow,
        );
      }

      async function makeDepositEuro(from, to, amount) {
        // 'admin' has all the money in the bank, 'from' receives transfer permission to receive funds
        await assetToken.deposit(from, amount, { from: admin });
        if (from !== to) {
          await assetToken.approve(to, amount, { from });
        }
      }

      async function makeWithdrawEuro(from, amount) {
        const initalBalance = await assetToken.balanceOf.call(from);
        // notifies bank to pay out EUR, burns EURT
        await assetToken.withdraw(amount, { from });
        const afterBalance = await assetToken.balanceOf.call(from);
        expect(afterBalance).to.be.bignumber.eq(initalBalance.sub(amount));
      }

      beforeEach(async () => {
        await deployEuroToken();
        [lockedAccount, controller] = await deployICBMLockedAccount(
          accessPolicy,
          neumark,
          admin,
          assetToken,
          operatorWallet,
          LOCK_PERIOD,
          UNLOCK_PENALTY_FRACTION,
        );
        await deployAuxiliaryContracts();
        await applyTransferPermissions(assetToken, admin, [
          { side: "from", address: lockedAccount.address },
          { side: "to", address: lockedAccount.address },
          { side: "from", address: controller.address },
          { side: "to", address: controller.address },
          { side: "from", address: testDisbursal.address },
          { side: "to", address: testDisbursal.address },
          { side: "from", address: noCallbackContract.address },
          { side: "to", address: noCallbackContract.address },
          { side: "to", address: operatorWallet },
        ]);
      });

      describe("core tests", () => {
        lockedAccountTestCases(makeDepositEuro, makeWithdrawEuro);
      });

      describe("migration tests", () => {
        beforeEach(async () => {
          migrationTarget = await deployMigrationTarget(assetToken, operatorWallet);
          await applyTransferPermissions(assetToken, admin, [
            { side: "from", address: migrationTarget.address },
            { side: "to", address: migrationTarget.address },
          ]);
        });

        lockedAccountMigrationTestCases(makeDepositEuro, makeWithdrawEuro);
      });
    });

    function lockedAccountMigrationTestCases(makeDeposit, makeWithdraw) {
      function expectMigrationEnabledEvent(tx, target) {
        const event = eventValue(tx, "LogMigrationEnabled");
        expect(event).to.exist;
        expect(event.args.target).to.be.equal(target);
      }

      function expectInvestorMigratedEvent(tx, investorAddress, ticket, neumarks, unlockDate) {
        const event = eventValue(tx, "LogInvestorMigrated");
        expect(event).to.exist;
        expect(event.args.investor).to.be.equal(investorAddress);
        expect(event.args.amount).to.be.bignumber.equal(ticket);
        expect(event.args.neumarks).to.be.bignumber.equal(neumarks);
        // check unlockDate optionally
        if (unlockDate) {
          expect(event.args.unlockDate).to.be.bignumber.equal(unlockDate);
        }
      }

      async function migrateOne(ticket, investorAddress) {
        const neumarks = ticket.mul(6.5);
        // lock investor
        await makeDeposit(investorAddress, controller.address, ticket);
        await controller.investToken(neumarks, { from: investorAddress });
        const investorBalanceBefore = await lockedAccount.balanceOf.call(investorAddress);
        const assetBalanceSourceBefore = await assetToken.balanceOf.call(lockedAccount.address);
        await migrationTarget.setMigrationSource(lockedAccount.address, {
          from: admin,
        });
        expect(await migrationTarget.currentMigrationSource()).to.eq(lockedAccount.address);
        let tx = await lockedAccount.enableMigration(migrationTarget.address, {
          from: admin,
        });
        expectMigrationEnabledEvent(tx, migrationTarget.address);
        expect(await lockedAccount.currentMigrationTarget()).to.be.eq(migrationTarget.address);
        // migrate investor
        tx = await lockedAccount.migrate({ from: investorAddress });
        expectInvestorMigratedEvent(
          tx,
          investorAddress,
          ticket,
          neumarks,
          investorBalanceBefore[2],
        );
        // check invariants
        expect(await lockedAccount.totalLockedAmount()).to.be.bignumber.equal(0);
        expect(await migrationTarget.totalLockedAmount()).to.be.bignumber.equal(ticket);
        expect(await lockedAccount.totalInvestors()).to.be.bignumber.equal(0);
        expect(await migrationTarget.totalInvestors()).to.be.bignumber.equal(1);
        // check balance on old - no investor
        const investorBalanceAfter = await lockedAccount.balanceOf.call(investorAddress);
        // unlockDate == 0: does not exit
        expect(investorBalanceAfter[2]).to.be.bignumber.equal(0);
        // check asset balance
        const assetBalanceSourceAfter = await assetToken.balanceOf.call(lockedAccount.address);
        const assetBalanceTargetAfter = await assetToken.balanceOf.call(migrationTarget.address);
        expect(assetBalanceSourceAfter).to.be.bignumber.eq(assetBalanceSourceBefore.sub(ticket));
        expect(assetBalanceTargetAfter).to.be.bignumber.eq(ticket);
      }

      async function enableReleaseAll() {
        await migrationTarget.setController(admin, { from: admin });
        await migrationTarget.controllerFailed({ from: admin });
      }

      it("call migrate not from source should throw", async () => {
        const ticket = 1; // 1 wei ticket
        // test migration accepts any address
        await migrationTarget.setMigrationSource(otherMigrationSource, {
          from: admin,
        });
        await makeDeposit(otherMigrationSource, otherMigrationSource, ticket);
        // set allowance in asset token
        await assetToken.approve(migrationTarget.address, 1, {
          from: otherMigrationSource,
        });
        await migrationTarget.migrateInvestor(investor2, ticket, 1, startTimestamp, {
          from: otherMigrationSource,
        });
        // set allowances again
        await makeDeposit(otherMigrationSource, otherMigrationSource, ticket);
        await assetToken.approve(migrationTarget.address, ticket, {
          from: otherMigrationSource,
        });
        // change below to 'from: otherMigrationSource' from this test to fail
        await expect(
          migrationTarget.migrateInvestor(investor, ticket, 1, startTimestamp, {
            from: admin,
          }),
        ).to.be.rejectedWith(EvmError);
      });

      it("rejects target with source address not matching contract enabling migration", async () => {
        // we set invalid source here, change to lockedAccount.address for this test to fail
        await migrationTarget.setMigrationSource(otherMigrationSource, {
          from: admin,
        });
        // accepts only lockedAccount as source, otherMigrationSource points to different contract
        await expect(
          lockedAccount.enableMigration(migrationTarget.address, {
            from: admin,
          }),
        ).to.be.rejectedWith(EvmError);
      });

      it("should migrate investor", async () => {
        await migrateOne(etherToWei(1), investor);
      });

      it("should migrate investor then unlock and withdraw", async () => {
        const ticket = etherToWei(1);
        await migrateOne(ticket, investor);
        await enableReleaseAll();
        // no need to burn neumarks
        await migrationTarget.unlock({ from: investor });
        await makeWithdraw(investor, ticket);
      });

      it("migrate same investor twice should do nothing", async () => {
        await migrateOne(etherToWei(1), investor);
        const tx = await lockedAccount.migrate({ from: investor });
        expect(hasEvent(tx, "LogInvestorMigrated")).to.be.false;
      });

      it("migrate non existing investor should do nothing", async () => {
        await migrateOne(etherToWei(1), investor);
        const tx = await lockedAccount.migrate({ from: investor2 });
        expect(hasEvent(tx, "LogInvestorMigrated")).to.be.false;
      });

      it("should reject investor migration before it is enabled", async () => {
        const ticket = etherToWei(3.18919182);
        const neumarks = etherToWei(1.189729111);
        await makeDeposit(investor, controller.address, ticket);
        await controller.investToken(neumarks, { from: investor });
        await migrationTarget.setMigrationSource(lockedAccount.address, {
          from: admin,
        });
        // uncomment below for this test to fail
        // await lockedAccount.enableMigration( migrationTarget.address, {from: admin} );
        await expect(lockedAccount.migrate({ from: investor })).to.be.rejectedWith(EvmError);
      });

      async function expectMigrationInState(state) {
        const ticket = etherToWei(3.18919182);
        const neumarks = etherToWei(1.189729111);
        await makeDeposit(investor, controller.address, ticket);
        await controller.investToken(neumarks, { from: investor });
        await migrationTarget.setMigrationSource(lockedAccount.address, {
          from: admin,
        });
        if (state === LockState.AcceptingUnlocks) {
          await controller.succ();
        }
        expect(await lockedAccount.lockState.call()).to.be.bignumber.eq(state);
        await lockedAccount.enableMigration(migrationTarget.address, {
          from: admin,
        });
        const tx = await lockedAccount.migrate({ from: investor });
        expectInvestorMigratedEvent(tx, investor, ticket, neumarks);
      }

      it("should migrate investor in AcceptUnlocks", async () => {
        await expectMigrationInState(LockState.AcceptingUnlocks);
      });

      it("should migrate investor in AcceptLocks", async () => {
        await expectMigrationInState(LockState.AcceptingLocks);
      });

      it("should reject enabling migration from invalid account", async () => {
        const ticket = etherToWei(3.18919182);
        const neumarks = etherToWei(1.189729111);
        await makeDeposit(investor, controller.address, ticket);
        await controller.investToken(neumarks, { from: investor });
        await migrationTarget.setMigrationSource(lockedAccount.address, {
          from: admin,
        });
        await expect(
          lockedAccount.enableMigration(migrationTarget.address, {
            from: otherMigrationSource,
          }),
        ).to.be.rejectedWith(EvmError);
      });

      it("should reject enabling migration for a second time", async () => {
        await migrationTarget.setMigrationSource(lockedAccount.address, {
          from: admin,
        });
        await lockedAccount.enableMigration(migrationTarget.address, {
          from: admin,
        });
        // must throw
        await expect(
          lockedAccount.enableMigration(migrationTarget.address, {
            from: admin,
          }),
        ).to.be.rejectedWith(EvmError);
      });
    }

    function lockedAccountTestCases(makeDeposit, makeWithdraw) {
      function expectLockEvent(tx, investorAddress, ticket, neumarks) {
        const event = eventValue(tx, "LogFundsLocked");
        expect(event).to.exist;
        expect(event.args.investor).to.equal(investorAddress);
        expect(event.args.amount).to.be.bignumber.equal(ticket);
        expect(event.args.neumarks).to.be.bignumber.equal(neumarks);
      }

      function expectNeumarksBurnedEvent(tx, owner, euroUlps, neumarkUlps) {
        const event = eventValue(tx, "LogNeumarksBurned");
        expect(event).to.exist;
        expect(event.args.owner).to.equal(owner);
        expect(event.args.euroUlps).to.be.bignumber.equal(euroUlps);
        expect(event.args.neumarkUlps).to.be.bignumber.equal(neumarkUlps);
      }

      function expectUnlockEvent(tx, investorAddress, amount, neumarksBurned) {
        const event = eventValue(tx, "LogFundsUnlocked");
        expect(event).to.exist;
        expect(event.args.investor).to.equal(investorAddress);
        expect(event.args.amount).to.be.bignumber.equal(amount);
        expect(event.args.neumarks).to.be.bignumber.equal(neumarksBurned);
      }

      async function expectPenaltyEvent(tx, investorAddress, penalty) {
        const disbursalPool = await lockedAccount.penaltyDisbursalAddress();
        const event = eventValue(tx, "LogPenaltyDisbursed");
        expect(event).to.exist;
        expect(event.args.disbursalPoolAddress).to.equal(disbursalPool);
        expect(event.args.amount).to.be.bignumber.equal(penalty);
        expect(event.args.assetToken).to.equal(assetToken.address);
        expect(event.args.investor).to.equal(investorAddress);
      }

      async function expectPenaltyBalance(penalty) {
        const disbursalPool = await lockedAccount.penaltyDisbursalAddress();
        const poolBalance = await assetToken.balanceOf.call(disbursalPool);
        expect(poolBalance).to.be.bignumber.eq(penalty);
      }

      async function lock(investorAddress, ticket) {
        // initial state of the lock
        const initialLockedAmount = await lockedAccount.totalLockedAmount();
        const initialAssetSupply = await assetToken.totalSupply();
        const initialNumberOfInvestors = await lockedAccount.totalInvestors();
        const initialNeumarksBalance = await neumark.balanceOf(investorAddress);
        const initialLockedBalance = await lockedAccount.balanceOf(investorAddress);
        // issue real neumarks and check against
        let tx = await neumark.issueForEuro(ticket, {
          from: investorAddress,
        });
        const neumarks = eventValue(tx, "LogNeumarksIssued", "neumarkUlps");
        expect(await neumark.balanceOf(investorAddress)).to.be.bignumber.equal(
          neumarks.add(initialNeumarksBalance),
        );
        // only controller can lock
        await makeDeposit(investorAddress, controller.address, ticket);
        tx = await controller.investToken(neumarks, { from: investorAddress });
        expectLockEvent(tx, investorAddress, ticket, neumarks);
        // timestamp of block _investFor was mined
        const txBlock = await promisify(web3.eth.getBlock)(tx.receipt.blockNumber);
        const timebase = txBlock.timestamp;
        const investorBalance = await lockedAccount.balanceOf(investorAddress);
        expect(investorBalance[0]).to.be.bignumber.equal(ticket.add(initialLockedBalance[0]));
        expect(investorBalance[1]).to.be.bignumber.equal(neumarks.add(initialLockedBalance[1]));
        // verify longstop date independently
        let unlockDate = new web3.BigNumber(timebase + 18 * 30 * dayInSeconds);
        if (initialLockedBalance[2] > 0) {
          // earliest date is preserved for repeated investor address
          unlockDate = initialLockedBalance[2];
        }
        expect(investorBalance[2], "18 months in future").to.be.bignumber.eq(unlockDate);
        expect(await lockedAccount.totalLockedAmount()).to.be.bignumber.equal(
          initialLockedAmount.add(ticket),
        );
        expect(await assetToken.totalSupply()).to.be.bignumber.equal(
          initialAssetSupply.add(ticket),
        );
        const hasNewInvestor = initialLockedBalance[2] > 0 ? 0 : 1;
        expect(await lockedAccount.totalInvestors()).to.be.bignumber.equal(
          initialNumberOfInvestors.add(hasNewInvestor),
        );

        return neumarks;
      }

      async function unlockWithApprove(investorAddress, neumarkToBurn) {
        // investor approves transfer to lock contract to burn neumarks
        // console.log(`investor has ${parseInt(await neumark.balanceOf(investor))}`);
        const tx = await neumark.approve(lockedAccount.address, neumarkToBurn, {
          from: investorAddress,
        });
        expect(eventValue(tx, "Approval", "amount")).to.be.bignumber.equal(neumarkToBurn);
        // only investor can unlock and must burn tokens
        return lockedAccount.unlock({ from: investorAddress });
      }

      async function unlockWithCallback(investorAddress, neumarkToBurn) {
        // investor approves transfer to lock contract to burn neumarks
        // console.log(`investor has ${await neumark.balanceOf(investor)} against ${neumarkToBurn}`);
        // console.log(`${lockedAccount.address} should spend`);
        // await lockedAccount.receiveApproval(investor, neumarkToBurn, neumark.address, "");
        const tx = await neumark.approveAndCall(lockedAccount.address, neumarkToBurn, "", {
          from: investorAddress,
        });
        expect(eventValue(tx, "Approval", "amount")).to.be.bignumber.equal(neumarkToBurn);

        return tx;
      }

      async function unlockWithCallbackUnknownToken(investorAddress, neumarkToBurn) {
        // asset token is not allowed to call unlock on ICBMLockedAccount, change to neumark for test to fail
        await expect(
          assetToken.approveAndCall(lockedAccount.address, neumarkToBurn, "", {
            from: investorAddress,
          }),
        ).to.be.rejectedWith(EvmError);
      }

      async function calculateUnlockPenalty(ticket) {
        return ticket.mul(await lockedAccount.penaltyFraction()).div(etherToWei(1));
      }

      async function assertCorrectUnlock(tx, investorAddress, ticket, penalty) {
        const disbursalPool = await lockedAccount.penaltyDisbursalAddress();
        expect(await lockedAccount.totalLockedAmount()).to.be.bignumber.equal(0);
        expect(await assetToken.totalSupply()).to.be.bignumber.equal(ticket);
        // returns tuple as array
        const investorBalance = await lockedAccount.balanceOf(investorAddress);
        expect(investorBalance[2]).to.be.bignumber.eq(0); // checked by timestamp == 0
        expect(await lockedAccount.totalInvestors()).to.be.bignumber.eq(0);
        const balanceOfInvestorAndPool = (await assetToken.balanceOf(investorAddress)).add(
          await assetToken.balanceOf(disbursalPool),
        );
        expect(balanceOfInvestorAndPool).to.be.bignumber.equal(ticket);
        // check penalty value
        await expectPenaltyBalance(penalty);
        // 0 neumarks at the end
        expect(await neumark.balanceOf(investorAddress)).to.be.bignumber.equal(0);
      }

      async function enableUnlocks() {
        // move time forward within longstop date
        await increaseTime(moment.duration(dayInSeconds, "s"));
        // controller says yes
        await controller.succ();
      }

      async function allowToReclaim(account) {
        await accessPolicy.setUserRole(
          account,
          roles.reclaimer,
          lockedAccount.address,
          TriState.Allow,
        );
      }

      it("should be able to read lock parameters", async () => {
        expect(await lockedAccount.totalLockedAmount.call()).to.be.bignumber.eq(0);
        expect(await lockedAccount.totalInvestors.call()).to.be.bignumber.eq(0);
        expect(await lockedAccount.assetToken.call()).to.eq(assetToken.address);
        expect(await lockedAccount.neumark.call()).to.eq(neumark.address);
        expect(await lockedAccount.lockPeriod.call()).to.be.bignumber.eq(LOCK_PERIOD);
        expect(await lockedAccount.penaltyFraction.call()).to.be.bignumber.eq(
          UNLOCK_PENALTY_FRACTION,
        );
        expect(await lockedAccount.lockState.call()).to.be.bignumber.eq(LockState.AcceptingLocks);
        expect(await lockedAccount.controller.call()).to.eq(controller.address);
        expect(await lockedAccount.penaltyDisbursalAddress.call()).to.eq(operatorWallet);
      });

      it("should lock", async () => {
        await lock(investor, etherToWei(1));
      });

      it("should lock two different investors", async () => {
        await lock(investor, etherToWei(1));
        await lock(investor2, etherToWei(0.5));
      });

      it("should lock same investor", async () => {
        await lock(investor, etherToWei(1));
        await lock(investor, etherToWei(0.5));
      });

      it("should unlock with approval on contract disbursal", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // change disbursal pool
        await lockedAccount.setPenaltyDisbursal(testDisbursal.address, {
          from: admin,
        });
        const unlockTx = await unlockWithApprove(investor, neumarks);
        // check if disbursal pool logged transfer
        const penalty = await calculateUnlockPenalty(ticket);
        await assertCorrectUnlock(unlockTx, investor, ticket, penalty);
        await expectPenaltyEvent(unlockTx, investor, penalty);
        expectUnlockEvent(unlockTx, investor, ticket.sub(penalty), neumarks);
        await makeWithdraw(investor, ticket.sub(penalty));
      });

      it("should unlock two investors both with penalty", async () => {
        const ticket1 = etherToWei(1);
        const ticket2 = etherToWei(0.6210939884);
        const neumarks1 = await lock(investor, ticket1);
        const neumarks2 = await lock(investor2, ticket2);
        await enableUnlocks();
        let unlockTx = await unlockWithApprove(investor, neumarks1);
        const penalty1 = await calculateUnlockPenalty(ticket1);
        await expectPenaltyEvent(unlockTx, investor, penalty1);
        await expectPenaltyBalance(penalty1);
        expectUnlockEvent(unlockTx, investor, ticket1.sub(penalty1), neumarks1);
        expect(await neumark.balanceOf(investor2)).to.be.bignumber.eq(neumarks2);
        expect(await neumark.totalSupply()).to.be.bignumber.eq(neumarks2);
        expect(await assetToken.balanceOf(lockedAccount.address)).to.be.bignumber.eq(ticket2);
        expect(await assetToken.totalSupply()).to.be.bignumber.eq(ticket1.add(ticket2));

        unlockTx = await unlockWithApprove(investor2, neumarks2);
        const penalty2 = await calculateUnlockPenalty(ticket2);
        await expectPenaltyEvent(unlockTx, investor2, penalty2);
        await expectPenaltyBalance(penalty1.add(penalty2));
        expectUnlockEvent(unlockTx, investor2, ticket2.sub(penalty2), neumarks2);
      });

      it("should reject unlock with approval on contract disbursal that has receiveApproval not implemented", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // change disbursal pool to contract without receiveApproval, comment line below for test to fail
        await lockedAccount.setPenaltyDisbursal(noCallbackContract.address, {
          from: admin,
        });
        const tx = await neumark.approve(lockedAccount.address, neumarks, {
          from: investor,
        });
        expect(eventValue(tx, "Approval", "amount")).to.be.bignumber.equal(neumarks);
        await expect(lockedAccount.unlock({ from: investor })).to.be.rejectedWith(EvmError);
      });

      it("should unlock with approval on simple address disbursal", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        const unlockTx = await unlockWithApprove(investor, neumarks);
        const penalty = await calculateUnlockPenalty(ticket);
        await assertCorrectUnlock(unlockTx, investor, ticket, penalty);
        await expectPenaltyEvent(unlockTx, investor, penalty);
        expectUnlockEvent(unlockTx, investor, ticket.sub(penalty), neumarks);
        await makeWithdraw(investor, ticket.sub(penalty));
      });

      it("should unlock with approveAndCall on simple address disbursal", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        const unlockTx = await unlockWithCallback(investor, neumarks);
        const penalty = await calculateUnlockPenalty(ticket);
        await assertCorrectUnlock(unlockTx, investor, ticket, penalty);
        // truffle will not return events that are not in ABI of called contract so line below uncommented
        // await expectPenaltyEvent(unlockTx, investor, penalty, disbursalPool);
        // look for correct amount of burned neumarks
        expectNeumarksBurnedEvent(unlockTx, lockedAccount.address, ticket, neumarks);
        await makeWithdraw(investor, ticket.sub(penalty));
      });

      it("should unlock with approveAndCall on real FeeDisbursal", async () => {
        const ticket = etherToWei(1);
        const isEuroLock = (await assetToken.symbol()) === "EUR-T";
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // deploy universe and others
        const [universe, newAP] = await deployUniverse(admin, admin);
        await deployPlatformTerms(universe, admin);
        // add NEU
        await universe.setSingleton(knownInterfaces.neumark, neumark.address, { from: admin });
        // add icbm locks to singletons
        if (isEuroLock) {
          await universe.setManySingletons(
            [knownInterfaces.icbmEuroLock, knownInterfaces.icbmEuroToken],
            [lockedAccount.address, assetToken.address],
            { from: admin },
          );
        } else {
          await universe.setManySingletons(
            [knownInterfaces.icbmEtherLock, knownInterfaces.icbmEtherToken],
            [lockedAccount.address, assetToken.address],
            { from: admin },
          );
        }
        // change to new FeeDisbursal
        const [feeDisbursal] = await deployFeeDisbursalUniverse(universe, admin);
        let convertedToken;
        if (isEuroLock) {
          [convertedToken] = await deployEuroTokenUniverse(
            universe,
            admin,
            admin,
            admin,
            0,
            0,
            Q18,
          );
          await assetToken.setAllowedTransferTo(feeDisbursal.address, true, { from: admin });
          await assetToken.setAllowedTransferFrom(feeDisbursal.address, true, { from: admin });
          await newAP.setUserRole(
            feeDisbursal.address,
            roles.eurtDepositManager,
            convertedToken.address,
            TriState.Allow,
          );
        } else {
          convertedToken = await deployEtherTokenUniverse(universe, admin);
        }

        // all neu will be burned so give neu to someone else so we can distribute
        await neumark.issueForEuro(Q18, { from: admin });
        // set new penalty disbursal
        await lockedAccount.setPenaltyDisbursal(feeDisbursal.address, {
          from: admin,
        });
        // this will pay out
        await neumark.approveAndCall(lockedAccount.address, neumarks, "", {
          from: investor,
        });
        const penalty = await calculateUnlockPenalty(ticket);
        // old payment token was converted to a new one inside FeeDisbursal contract
        expect(await convertedToken.balanceOf(feeDisbursal.address)).to.be.bignumber.eq(penalty);
      });

      it("should silently exit on unlock of non-existing investor", async () => {
        await enableUnlocks();
        const unlockTx = await unlockWithCallback(investor, new web3.BigNumber(1));
        const events = unlockTx.logs.filter(e => e.event === "LogFundsUnlocked");
        expect(events).to.be.empty;
      });

      it("should reject unlock with approveAndCall with unknown token", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        await unlockWithCallbackUnknownToken(investor, neumarks);
      });

      it("should allow unlock when neumark allowance and balance is too high", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        const neumarks2 = await lock(investor2, ticket);
        await enableUnlocks();
        // simulate trade
        const tradedAmount = neumarks2.mul(0.71389012).round(0);
        await neumark.transfer(investor, tradedAmount, {
          from: investor2,
        });
        neumark.approveAndCall(lockedAccount.address, neumarks.add(tradedAmount), "", {
          from: investor,
        });
        // should keep traded amount
        expect(await neumark.balanceOf(investor)).to.be.bignumber.eq(tradedAmount);
      });

      it("should reject approveAndCall unlock when neumark allowance too low", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // change to mul(0) for test to fail
        const tradedAmount = neumarks.mul(0.71389012).round(0);
        await neumark.transfer(investor2, tradedAmount, {
          from: investor,
        });
        await expect(
          neumark.approveAndCall(lockedAccount.address, neumarks.sub(tradedAmount), "", {
            from: investor,
          }),
        ).to.be.rejectedWith(EvmError);
      });

      it("should reject unlock when neumark allowance too low", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // allow 1/3 amount
        await neumark.approve(lockedAccount.address, neumarks.mul(0.3), {
          from: investor,
        });
        await expect(lockedAccount.unlock({ from: investor })).to.be.rejectedWith(EvmError);
      });

      it("should reject unlock when neumark balance too low but allowance OK", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        // simulate trade
        const tradedAmount = neumarks.mul(0.71389012).round(0);
        await neumark.transfer(investor2, tradedAmount, {
          from: investor,
        });
        // allow full amount
        await neumark.approve(lockedAccount.address, neumarks, {
          from: investor,
        });
        await expect(lockedAccount.unlock({ from: investor })).to.be.rejectedWith(EvmError);
      });

      it("should unlock after unlock date without penalty", async () => {
        const ticket = etherToWei(1);
        const neumarks = await lock(investor, ticket);
        await enableUnlocks();
        const investorBalance = await lockedAccount.balanceOf(investor);
        // forward time to unlock date
        await setTimeTo(investorBalance[2]);
        const unlockTx = await unlockWithApprove(investor, neumarks);
        await assertCorrectUnlock(unlockTx, investor, ticket, 0);
        expectUnlockEvent(unlockTx, investor, ticket, neumarks);
        await makeWithdraw(investor, ticket);
        await expectPenaltyBalance(0);
      });

      it("should unlock two investors both without penalty", async () => {
        const ticket1 = etherToWei(4.18781092183);
        const ticket2 = etherToWei(0.46210939884);
        const neumarks1 = await lock(investor, ticket1);
        // day later
        await increaseTime(moment.duration(dayInSeconds, "s"));
        const neumarks2 = await lock(investor2, ticket2);
        await enableUnlocks();
        // forward to investor1 unlock date
        const investorBalance = await lockedAccount.balanceOf(investor);
        await setTimeTo(investorBalance[2]);
        let unlockTx = await unlockWithApprove(investor, neumarks1);
        expectUnlockEvent(unlockTx, investor, ticket1, neumarks1);
        await makeWithdraw(investor, ticket1);

        const investor2Balance = await lockedAccount.balanceOf(investor2);
        await setTimeTo(investor2Balance[2]);
        unlockTx = await unlockWithApprove(investor2, neumarks2);
        expectUnlockEvent(unlockTx, investor2, ticket2, neumarks2);
        await makeWithdraw(investor2, ticket2);
        await expectPenaltyBalance(0);
      });

      it("should unlock two investors one with penalty, second without penalty", async () => {
        const ticket1 = etherToWei(9.18781092183);
        const ticket2 = etherToWei(0.06210939884);
        const neumarks1 = await lock(investor, ticket1);
        // day later
        await increaseTime(moment.duration(dayInSeconds, "s"));
        const neumarks2 = await lock(investor2, ticket2);
        await enableUnlocks();
        // forward to investor1 unlock date
        const investorBalance = await lockedAccount.balanceOf(investor);
        await setTimeTo(investorBalance[2]);
        let unlockTx = await unlockWithApprove(investor, neumarks1);
        expectUnlockEvent(unlockTx, investor, ticket1, neumarks1);
        await makeWithdraw(investor, ticket1);

        const investor2Balance = await lockedAccount.balanceOf(investor2);
        // 10 seconds before unlock date should produce penalty
        await setTimeTo(investor2Balance[2] - 10);
        unlockTx = await unlockWithApprove(investor2, neumarks2);
        const penalty2 = await calculateUnlockPenalty(ticket2);
        await expectPenaltyEvent(unlockTx, investor2, penalty2);
        await expectPenaltyBalance(penalty2);
        expectUnlockEvent(unlockTx, investor2, ticket2.sub(penalty2), neumarks2);
        await makeWithdraw(investor2, ticket2.sub(penalty2));
      });

      it("should unlock without burning neumarks on release all", async () => {
        const ticket1 = etherToWei(9.18781092183);
        const ticket2 = etherToWei(0.06210939884);
        const neumarks1 = await lock(investor, ticket1);
        // day later
        await increaseTime(moment.duration(dayInSeconds, "s"));
        const neumarks2 = await lock(investor2, ticket2);
        await increaseTime(moment.duration(dayInSeconds, "s"));
        // controller says no
        await controller.fail();
        // forward to investor1 unlock date
        let unlockTx = await lockedAccount.unlock({ from: investor });
        expectUnlockEvent(unlockTx, investor, ticket1, 0);
        // keeps neumarks
        expect(await neumark.balanceOf(investor)).to.be.bignumber.eq(neumarks1);
        await makeWithdraw(investor, ticket1);

        unlockTx = await lockedAccount.unlock({ from: investor2 });
        expectUnlockEvent(unlockTx, investor2, ticket2, 0);
        // keeps neumarks
        expect(await neumark.balanceOf(investor2)).to.be.bignumber.eq(neumarks2);
        await makeWithdraw(investor2, ticket2);
      });

      it("should reject unlock if disbursal pool is not set");

      it("should reject to reclaim assetToken", async () => {
        const ticket1 = etherToWei(9.18781092183);
        await lock(investor, ticket1);
        // send assetToken to locked account
        const shouldBeReclaimedDeposit = etherToWei(0.028319821);
        await makeDeposit(investor2, lockedAccount.address, shouldBeReclaimedDeposit);
        // should reclaim
        await allowToReclaim(admin);
        // replace assetToken with neumark for this test to fail
        await expect(
          lockedAccount.reclaim(assetToken.address, {
            from: admin,
          }),
        ).to.be.rejectedWith(EvmError);
      });

      it("should reclaim neumarks", async () => {
        const ticket1 = etherToWei(9.18781092183).add(1);
        const neumarks1 = await lock(investor, ticket1);
        await enableUnlocks();
        await neumark.transfer(lockedAccount.address, neumarks1, {
          from: investor,
        });
        await allowToReclaim(admin);
        await lockedAccount.reclaim(neumark.address, { from: admin });
        expect(await neumark.balanceOf(admin)).to.be.bignumber.eq(neumarks1);
      });

      it("should reclaim ether", async () => {
        const RECLAIM_ETHER = "0x0";
        const amount = etherToWei(1);
        await forceEther(lockedAccount.address, amount, investor);
        await allowToReclaim(admin);
        const adminEthBalance = await promisify(web3.eth.getBalance)(admin);
        const tx = await lockedAccount.reclaim(RECLAIM_ETHER, {
          from: admin,
          gasPrice,
        });
        const gasCost = gasPrice.mul(tx.receipt.gasUsed);
        const adminEthAfterBalance = await promisify(web3.eth.getBalance)(admin);
        expect(adminEthAfterBalance).to.be.bignumber.eq(adminEthBalance.add(amount).sub(gasCost));
      });

      describe("should reject on invalid state", () => {
        const PublicFunctionsRejectInState = {
          lock: [LockState.Uncontrolled, LockState.AcceptingUnlocks, LockState.ReleaseAll],
          unlock: [LockState.Uncontrolled, LockState.AcceptingLocks],
          receiveApproval: [LockState.Uncontrolled, LockState.AcceptingLocks],
          controllerFailed: [
            LockState.Uncontrolled,
            LockState.AcceptingUnlocks,
            LockState.ReleaseAll,
          ],
          controllerSucceeded: [
            LockState.Uncontrolled,
            LockState.AcceptingUnlocks,
            LockState.ReleaseAll,
          ],
          enableMigration: [LockState.Uncontrolled],
          setController: [LockState.Uncontrolled, LockState.AcceptingUnlocks, LockState.ReleaseAll],
          setPenaltyDisbursal: [],
          reclaim: [],
        };

        Object.keys(PublicFunctionsRejectInState).forEach(name => {
          PublicFunctionsRejectInState[name].forEach(state => {
            it(`when ${name} in ${getKeyByValue(LockState, state)}`);
          });
        });
      });

      describe("should reject on non admin access to", () => {
        const PublicFunctionsAdminOnly = [
          "enableMigration",
          "setController",
          "setPenaltyDisbursal",
        ];
        PublicFunctionsAdminOnly.forEach(name => {
          it(`${name}`, async () => {
            let pendingTx;
            migrationTarget = await deployMigrationTarget(assetToken, operatorWallet);
            switch (name) {
              case "enableMigration":
                await migrationTarget.setMigrationSource(lockedAccount.address, {
                  from: admin,
                });
                pendingTx = lockedAccount.enableMigration(migrationTarget.address, {
                  from: investor,
                });
                break;
              case "setController":
                pendingTx = lockedAccount.setController(admin, {
                  from: investor,
                });
                break;
              case "setPenaltyDisbursal":
                pendingTx = lockedAccount.setPenaltyDisbursal(testDisbursal.address, {
                  from: investor,
                });
                break;
              default:
                throw new Error(`${name} is unknown method`);
            }
            await expect(pendingTx).to.be.rejectedWith(EvmError);
          });
        });
      });

      describe("should reject access from not a controller to", () => {
        const PublicFunctionsControllerOnly = ["lock", "controllerFailed", "controllerSucceeded"];
        PublicFunctionsControllerOnly.forEach(name => {
          it(`${name}`, async () => {
            let pendingTx;
            [lockedAccount, controller] = await deployICBMLockedAccount(
              accessPolicy,
              neumark,
              admin,
              assetToken,
              operatorWallet,
              LOCK_PERIOD,
              UNLOCK_PENALTY_FRACTION,
              { leaveUnlocked: true },
            );
            await deployAuxiliaryContracts();
            switch (name) {
              case "lock":
                pendingTx = lock(investor, Q18);
                break;
              case "controllerFailed":
                await lockedAccount.setController(admin, { from: admin });
                pendingTx = lockedAccount.controllerFailed({ from: investor });
                break;
              case "controllerSucceeded":
                await lockedAccount.setController(admin, { from: admin });
                pendingTx = lockedAccount.controllerSucceeded({
                  from: investor,
                });
                break;
              default:
                throw new Error(`${name} is unknown method`);
            }
            await expect(pendingTx).to.be.rejectedWith(EvmError);
          });
        });
      });
    }

    async function deployAuxiliaryContracts() {
      noCallbackContract = await TestNullContract.new();
      testDisbursal = await TestFeeDistributionPool.new();
      startTimestamp = await latestTimestamp();
    }

    async function deployMigrationTarget(token, feeDisbursalAddress) {
      const target = await TestICBMLockedAccountMigrationTarget.new(
        accessPolicy.address,
        token.address,
        neumark.address,
        feeDisbursalAddress,
        18 * monthInSeconds,
        etherToWei(1)
          .mul(0.1)
          .round(),
      );
      await accessPolicy.setUserRole(admin, roles.lockedAccountAdmin, target.address, 1);

      return target;
    }
  },
);
