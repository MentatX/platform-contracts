pragma solidity 0.4.26;


/// @notice implemented in the contract that is the target of state migration
/// @dev implementation must provide actual function that will be called by source to migrate state
contract IMigrationTarget {

    ////////////////////////
    // Public functions
    ////////////////////////

    // should return migration source address
    function currentMigrationSource()
        public
        constant
        returns (address);
}
