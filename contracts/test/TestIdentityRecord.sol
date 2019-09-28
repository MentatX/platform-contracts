pragma solidity 0.4.26;

import "../Identity/IIdentityRegistry.sol";


contract TestIdentityRecord is IdentityRecord {

    ////////////////////////
    // Public functions
    ////////////////////////

    function getIdentityRecord(bytes32 claims) public pure returns (bool[6] deserializedClaims){
        IdentityClaims memory ds = deserializeClaims(claims);
        assembly {
            deserializedClaims := ds
        }
    }
}
