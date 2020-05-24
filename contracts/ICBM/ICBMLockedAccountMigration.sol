pragma solidity 0.4.26;

import "./MigrationTarget.sol";


/// @notice implemented in the contract that is the target of LockedAccount migration
///  migration process is removing investors balance from source LockedAccount fully
///  target should re-create investor with the same balance, totalLockedAmount and totalInvestors are invariant during migration
contract ICBMLockedAccountMigration is
    MigrationTarget
{
    ////////////////////////
    // Public functions
    ////////////////////////

    // implemented in migration target, apply `onlyMigrationSource()` modifier, modifiers are not inherited
    function migrateInvestor(
        address investor,
        uint256 balance,
        uint256 neumarksDue,
        uint256 unlockDate
    )
        public;

}
